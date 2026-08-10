/**
 * Talking to the tmux session running inside a panel's shell.
 *
 * The panel used to do the opposite of this: detect tmux and stand down, on the
 * grounds that tmux owns the tabs. It does own them, and that left the one strip
 * of the workspace we do not control being drawn by whatever `.tmux.conf` the
 * machine happens to carry — the same user, on two laptops, gets two different
 * looking window lists pasted across an otherwise coherent panel.
 *
 * So: we draw, tmux decides. Everything here either asks tmux what it has or
 * asks it to do something a keybinding could already have done. No state is kept
 * about which window is active, no input is intercepted, and every keybinding
 * behaves exactly as it did before, because the shell still receives every byte.
 * A click on a tab is `select-window` and nothing more.
 *
 * Linux-only, like the detection it grew out of: it reads /proc to find the tmux
 * client and the terminal it is attached to. Anywhere else this reports nothing
 * and the panel keeps its own chrome, which is the correct fallback rather than
 * a degraded one.
 */
import { readFileSync, readlinkSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, statSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import type { TmuxWindow, TmuxPane, AgentPane } from "../../shared/types.ts";
import { parsePanes, PANE_FORMAT } from "./paneloc.ts";
import { findTmuxBelow } from "./procchildren.ts";
import { recall } from "./tmuxmemory.ts";

/** How long a tmux call may take before we give up on it. Generous for a local
 *  socket, and short enough that a wedged tmux server cannot stall the poll. */
const TMUX_TIMEOUT_MS = 2000;

/**
 * The tmux client itself: everything about it that /proc knows and tmux does
 * not need to be asked about.
 *
 * Held separately from the session because they change on different clocks. A
 * client lives as long as the shell has tmux in it; the session it is *showing*
 * can change underneath it at any moment, and does — `^b s`, `^b (`, and every
 * tmux-continuum restore, which attaches you to a scratch session and then
 * switches you to the restored one before you have finished blinking.
 */
export interface TmuxClient {
  /** The tmux client process inside our shell. */
  pid: number;
  /** `-S <path>` / `-L <name>` as the client itself was invoked, so we reach the
   *  same server rather than the default one. Empty for the default socket. */
  socket: string[];
  /** The terminal it is attached to, which is how tmux names it back to us. */
  tty: string;
}

export interface TmuxTarget {
  /** The tmux client process inside our shell. */
  pid: number;
  /** `-S <path>` / `-L <name>` as the client itself was invoked, so we reach the
   *  same server rather than the default one. Empty for the default socket. */
  socket: string[];
  /** The session that client is attached to *right now*, for display. */
  session: string;
  /** tmux's own id for it (`$0`), which is what every command below targets.
   *  Names are matched by prefix unless you fight the syntax for it, and even
   *  then `set-option -t =name` is rejected outright by tmux 3.7 while
   *  `list-windows -t =name` accepts it. An id is unambiguous everywhere and
   *  survives a rename, so there is nothing to get subtly wrong. */
  id: string;
}

/**
 * The tmux client running under this shell, if there is one.
 *
 * Walks the process tree rather than asking the shell: the shell is busy being
 * a terminal, and injecting a command to interrogate it would echo into whatever
 * the user is halfway through typing. `tmux: client` and `tmux: server` both
 * report as `tmux` in comm, but the server is a daemon and never a child of our
 * shell, so anything found here is a client.
 *
 * Portable since the dispatch audit. It used to open with
 * `process.platform !== "linux"`, which made this null on every Mac — right for
 * the caller that asks "should the panel hide its own tab strip", and wrong for
 * the one that asks "may I send this pull request to an agent", which silently
 * dropped the request instead. See procchildren.ts.
 */
export function tmuxClientPid(pid: number, depth = 0): number | null {
  return findTmuxBelow(pid, depth);
}

/** The terminal a process is attached to, as tmux reports it in `client_tty`. */
function ttyOf(pid: number): string | null {
  for (const fd of [0, 1, 2]) {
    try {
      const link = readlinkSync(`/proc/${pid}/fd/${fd}`);
      if (link.startsWith("/dev/pts/") || link.startsWith("/dev/tty")) return link;
    } catch { /* fd closed or redirected — try the next one */ }
  }
  return null;
}

/**
 * Which socket this client is talking to.
 *
 * A user with `-L work` or `-S /run/user/1000/tmux` is on a different server
 * from the default one, and asking the default server about their windows
 * answers confidently about somebody else's session. Read it off the client's
 * own command line, which is the only place that is certain to be right.
 */
export function socketFromArgv(argv: string[]): string[] {
  for (let i = 1; i < argv.length - 1; i++) {
    if (argv[i] === "-S" || argv[i] === "-L") return [argv[i]!, argv[i + 1]!];
  }
  return [];
}

function socketOf(pid: number): string[] {
  try {
    return socketFromArgv(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean));
  } catch { return []; }
}

/**
 * Run a tmux command against a specific server. stdout only; a failure is a
 * null, never a throw, because every caller is inside a poll.
 *
 * With a locale, because every format in this file separates its fields with a
 * tab and tmux will not hand one back to a process that has none. Measured:
 * `list-panes -F "#{pane_active}\t#{pane_id}"` returns `1\t%0` from a normal
 * shell and `1_%0` under `env -i` — tmux sanitises what it cannot call
 * printable in the current locale, and the C locale is that. Nothing crashes;
 * every line simply becomes one field that no `split("\t")` can take apart, so
 * the tab strip empties and the machine reports no agents. Which environment
 * the server gets is not up to it — a desktop launcher hands over a full one, a
 * systemd unit or a test harness hands over almost nothing — so the answer must
 * not depend on that. An existing setting is kept: this is a floor, not a
 * preference.
 */
function tmux(socket: string[], args: string[]): string | null {
  /*
   * The backstop, at the one place every tmux command in this file goes
   * through: under `bun test` with no TMUX_TMPDIR, the DEFAULT socket is not
   * reachable at all.
   *
   * The other two guards cover discovery (`tmuxSockets`) and the sweep. This
   * covers the path neither can see — a `TmuxTarget` whose socket came from `socketOf()`, i.e.
   * from the command line of a tmux client in /proc. An empty socket array is
   * exactly what a developer's plain `tmux` (no `-S`, no `-L`) resolves to, so
   * `setStatusLine`, `fitWindow` and `restoreWindows` could each be pointed at
   * his live server by a test that resolved the wrong pid.
   *
   * Narrowed to the default socket rather than the whole directory, because
   * four suites deliberately run their own server as `-L agx-<something>` in
   * that same directory (tmux-bar, tmux-tabs, tmux-stale, pane-routes) and
   * those are theirs to touch. `default` is the one nothing in this repo ever
   * creates and the one his sessions are on — measured: /tmp/tmux-1000/default
   * held five sessions somebody was working in.
   *
   * The rule itself lives in `tmuxSocketAllowed`, where a test can ask it
   * without a tmux command having to be issued to find out. See the note there
   * for why that distinction is not cosmetic.
   */
  if (!tmuxSocketAllowed(socket)) return null;
  /*
   * And the same door for a process that is NOT under `bun test`, which the
   * guard above cannot help with: its first line is `if (process.env.NODE_ENV
   * !== "test") return true`.
   *
   * `tmuxSocketConfined` asks a question NODE_ENV has no part in — was this
   * process handed a private TMUX_TMPDIR, and is this socket inside it — so it
   * holds for the six scripts in `scripts/` that spawn this server, for a
   * seventh nobody has written, and for any launcher that names one. Refusing
   * here rather than only at the sweep is what makes it worth having: the sweep
   * was never the only way out. `loadtest.ts` hits `/panes` and every other
   * endpoint, and those call `tmuxSockets()` + `listPanes()` — read-only, and
   * still 25 of his servers answering a stranger.
   *
   * This is the extension the note on `tmuxSocketConfined` called "the obvious
   * next change", now that something depends on it. Free in production: nothing
   * in `server/src` or `desktop/` sets TMUX_TMPDIR, so `usableTmuxTmpdir()` is
   * null there and this answers true before any path work.
   *
   * WHO IT COSTS, stated rather than left to be discovered: a user who exports
   * TMUX_TMPDIR in their shell AND runs a server outside it — `tmux -S
   * /run/user/1000/tmux` — loses the tab strip on that server, because
   * `socketFromArgv` reads that `-S` off their client and this then refuses it.
   * Nothing else changes for them, it is one `-S` away from working, and the
   * alternative is a rule that can be unset by the process it is meant to
   * confine.
   */
  if (!tmuxSocketConfined(socket)) return null;
  try {
    const r = Bun.spawnSync(["tmux", ...socket, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: TMUX_TIMEOUT_MS,
      env: process.env.LC_ALL || process.env.LANG || process.env.LC_CTYPE
        ? process.env
        : { ...process.env, LC_ALL: "C.UTF-8" },
    });
    if (r.exitCode !== 0) return null;
    return r.stdout.toString();
  } catch { return null; }
}

/**
 * The tmux client under this shell, and how to reach its server.
 *
 * Only the /proc half. Which session it is showing is deliberately not part of
 * this: that answer goes stale, and an interface that hands both back at once
 * invites a caller to cache the pair, which is the bug this shape exists to
 * prevent.
 */
export function resolveClient(shellPid: number): TmuxClient | null {
  const pid = tmuxClientPid(shellPid);
  if (!pid) return null;
  const tty = ttyOf(pid);
  if (!tty) return null;
  return { pid, socket: socketOf(pid), tty };
}

/** tmux window ids are `@` and digits, and nothing a client sends is trusted to
 *  be one without being checked: these go on a command line. */
const WINDOW_ID = /^@\d+$/;

/**
 * The session's windows, in tmux's own order.
 *
 * `window_flags` carries tmux's own marks (`*` current, `-` last, `!` bell,
 * `#` activity, `Z` zoomed). They are passed through rather than interpreted
 * here: the panel decides what to show, and tmux stays the single source of
 * truth for what is true.
 */
export function parseWindows(out: string): TmuxWindow[] {
  const windows: TmuxWindow[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    // Tab-separated, because window names routinely contain spaces and a
    // space-separated format would split "npm run dev" into three windows.
    const [id, index, name, active, flags, ask, width, height] = line.split("\t");
    const i = Number(index);
    if (!WINDOW_ID.test(id ?? "") || !Number.isInteger(i)) continue;
    const asked = (ask ?? "").trim();
    const cols = Number(width), rows = Number(height);
    windows.push({
      id: id!, index: i, name: name ?? "", active: active === "1", flags: (flags ?? "").trim(),
      // Anything else in the option is someone else's, or ours from a version
      // that meant something different by it. Ignored rather than forwarded.
      ...(asked === "rename" || asked === "move" ? { ask: asked } : {}),
      // Omitted rather than zeroed when the line carries no geometry — see the
      // note on TmuxWindow.cols. A window that answers 0 columns would look
      // narrower than every client and put a "your phone is holding this
      // narrow" notice on a window nothing has touched.
      ...(Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 ? { cols, rows } : {}),
    });
  }
  return windows;
}

export interface TmuxFrame {
  target: TmuxTarget;
  windows: TmuxWindow[];
  /** The panes of the ACTIVE window only — the one the client is drawing, and
   *  so the only one whose geometry matches what is on screen. */
  panes: TmuxPane[];
  /**
   * How big OUR client's terminal is, as tmux sees it.
   *
   * The other half of the comparison the windows carry: a window is only being
   * held narrow if it is narrower than the terminal looking at it. Read off the
   * `c` line the frame already matches by tty rather than from our own pty
   * size, because tmux is the one that decides — and it is what the desk's
   * notice quotes back ("80 columns while your terminal is 220").
   *
   * Null when tmux answered without one, never a guess.
   */
  client: { cols: number; rows: number } | null;
  /**
   * Whether the session this client is on is drawing its status line right
   * now — tmux's own effective answer, and the only thing that decides if
   * the original bar is on screen.
   *
   * Everything that can put the bar back when the panel chose its own strip
   * lands here: a `set status on` typed through the command prompt, a
   * plugin's bare `set status …`, a config line without `-g`, a client moved
   * onto a session that never had `status off`. The sweep reads these two
   * fields in the call it already makes for the windows, and re-asserts from
   * them, so a flip heals within a tick instead of sticking until the
   * session changes.
   */
  status: string;
  /** `@agx-owned` on that session: this app took its bar (and its prompt
   *  keys) over, and still holds the claim. `releaseStale` sweeps the
   *  sessions where the claim survived the process that made it. */
  owned: boolean;
  /** pane id -> window id for every pane of this session. Server-internal, off
   *  the wire: it exists so the sweep can tell which window a finished agent's
   *  pane belongs to. */
  windowOfPane: Map<string, string>;
}

/**
 * Which session this client is on, and what is in it — asked together, every
 * time.
 *
 * The join is the terminal: our pty is that client's controlling tty, and tmux
 * names it back to us in `client_tty`. Guessing instead — taking the most recent
 * session, say — is wrong the moment a user has two sessions open, which is the
 * normal case for the people who use tmux at all.
 *
 * The session has to be re-read rather than resolved once and kept, because a
 * client outlives the session it is showing. `^b s` moves it. So does
 * tmux-continuum's restore, which is worse than a move: it attaches you to a
 * scratch session, restores the saved ones, switches you across and kills the
 * scratch one behind you. A target cached at attach time then names a session
 * that no longer exists, `list-windows` answers nothing, and the tab strip
 * silently empties out while tmux carries on drawing its own status line
 * underneath — which is exactly what it did.
 *
 * One tmux invocation for both halves: `list-clients` cannot tell us the windows
 * and `list-windows` cannot tell us the client, but tmux takes a command list,
 * so this costs the same one spawn per poll the old single-session read did. The
 * lines are tagged because they come back concatenated.
 */
export function readFrame(c: TmuxClient): TmuxFrame | null {
  const out = tmux(c.socket, [
    // The client's own grid, two fields further along a line that was already
    // being asked for. Same argument as `@agx-ask` below: the size of a window
    // against the size of the terminal showing it is a comparison the desk
    // needs twice a second, and it costs nothing here and a subprocess a tick
    // anywhere else.
    //
    // `#{status}` and `#{@agx-owned}` ride along for the same reason: the
    // panel's answer to "whose bar is this" can be flipped by a keybinding,
    // and the sweep that already reads the windows is where the re-assertion
    // has to live. Both evaluate against the client's own session — measured,
    // `list-clients` answers a session-local `status off` and `@agx-owned 1`
    // for the client attached to that session and nobody else's.
    "list-clients", "-F", "c\t#{client_tty}\t#{session_name}\t#{session_id}\t#{client_width}\t#{client_height}\t#{status}\t#{@agx-owned}",
    ";",
    "list-windows", "-a",
    // `@agx-ask` rides along in the format string rather than in a second
    // call: this is polled twice a second per attached client, and a prompt
    // that costs an extra subprocess every sweep is a prompt that costs more
    // than the feature is worth.
    "-F", "w\t#{session_id}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_raw_flags}\t#{@agx-ask}\t#{window_width}\t#{window_height}",
    ";",
    // Panes ride along for the same reason `@agx-ask` does: this runs twice a
    // second per attached client, and it is already ONE subprocess with three
    // commands in it. A separate `list-panes` would have doubled the process
    // count of the sweep to answer a question the same call can.
    //
    // `-a` (every pane on the server) rather than the client's window, because
    // this call has no target — it is resolving which session the client is on
    // in its first line. Filtering happens in parseFrame, which by then knows.
    "list-panes", "-a",
    "-F", "p\t#{session_id}\t#{window_id}\t#{window_active}\t#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_right}\t#{pane_bottom}\t#{pane_active}\t#{window_zoomed_flag}",
  ]);
  if (!out) return null;
  const f = parseFrame(out, c.tty);
  return f ? { target: { pid: c.pid, socket: c.socket, session: f.session, id: f.id }, windows: f.windows, panes: f.panes, client: f.client, status: f.status, owned: f.owned, windowOfPane: f.windowOfPane } : null;
}

/**
 * Pick our client's session out of the server's answer, and its windows out of
 * every session's windows.
 *
 * Windows are filtered by session id and not by anything friendlier: session
 * *names* are not unique enough to bet a `kill-window` on — resurrect happily
 * restores a second session called `main` — and the id is what tmux itself uses.
 */
export function parseFrame(out: string, tty: string): { session: string; id: string; client: { cols: number; rows: number } | null; status: string; owned: boolean; windows: TmuxWindow[]; panes: TmuxPane[]; windowOfPane: Map<string, string> } | null {
  let session: string | null = null;
  let id: string | null = null;
  let client: { cols: number; rows: number } | null = null;
  let status = "";
  let owned = false;
  const windowRows: string[] = [];
  const paneRows: string[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("c\t")) {
      const [, clientTty, name, sid, width, height, st, own] = line.split("\t");
      if (clientTty === tty && name && sid) {
        session = name; id = sid;
        // Only ours. Every other client on this server is on the same list and
        // some of them are phones: taking the first line's size would compare a
        // window against the size of whoever is squeezing it.
        const cols = Number(width), rows = Number(height);
        client = Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 ? { cols, rows } : null;
        status = (st ?? "").trim();
        owned = (own ?? "").trim() === "1";
      }
    } else if (line.startsWith("w\t")) {
      windowRows.push(line);
    } else if (line.startsWith("p\t")) {
      paneRows.push(line);
    }
  }
  if (!session || !id) return null;
  const mine = windowRows
    .filter((r) => r.startsWith(`w\t${id}\t`))
    // Drop the tag and the session id; what is left is what parseWindows reads.
    .map((r) => r.split("\t").slice(2).join("\t"));
  // pane id -> window id for EVERY pane of this session, not just the active
  // window's (which is all `panes` carries). The enrichment that lights the
  // "agent finished" dot needs to know which window a finished agent's pane is
  // in, and this is built from rows list-panes already returned — no extra call.
  const windowOfPane = new Map<string, string>();
  for (const row of paneRows) {
    const [tag, sid, winId, , paneId] = row.split("\t");
    if (tag !== "p" || sid !== id || !winId || !paneId || !PANE_ID.test(paneId)) continue;
    windowOfPane.set(paneId, winId);
  }
  return { session, id, client, status, owned, windows: parseWindows(mine.join("\n")), panes: parsePaneGeometry(paneRows, id), windowOfPane };
}

/**
 * The active window's panes, for the session the client is on.
 *
 * Both filters matter and for different reasons. The session, because `-a`
 * returned every pane on the server and acting on another session's pane id is
 * how you move a window somebody else is looking at. The window, because only
 * the active one is being DRAWN — a pane in a background window has real
 * geometry that corresponds to nothing on screen, and hovering a cell would
 * match it.
 *
 * A row that does not parse is dropped rather than guessed at: a pane with
 * NaN bounds would silently claim cells, and this decides where keystrokes go.
 */
export function parsePaneGeometry(rows: string[], sessionId: string): TmuxPane[] {
  const out: TmuxPane[] = [];
  for (const row of rows) {
    const [tag, sid, , winActive, paneId, left, top, right, bottom, active, zoomed] = row.split("\t");
    if (tag !== "p" || sid !== sessionId || winActive !== "1") continue;
    if (!paneId || !PANE_ID.test(paneId)) continue;
    const n = [left, top, right, bottom].map((v) => Number(v));
    if (n.some((v) => !Number.isInteger(v))) continue;
    out.push({
      id: paneId,
      left: n[0]!, top: n[1]!, right: n[2]!, bottom: n[3]!,
      active: active === "1",
      zoomed: zoomed === "1",
    });
  }
  return out;
}

/**
 * The keys tmux is waiting for as its prefix, as tmux spells them (`C-b`,
 * `C-f`, `M-a`), including `prefix2` when one is set.
 *
 * The panel needs this to say "tmux is listening" the instant the key is
 * pressed. That indicator used to come free: it lives in the status line most
 * configs draw, and hiding that line to make room for our tabs took it away
 * with everything else. Asking tmux which key it is beats hardcoding `C-b`,
 * because the people most likely to have rebound it are exactly the people who
 * use tmux enough to notice the indicator missing.
 *
 * Read once per attach and carried on the frame: the prefix does not change
 * while a client is up unless someone sources a config mid-session, and the
 * next attach picks that up.
 */
export function prefixKeys(t: TmuxTarget): string[] {
  const keys: string[] = [];
  for (const opt of ["prefix", "prefix2"]) {
    const v = (tmux(t.socket, ["show-options", "-gv", opt]) || "").trim();
    // "None" is how tmux says a second prefix is unset.
    if (v && v !== "None") keys.push(v);
  }
  return keys;
}

/**
 * The commands a tab strip is allowed to send.
 *
 * A closed list, and every one of them is something the user could already do
 * from the keyboard — this adds no capability, it adds a second way to reach
 * the same handful. `takeover` included: it is a `resize-window` and a
 * `set-option`, both a `prefix :` away for anyone who knows they want them, and
 * the point of the button is that nobody would. That matters because the
 * terminal is already the widest thing this server hands out, and "the panel
 * can run arbitrary tmux commands" would quietly widen it further.
 */
export type TmuxAction = "select" | "new" | "kill" | "rename" | "move" | "takeover" | "fit";

/**
 * Windows the desk has just taken its width back on.
 *
 * Here so that a phone socket closing behind the click cannot hand the window
 * straight back. The teardown in `cleanup` fires at +1500ms and +3000ms, and
 * measured on a private server: take over (window 200x49, `largest`), let the
 * phone remount without its fit, then run the teardown — `resize-window -A`
 * followed by putting the captured option back — and the window is at 80x24
 * again with the phone still attached, because the phone is the latest client
 * and the captured value is `latest`. Half a second after the user asked for
 * their columns back, they lose them, and nothing on screen says why.
 *
 * Keyed by SERVER and window: window ids are per server, so `@1` is an ordinary
 * id on every tmux on this machine — the same reason `attachArgvFor` refuses an
 * ambiguous pane id. `socketPath` normalises the spelling because the two sides
 * do not agree on one: a take-over comes through the desk's own client, whose
 * argv usually names no socket at all, while the phone's attach carries the
 * resolved `-S /tmp/tmux-1000/default`. Comparing the arrays would never match.
 */
const claimed = new Map<string, number>();
/**
 * How long a claim holds off a teardown.
 *
 * It has to cover the last of the two teardowns (+3000ms) counted from a socket
 * that only closes once the phone has acted on the frame we send it, so the
 * window is "3 seconds plus however long a phone in a pocket takes to notice".
 * Ten seconds is that with room, and it EXPIRES rather than persisting: a claim
 * left set forever would silently disable the option restore for that window,
 * which is the exact regression this change exists to fix.
 */
const CLAIM_MS = 10_000;
const claimKey = (socket: string[], windowId: string) => `${socketPath(socket)}\0${windowId}`;

/** Whether the desk took this window back recently enough that a phone's
 *  teardown must keep its hands off it. */
function deskClaimed(socket: string[], windowId: string): boolean {
  const at = claimed.get(claimKey(socket, windowId));
  if (at === undefined) return false;
  if (Date.now() - at < CLAIM_MS) return true;
  claimed.delete(claimKey(socket, windowId));
  return false;
}

/** A deliberate fit on this window ends the claim, whatever the clock says.
 *  Take-over is not a lock — it ends the reflow that is happening, and the
 *  phone asking again is the user asking again. */
function releaseClaim(socket: string[], windowId: string): void {
  claimed.delete(claimKey(socket, windowId));
}

/** Window names are echoed back into a shell prompt and a status line, so they
 *  are held to printable, single-line, and short. tmux itself is happy with far
 *  worse, which is exactly why this is checked here. */
export const sanitizeWindowName = (s: unknown): string | null => {
  if (typeof s !== "string") return null;
  const name = s.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
  return name || null;
};

export function runAction(
  t: TmuxTarget, action: TmuxAction, window?: string, name?: string,
  /** The asking client's grid. Only `fit` uses it — see that case for why an
   *  explicit size is the only honest answer to "size it to what I see". */
  cols?: number, rows?: number,
): boolean {
  // Windows are addressed by tmux's id, never by the index the tab is showing.
  // The strip is up to a poll out of date, and an index is not a name: kill
  // window 2 with `renumber-windows` on and what was 3 becomes 2, so a click
  // landing a moment later selects, renames or kills something the user was not
  // pointing at. An id refers to the same window for as long as it exists, and
  // to nothing at all once it does not.
  const id = WINDOW_ID.test(window ?? "") ? window! : null;
  switch (action) {
    case "select":
      return id === null ? false : tmux(t.socket, ["select-window", "-t", id]) !== null;
    case "new":
      // At the end, which is tmux's default and where the button is.
      //
      // This used to pass `-a` to match `^b c`, on the grounds that the two
      // should agree. They should not: they are different gestures. `^b c` is
      // "here, next to what I am doing", and it lands next to the current
      // window because that is where the hand is. A `+` at the end of a row of
      // tabs is "at the end" — you click a button on the right and the new tab
      // has to appear under it, not somewhere in the middle of the strip.
      //
      // tmux's default is the first free index, which is the end unless killing
      // a middle window left a gap. That is the same rule the unbound `c` uses,
      // so a strip that fills a gap is at least a rule the user already has.
      return tmux(t.socket, ["new-window", "-t", t.id]) !== null;
    case "kill":
      return id === null ? false : tmux(t.socket, ["kill-window", "-t", id]) !== null;
    case "rename": {
      const clean = sanitizeWindowName(name);
      if (id === null || !clean) return false;
      return tmux(t.socket, ["rename-window", "-t", id, clean]) !== null;
    }
    case "move": {
      // A destination index, and nothing else. `name` carries it because the
      // wire already has that field, but it is parsed as a number here rather
      // than passed through — `move-window -t` takes a target spec, and a
      // string from a client reaching that unchecked is a way to address
      // another session entirely.
      // Matched as digits before it is a number, because `Number("")` is 0 and
      // an empty box would otherwise mean "move it to the front" — which is a
      // real move, applied to a window whose owner typed nothing and pressed
      // Enter. `Number(" 7 ")` is 7 for the same reason: parsing is not a check.
      const raw = (name ?? "").trim();
      const to = Number(raw);
      if (id === null || !/^\d{1,3}$/.test(raw)) return false;
      // `-s` is what moves; `-t` on its own would move the *current* window.
      // Bare, not `-b`: the user named an index and that is the index they get,
      // with tmux renumbering around it exactly as `prefix .` would have.
      return tmux(t.socket, ["move-window", "-s", id, "-t", `${t.id}:${to}`]) !== null;
    }
    /*
     * Give the window back to THIS client.
     *
     * `window-size largest` is what stops a phone shrinking the desk, and it
     * has a cost nobody had named: when something BIGGER is attached — another
     * agentglass window, a plain `tmux attach` in a real terminal — the window
     * is sized to that one, and this panel shows the top-left corner of it.
     * Measured on a private server: one 80x24 client gives `window 80x23`, and
     * a 240x60 client joining takes it to `window 240x59` while the small
     * client stays 80x24. Everything below its 24th row is drawn where nobody
     * can see it — which for an editor is its status line, always on the last
     * row of the pane.
     *
     * `resize-window -A` aggregates the CURRENT client, and per tmux's own
     * manpage it also sets `window-size manual` — so the fit sticks until
     * somebody asks for something else, rather than being taken away again by
     * the next resize of the bigger client. That is exactly what is wanted
     * here: this is a person saying "size it to what I am looking at".
     */
    case "fit": {
      /*
       * An explicit size, not `-A`.
       *
       * `-A` is "the largest client viewing it", which is the very client that
       * took the window away — measured: with an 80x24 and a 240x60 attached,
       * `resize-window -A` leaves it at 59 rows. `-a` is the smallest, which
       * would hand the window to a phone instead. Neither is "the one I am
       * looking at", and that is the only thing this button means.
       *
       * So the panel's own grid, passed in and checked here. `resize-window`
       * with an explicit size also sets `window-size manual`, which is what
       * makes the fit stick rather than being taken back by the bigger
       * client's next resize.
       */
      if (id === null) return false;
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols! < 20 || rows! < 5 || cols! > 1000 || rows! > 500) return false;
      unzoomWindow(t.socket, t.id, id);
      /*
       * Session-qualified, never a bare `@id` — the same target `fitWindow`
       * uses, and for the same measured reason: `resize-window -t @0` answers
       * "no such window" once a grouped session shares that window, and fails
       * SILENTLY as far as the size is concerned. A bigger client sharing the
       * desk's window is exactly the state this fit is FOR — a phone's grouped
       * session, or a second agentglass window — so a bare id makes the fit a
       * no-op in precisely the case it exists to answer, leaving the window at
       * `window-size largest` (taller than this panel) until the next resize,
       * which goes through `fitWindow` and does size-qualify, actually lands.
       * That gap read as "the fit only takes on a view-switch, never on the
       * initial one". `${t.id}` is our own session; `id` is the window id.
       */
      const ok = tmux(t.socket, ["resize-window", "-t", `${t.id}:${id}`, "-x", String(cols), "-y", String(rows)]) !== null;
      /*
       * The person at the desk has just asked for `manual` on this window, and
       * from here on it is theirs and not ours to put back.
       *
       * This is the converse the startup sweep has to get right, and it is not
       * hypothetical: this button IS how a `window-size manual` gets onto a
       * window on purpose. A phone visit an hour earlier leaves a mark; without
       * this line the next boot would find `manual` on a marked window, decide
       * it was the phone's leftover, and quietly undo the size the user chose.
       *
       * After the resize, not before: dropping the claim on a command that then
       * fails would abandon a window we may still have pinned.
       */
      if (ok) clearSizeMark(t.socket, id);
      return ok;
    }
    case "takeover": {
      /*
       * The desk asking for its columns back from a phone that is holding this
       * window at phone width — without hanging the phone up.
       *
       * Two commands, and every part of that was measured on a private server
       * (`-f /dev/null`, own socket) with a real 200x50 desk pty and a phone
       * joining on the exact argv `attachArgvFor` builds:
       *
       *   fitted phone                       80x24   window-size=manual
       *   resize-window -A                  200x49   window-size=manual
       *   ... then set-option -uw            80x24   window-size=latest
       *   ... then set-option -w largest    200x49   window-size=largest
       *
       * `-A` alone is the feature: the desk is back at 200x49 with the phone
       * still attached and still typing. It is not enough, because `-A` SETS
       * `window-size manual` itself (the manpage says so, and the probe agrees)
       * — so afterwards the desk resizing its own terminal to 160x45 left the
       * window at 200x49. One broken layout swapped for another, silently.
       *
       * Unsetting is the trap, not the fix: the inherited value is tmux's
       * default `latest`, the phone is the latest client, and the window is
       * back at 80x24 in the same breath.
       *
       * `largest` sticks and is the right amount of authority — measured, the
       * phone resizing itself to 80x30 does not win, nor does it dropping and
       * reattaching, while the desk going to 160x45 takes the window to 160x44,
       * following its own terminal again. It is not a lock: a deliberate `fit`
       * from the phone runs `resize-window -x` and sets `manual` again.
       *
       * NOT a kill of the phone's session, which was the obvious answer and is
       * wrong twice: measured, killing the phone's client left the window at
       * 80x24 (the fit is a `manual` size on the SHARED window, so the session
       * that applied it is not holding anything), and the phone's socket
       * reports `gone` and does not come back on its own — somebody mid-command
       * on the sofa would lose their session so that somebody at the desk could
       * have their columns.
       */
      if (id === null) return false;
      /*
       * The zoom comes off first, and it is not an extra: a phone opening one
       * pane of a four-pane window zooms it (see `attachArgvFor`), so the desk
       * is looking at one pane where it had four. Giving the width back and
       * leaving that is answering half the question — the window is the right
       * shape again and still has three of its panes missing.
       *
       * Before the `-A` rather than after, so the repaint the `-A` provokes is
       * of the layout the user is getting rather than of the one they are
       * losing. Best-effort by design: a window nobody zoomed answers "not
       * zoomed" and this does nothing, and a take-over must not fail because
       * of it.
       */
      unzoomWindow(t.socket, t.id, id);
      if (tmux(t.socket, ["resize-window", "-A", "-t", id]) === null) return false;
      if (tmux(t.socket, ["set-option", "-w", "-t", id, "window-size", "largest"]) === null) return false;
      claimed.set(claimKey(t.socket, id), Date.now());
      // Same handover as `fit` above, and for the same reason with a longer
      // fuse: the in-memory claim expires after ten seconds but the `largest`
      // it wrote does not, so a mark left behind would let a boot months later
      // put the phone's captured value back over the user's take-over.
      clearSizeMark(t.socket, id);
      return true;
    }
    default:
      return false;
  }
}

/** The options the panel borrows when it takes the status line over. Restored
 *  together, in the same breath, so a half-restored bar cannot outlive us. */
// Restored by unsetting. `status-format[0]` is the one we blank when borrowing,
// but `set-option -u status-format[0]` does NOT clear an array element on tmux
// 3.7 — the override lingers as "" and the bar stays invisible even after a
// restore ran. Unsetting the whole `status-format` array is what actually
// returns it to the user's config default; we only ever set index 0, so nothing
// else of theirs is lost.
const BORROWED = ["status", "status-format", "status-style"];

/**
 * Whether this user's tmux normally has a status line at all, read from the
 * *global* options rather than the session's.
 *
 * The question being answered is "does this person run tmux with a status
 * line", and the global options are where that is written — a `.tmux.conf`
 * with `set -g status off` is someone who has decided, and borrowing a row from
 * them would be the panel deciding it knows better.
 *
 * The session's own value cannot answer it, because the panel is the thing most
 * likely to have set it. Every session a previous version of this touched is
 * carrying `status off` that *we* put there, and a session left that way by a
 * server that was killed rather than closed is indistinguishable from a
 * deliberate one. Reading the session would make an old bug look like a
 * preference and quietly refuse to fix it.
 */
function statusInConfig(t: TmuxTarget): string {
  return (tmux(t.socket, ["show-options", "-gv", "status"]) || "").trim();
}

/**
 * Take tmux's status line over for this session, or give it back.
 *
 * The panel draws its own tab strip, so two window lists on screen is one too
 * many — and the answer has to be one or the other, never both, because a
 * blanked row that still takes a row is neither.
 *
 * This blanked the row rather than removing it, and the reason was real: with
 * no status row allocated, `prefix ,`, `prefix .`, `prefix :` and every
 * `display-message` are drawn over the top line of the shell, because that is
 * the row where the status line would have been. Nothing is lost — the pane's
 * content is untouched underneath and comes back when the message clears — but
 * it looks like the terminal is being scribbled on.
 *
 * The row is now removed, and the prompts are taken instead of tolerated:
 * `prefix ,` and `prefix .` are rebound to leave a note on the window
 * (`@agx-ask`), which the sweep already reading this session picks up and hands
 * to the panel, which opens its own input. Same keys, same muscle memory, a row
 * of screen back, and a rename box that matches the app it is drawn in.
 *
 * What is left is what we cannot intercept: a plugin's own `display-message`
 * still paints over the top line for its two seconds. That is the honest cost
 * of the row, and it is the one the user chose by taking the row back.
 *
 * Opt-in, and it has to be: these are session options, not client ones, so a
 * second client attached to the same session from a real terminal is affected
 * too. `set-option -u` puts each one back exactly as their config had it,
 * rather than guessing at a default.
 */
/**
 * A new window in the user's own tmux, already running something.
 *
 * Separate from `runAction`'s `new` on purpose. That one opens an empty window
 * and is driven by a button; this one opens a window with a command in it, and
 * a command is a much larger thing to hand a websocket. So `argv` is never
 * client text: the caller builds it from something the server itself resolved.
 *
 * Passed as separate arguments rather than a shell string — tmux runs a bare
 * string through the user's login shell, and this one is fish on the machine
 * where that was last discovered the hard way.
 *
 * Answers WHAT IT MADE, or null. It used to answer a boolean, and the callers
 * that ignore the value read the same either way — but a caller that has to
 * tell somebody where the window went cannot get that from the poll:
 * `/terminal/panes` is a list, and "the newest row" is whatever the desk
 * created in the same second. `-P -F` is tmux's own answer to that question,
 * asked in the command that already runs.
 */
export function newWindowRunning(
  t: TmuxTarget, cwd: string, name: string, argv: string[],
): { paneId: string; windowId: string } | null {
  const clean = sanitizeWindowName(name);
  // Tab-separated, like every other format string here: a window name can
  // contain spaces, and neither of these two fields can contain a tab.
  const out = tmux(t.socket, [
    "new-window", "-P", "-F", "#{pane_id}\t#{window_id}", "-t", t.id, "-c", cwd,
    ...(clean ? ["-n", clean] : []),
    ...argv,
  ]);
  if (out === null) return null;
  const [paneId = "", windowId = ""] = (out.split("\n")[0] ?? "").trim().split("\t");
  // Both, or neither. tmux printing something this does not recognise is not a
  // reason to hand a caller a string that goes on a command line.
  return PANE_ID.test(paneId) && WINDOW_ID.test(windowId) ? { paneId, windowId } : null;
}

/**
 * The prompts we take over, and what tmux does with them by default.
 *
 * Rebound conditionally on `@agx-owned`, a session option set only while the
 * panel holds the bar — key bindings are global to the tmux server, so an
 * unconditional rebind would take rename away from every other session on the
 * machine, including one attached from a real terminal where tmux's own prompt
 * is the right answer.
 */
const PROMPTS = [
  { key: ",", ask: "rename" },
  { key: ".", ask: "move" },
] as const;

/**
 * What `list-keys` says these keys do right now, verbatim and re-issuable.
 *
 * Captured before overwriting so release can put back exactly what was there —
 * the same rule `set-option -u` follows for the options, rather than guessing at
 * a default that varies by tmux version and by the user's own config.
 *
 * The whole table is listed and matched here rather than asking tmux for the one
 * key. `list-keys -T prefix .` is the obvious question and is a trap: measured
 * on 3.7b, the one-key form writes NOTHING to stdout and paints the binding onto
 * the attached client as a message instead. With the status row taken away by
 * this same function, that message lands on the top line of the user's shell —
 * so every take scribbled `bind-key  -T prefix . if-shell …` across the pane
 * they were looking at, and the answer came back empty on top of it, meaning
 * their real binding was never saved and never restored. The whole-table form
 * answers on stdout on every version tried.
 *
 * `line` is what release re-issues; `cmd` is the binding without its `bind-key
 * … <key>` head, which is what the new binding's false branch has to be. Both
 * come from the same parse because the head is not a fixed width: `-r` and `-N
 * "note"` ride in front of `-T`, and the key itself comes back escaped (`\#`,
 * `\$`) exactly as `bind-key` would take it back.
 */
export function parseBinding(line: string): { key: string; cmd: string } | null {
  const m = /^bind-key\s+(?:-\S+\s+(?:"[^"]*"\s+)?)*?-T\s+prefix\s+(\S+)\s+(\S.*)$/.exec(line.trimEnd());
  return m ? { key: m[1].replace(/\\(.)/g, "$1"), cmd: m[2] } : null;
}

function bindingsFor(t: TmuxTarget, keys: readonly string[]): Map<string, { line: string; cmd: string }> {
  const found = new Map<string, { line: string; cmd: string }>();
  const out = tmux(t.socket, ["list-keys", "-T", "prefix"]);
  if (!out) return found;
  for (const line of out.split("\n")) {
    const b = parseBinding(line);
    if (!b || !keys.includes(b.key) || found.has(b.key)) continue;
    found.set(b.key, { line: line.trim(), cmd: b.cmd });
  }
  return found;
}

/** Ours already, from an earlier take on this same server. Recognised so a
 *  second take does not save our own binding as "what the user had" and nest a
 *  copy of it inside itself on every sweep. */
function isOurs(cmd: string): boolean {
  return cmd.includes("@agx-ask");
}

/**
 * The user's command, read back out of ours.
 *
 * For the servers a build with the broken query already took: their binding was
 * never written down, but it was never destroyed either — it is sitting in the
 * false branch of the binding that replaced it, which is the whole point of
 * that branch. So the way back is recovered from what is on the server rather
 * than declared lost, and a machine that has been running the old build gets
 * its keys back on the next take instead of on the next reboot.
 *
 * One level of unquoting, because the branch was a quoted argument when
 * `list-keys` printed the line: `\"` and `\\` come back as themselves.
 */
function ourFalseBranch(cmd: string): string | null {
  const m = /^if-shell\s+-F\s+"#\{@agx-owned\}"\s+"set-option -w @agx-ask (?:rename|move)"\s+"(.*)"$/.exec(cmd);
  return m ? m[1].replace(/\\(.)/g, "$1") : null;
}

function takePrompts(t: TmuxTarget) {
  const had = bindingsFor(t, PROMPTS.map((p) => p.key));
  for (const { key, ask } of PROMPTS) {
    const was = had.get(key);
    const ours = !!was && isOurs(was.cmd);
    // Stored on the session, so release needs no memory of its own and a server
    // that was killed rather than closed still leaves the way back written down.
    if (was && !ours) tmux(t.socket, ["set-option", "-t", t.id, `@agx-had-${ask}`, was.line]);
    // On a re-take the binding on the server is our own, so the user's is the
    // one written down last time rather than the one tmux reports now.
    let stored = ours
      ? parseBinding((tmux(t.socket, ["show-options", "-qv", "-t", t.id, `@agx-had-${ask}`]) || "").trim())?.cmd
      : was?.cmd;
    if (ours && !stored) {
      // Taken by a build whose query answered on the user's screen instead of
      // to us. Nothing was written down; the binding itself still carries it.
      const recovered = ourFalseBranch(was!.cmd);
      if (recovered) {
        stored = recovered;
        tmux(t.socket, ["set-option", "-t", t.id, `@agx-had-${ask}`, `bind-key -T prefix ${key} ${recovered}`]);
      }
    }
    tmux(t.socket, [
      "bind-key", "-T", "prefix", key,
      "if-shell", "-F", "#{@agx-owned}",
      `set-option -w @agx-ask ${ask}`,
      // The false branch is the binding as it was, so every session this server
      // is NOT drawing keeps the prompt it has always had.
      stored ?? (ask === "rename"
        ? 'command-prompt -I "#W" "rename-window -- %%"'
        : 'command-prompt "move-window -t \'%%\'"'),
    ]);
  }
}

/**
 * Put the prompt keys back exactly as they were.
 *
 * Through `source-file` rather than by rebuilding an argv, because the thing
 * being restored is a tmux command *line* — `command-prompt -I "#W"
 * "rename-window -- %%"` — and splitting that on whitespace tears the quoted
 * arguments into pieces. tmux's own parser is the only thing that reads its
 * syntax correctly, so it is handed the line and asked to run it.
 */
function releasePrompts(t: TmuxTarget) {
  const lines: string[] = [];
  const now = bindingsFor(t, PROMPTS.map((p) => p.key));
  for (const { key, ask } of PROMPTS) {
    const had = (tmux(t.socket, ["show-options", "-qv", "-t", t.id, `@agx-had-${ask}`]) || "").trim();
    // `list-keys` prints a complete `bind-key …` line, so this is the user's
    // binding verbatim and not our idea of what the default should have been.
    if (had.startsWith("bind-key")) lines.push(had);
    else {
      // Nothing written down. Either we never took this key — in which case the
      // binding on the server is the user's and there is nothing to do — or it
      // was taken by the build whose query answered on their screen, and their
      // command is in the false branch of what is installed. See ourFalseBranch:
      // this is the path a stale sweep takes on a machine that ran that build.
      const cmd = now.get(key)?.cmd;
      const recovered = cmd && isOurs(cmd) ? ourFalseBranch(cmd) : null;
      if (recovered) lines.push(`bind-key -T prefix ${key} ${recovered}`);
    }
    tmux(t.socket, ["set-option", "-t", t.id, "-u", `@agx-had-${ask}`]);
  }
  if (!lines.length) return;
  // 0600 in a fresh 0700 dir: this is a file another local user must not be
  // able to swap for one of their own between the write and tmux reading it.
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "agentglass-tmuxkeys-"));
    const f = join(dir, "restore.conf");
    writeFileSync(f, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
    tmux(t.socket, ["source-file", f]);
  } catch { /* the bindings stay conditional on a flag that is now unset, which behaves as before */ }
  finally { if (dir) try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } }
}

/** Take the note off a window once the panel has been told about it. One sweep
 *  is all it should live for; left set, the panel would reopen its input every
 *  half second. */
export function clearAsk(t: TmuxTarget, window: string): void {
  tmux(t.socket, ["set-option", "-w", "-t", window, "-u", "@agx-ask"]);
}

/** Sockets this process has already swept. See releaseStale. */
const swept = new Set<string>();

/**
 * Give back every status line a previous run of this app took and never
 * returned.
 *
 * The release path is keyed off in-memory state (`tmuxStatusHiddenOn`), so it
 * runs when the panel closes and when the shell exits — and not at all when the
 * process is killed, OOMed, or goes down with the laptop lid. What is left
 * behind is a tmux session with `status off` and `@agx-owned` still set: no
 * status line, `prefix ,` leaving notes nobody reads, and no way for the user
 * to know why. It heals only if they happen to open the panel on that same
 * session again and then close it properly.
 *
 * So it is swept instead, once per tmux server, the first time this process
 * touches one. At that moment the claim is stale BY DEFINITION: no shell in
 * this process has taken anything yet, so any `@agx-owned` it finds belongs to
 * a run that is gone.
 *
 * The restore is exact rather than a guess, because the way back was written
 * onto the session itself — `@agx-had-rename` and `@agx-had-move` outlive the
 * process that set them, which is the whole reason they live there instead of
 * in a variable.
 */
export function releaseStale(c: TmuxClient): void {
  /*
   * The window sizes go back on the same trigger, and it is not the same sweep:
   * `sweepPinnedWindows` runs at boot over every socket in TMUX_TMPDIR, and
   * this is the server that was NOT in that directory — a client attached with
   * `-S` to a socket somewhere else, which the boot walk cannot discover and
   * which can still be carrying a mark from a run that was killed. It keeps its
   * own once-per-server set, so a socket the boot already handled costs nothing
   * here.
   *
   * Outside the `swept` guard below on purpose: that guard is about the status
   * line, and a process that has released one server's status line has said
   * nothing at all about another server's windows.
   */
  sweepPinnedWindows([c.socket]);
  const key = c.socket.join(" ");
  if (swept.has(key)) return;
  swept.add(key);
  const out = tmux(c.socket, ["list-sessions", "-F", "#{session_id}\t#{@agx-owned}"]);
  if (!out) return;
  for (const line of out.split("\n")) {
    const [id, owned] = line.split("\t");
    if (!id || owned?.trim() !== "1") continue;
    setStatusLine({ pid: c.pid, socket: c.socket, session: "", id }, true);
  }
}

export function setStatusLine(t: TmuxTarget, visible: boolean): boolean {
  if (visible) {
    releasePrompts(t);
    tmux(t.socket, ["set-option", "-t", t.id, "-u", "@agx-owned"]);
    // Give everything back, and do not stop at the first failure: a session that
    // kept `status-format[0]` blank because `status` failed to restore is a
    // session with an invisible status line and no way to know why.
    return BORROWED.map((opt) => tmux(t.socket, ["set-option", "-t", t.id, "-u", opt]) !== null).every(Boolean);
  }
  // Set before the rebind, so a keypress landing between the two finds the flag
  // already true rather than falling through to a prompt with nowhere to draw.
  tmux(t.socket, ["set-option", "-t", t.id, "@agx-owned", "1"]);
  takePrompts(t);
  // Nothing to take from someone whose config runs without a bar — the row
  // does not exist, so "hidden" is already true. The claim and the prompt
  // keys still go on: `prefix ,` and `prefix .` draw over the top line with
  // or without a bar, and the re-assertion the panel runs off this flag
  // depends on the claim being there to find.
  if (statusInConfig(t) === "off") return true;
  /*
   * The row itself — kept, and blanked, rather than switched off.
   *
   * `status off` was the obvious answer and it was wrong, for the reason this
   * file has now met twice: tmux still has messages to draw, and with no status
   * row it draws them ON THE PANE. Measured against a real attached client on a
   * private server: with `status off`, `display-message "Saving… AI00"` arrives
   * as a bare paint at the cursor — no cursor-home before it, no repaint after —
   * so it lands in the middle of whatever the pane was showing and stays there
   * until something else redraws that line. Reported from a desk running
   * tmux-continuum: every autosave stamped a line across an agent's box and ate
   * the line under it, and the pane appeared to flicker as the agent redrew.
   *
   * Same measurement with the row kept and `status-format[0]` blank: the
   * message is written after a `\r\n` into the reserved row, the pane is
   * untouched, and the cursor comes back to the pane's own last line. Nothing
   * on screen moves.
   *
   * It costs one row, which is exactly what the old comment here refused to
   * spend — "a row held open for prompts that no longer arrive there is just a
   * gap". The premise was wrong. They do arrive: `prefix ,`, `prefix .`, every
   * `display-message` any plugin makes, and continuum's autosave. A gap that
   * catches them is cheaper than a pane they land in.
   *
   * `status-style` goes with it so the reserved row takes the terminal's own
   * background instead of tmux's default green, and all three options are in
   * BORROWED, so the restore gives back exactly what was taken.
   */
  const kept = [
    ["status", "on"],
    ["status-format[0]", ""],
    ["status-style", "bg=default,fg=default"],
  ].map(([opt, val]) => tmux(t.socket, ["set-option", "-t", t.id, opt!, val!]) !== null).every(Boolean);
  if (!kept) { releasePrompts(t); tmux(t.socket, ["set-option", "-t", t.id, "-u", "@agx-owned"]); }
  return kept;
}

// ---------------------------------------------------------------------------
// Panes.
//
// Windows are what the tab strip needs; panes are what "take me to the agent
// that is waiting" needs, because that is the granularity an agent runs at.
// Both come off the same client's server — see paneloc.ts for why the join key
// is the agent's own working directory and not the pane's.
// ---------------------------------------------------------------------------

const PANE_ID = /^%\d+$/;
const SESSION_ID = /^\$\d+$/;

/**
 * Where a pane is, as tmux answers it right now.
 *
 * The shell's own cwd, not the directory the window was created in — `cd` at
 * the desk moves this, which is the point: "open a new tab here" means where
 * the hand is, not where the window started an hour ago.
 *
 * Asked of tmux rather than read off the last `/terminal/panes` sweep because
 * the two are different clocks. The sweep is up to two seconds old and is a
 * list; this is a question about one pane, asked at the moment somebody
 * pressed a button.
 */
export function paneCwd(socket: string[], paneId: string): string | null {
  if (!PANE_ID.test(paneId)) return null;
  const out = tmux(socket, ["display-message", "-p", "-t", paneId, "#{pane_current_path}"]);
  const path = out?.split("\n")[0]?.trim() ?? "";
  // Relative or empty is not a directory this may hand to `new-window -c`.
  return path.startsWith("/") ? path : null;
}

/**
 * Which server a `-S`/`-L`/nothing spelling actually names, as a path.
 *
 * A client can name its server three ways — no flag (the default socket),
 * `-L name`, `-S path` — and they can all be the SAME server. Adding the known
 * client's spelling alongside the directory listing put that server in the list
 * twice, and every pane on it came back twice with it. tmux resolves all three
 * to a file in one directory, so resolving them here is what makes "the same
 * server" one entry — and the only way two halves of this app that learned the
 * socket differently can tell they are talking about the same tmux.
 */
export function socketPath(args: string[]): string {
  // `normalize` on the two paths that arrive as text — a `-S` off a client's
  // argv and the first field of `$TMUX`. `join` already normalises what it
  // builds, so the `-L` and flagless branches get it for free, and a label
  // spelt `../../tmp/tmux-1000/default` folds there rather than escaping. This
  // is lexical only, on purpose: see `sameSocket` for why realpath belongs in
  // the comparison and not in the key.
  const i = args.indexOf("-S");
  if (i >= 0 && args[i + 1]) return normalize(args[i + 1]!);
  const l = args.indexOf("-L");
  if (l >= 0 && args[l + 1]) return join(socketDir(), args[l + 1]!);
  // No flag: `$TMUX` before the directory, because that is tmux's own order and
  // this function used to have it wrong. See inheritedSocket.
  const inherited = inheritedSocket();
  return inherited ? normalize(inherited) : join(socketDir(), "default");
}

/**
 * The socket of the tmux this process is already INSIDE, or null.
 *
 * `$TMUX` is `<socket path>,<server pid>,<session>`, and its first field is an
 * absolute path — so a bare `tmux`, with no `-S` and no `-L`, goes THERE and
 * TMUX_TMPDIR is never consulted. Measured on tmux 3.6a, from a shell inside a
 * live server, with an empty directory to hide behind:
 *
 *   TMUX_TMPDIR=/tmp/agx-probe-empty tmux list-sessions
 *     -> the five sessions somebody was working in    ** the developer's own **
 *   env -u TMUX  TMUX_TMPDIR=/tmp/agx-probe-empty tmux list-sessions
 *     -> error connecting to /tmp/agx-probe-empty/tmux-1000/default
 *
 * `-S` and `-L` do override it — measured the same way — which is why the two
 * checks above come first and why the four suites that name their own server
 * are unaffected.
 *
 * This is not a corner case here. Agents in this repo run inside his tmux, so
 * `$TMUX` is set in the environment `bun test` inherits, and the guard below
 * used to ask `socketDir()` where a bare command would land. With TMUX_TMPDIR
 * pointed at a scratch directory — which four test files do, correctly, for
 * their own servers — that answer was wrong in the one direction that costs
 * something. Measured before the fix:
 *
 *   socketPath([])       /tmp/agx-probe-empty/tmux-1000/default
 *   guard says allowed   true
 *   bare tmux reached    the five sessions somebody was working in
 */
function inheritedSocket(): string | null {
  const path = (process.env.TMUX ?? "").split(",")[0];
  return path || null;
}

/**
 * Is TMUX_TMPDIR a directory tmux can actually put its sockets in?
 *
 * The question this file used to skip. It read the VARIABLE — `TMUX_TMPDIR ||
 * tmpdir()` — and treated the mere presence of a value as proof of isolation.
 * tmux does not promise that. It tries to `mkdir $TMUX_TMPDIR/tmux-<uid>` and
 * reacts to what happens. Measured on 3.6a, `-L agxprobe`, `$TMUX` cleared:
 *
 *   TMUX_TMPDIR=/tmp/absent     -> error connecting to /tmp/tmux-1000/agxprobe
 *   TMUX_TMPDIR=<dir, mode 500> -> couldn't create directory <dir>/tmux-1000 (Permission denied)
 *   TMUX_TMPDIR=<a plain file>  -> couldn't create directory <file>/tmux-1000 (Not a directory)
 *   TMUX_TMPDIR=<a real dir>    -> error connecting to <dir>/tmux-1000/agxprobe
 *
 * Only the first line is dangerous, and it is the quiet one: an ABSENT
 * directory falls back to /tmp with no warning on stderr and no non-zero exit,
 * and /tmp/tmux-<uid> is where the developer's live sessions are. The two that
 * refuse are safe by refusing — no command reaches any server at all — but
 * they are not isolation either, so they answer null here too and let every
 * caller fail closed rather than sort danger from mere breakage.
 *
 * A `function` and not a `const` arrow, like `socketDir` and `blindTmuxBanned`
 * below, because all three are reached from `tmux()`, which is declared
 * hundreds of lines ABOVE them. A const would sit in its temporal dead zone for
 * anything running during module evaluation — the shape that once shipped a
 * black window in this app, and cost a day finding out why.
 */
function usableTmuxTmpdir(): string | null {
  const named = process.env.TMUX_TMPDIR;
  if (!named) return null;
  try { return statSync(named).isDirectory() ? named : null; } catch { return null; }
}

/**
 * The socket directory tmux uses when nothing redirects it: `_PATH_TMP`, a
 * literal `/tmp`, and NOT `os.tmpdir()`.
 *
 * The two disagree, and the disagreement is the whole reason this is its own
 * function. Measured: with TMUX_TMPDIR unset and TMPDIR=<scratch>,
 * `tmux -L x` still resolved to `/tmp/tmux-1000/x` — tmux reads TMUX_TMPDIR and
 * nothing else — while `os.tmpdir()` answered `<scratch>`, because Node re-reads
 * TMPDIR on every call. So a guard written against `tmpdir()` names a directory
 * tmux may never use, which is the same fail-open one layer down.
 *
 * This is the directory `/tmp/tmux-1000/default` lives in: five live sessions.
 */
function machineSocketDir(): string {
  return join("/tmp", `tmux-${process.getuid?.() ?? 0}`);
}

/** Where THIS PROCESS believes tmux keeps its sockets. Read on each call, never
 *  a module constant: `bun test` runs every file in one process and several of
 *  them set TMUX_TMPDIR after this module is already imported.
 *
 *  Two deliberate departures from `machineSocketDir`, and it matters which is
 *  which:
 *
 *   * TMUX_TMPDIR set but not a usable directory no longer answers itself. It
 *     used to, and that is the bug: `socketPath([])` reported
 *     `/tmp/absent/tmux-1000/default` while the command tmux actually ran
 *     landed on `/tmp/tmux-1000/default`. Falling back here makes the modelled
 *     path and the real one the same path again.
 *
 *   * With TMUX_TMPDIR unset this answers `tmpdir()`, which tmux would not.
 *     Kept on purpose: `tmux-test-isolation.test.ts` builds its stand-in socket
 *     directory by pointing TMPDIR at a scratch path precisely because tmux
 *     ignores TMPDIR, so the fixture's own server and the code under test reach
 *     the same directory through different variables without either of them
 *     going near /tmp/tmux-<uid>. That divergence is safe ONLY because
 *     `tmuxSocketAllowed` now refuses the real socket outright instead of
 *     inferring it from this function — see the note there. Nothing in this
 *     file may go back to deriving safety from how well this models tmux. */
function socketDir(): string {
  const named = usableTmuxTmpdir();
  return join(named ?? tmpdir(), `tmux-${process.getuid?.() ?? 0}`);
}

/**
 * One spelling per socket, so two of them can be compared.
 *
 * `-S` carries a path somebody typed, and a path has endless spellings of the
 * same file. Checked, all three resolve to the developer's socket and all three
 * used to compare unequal to it and be ALLOWED:
 *
 *   //tmp/tmux-1000/default
 *   /tmp/tmux-1000/./default
 *   /tmp/tmux-1000/../tmux-1000/default
 *
 * `normalize` folds those three (measured: it collapses a leading `//` too).
 * `realpathSync` additionally folds a symlink, which `normalize` cannot see,
 * and is skipped when the path is not there — an absent socket is one no
 * command can reach anyway, so the normalised form is the honest answer.
 *
 * Comparison only. `socketPath` stays purely lexical so it remains a stable key
 * for `claimKey` and for the dedup in `tmuxSockets`: a socket file appearing or
 * vanishing must not silently rename the server it identifies.
 */
function sameSocket(p: string): string {
  const n = normalize(p);
  try { return realpathSync(n); } catch { return n; }
}

/**
 * Under `bun test`, with no TMUX_TMPDIR, this process is one keystroke from the
 * developer's own tmux — so it is not allowed to go looking for one.
 *
 * `tmuxSockets()` lists `$TMUX_TMPDIR/tmux-<uid>`, and with TMUX_TMPDIR unset
 * that directory is `/tmp/tmux-1000`, which on the machine this was written on
 * holds three sessions somebody is working in. The boot sweep added in 8983791
 * walks every socket that listing returns and sends `resize-window -A`,
 * `set-option -w window-size` and `refresh-client` at anything carrying
 * `@agx-had-size`. Counted: 18 test files spawn the server as a child, and 15
 * of them handed it no TMUX_TMPDIR — so `bun test` in server/ or mobile/ was
 * one marked window away from resizing a real session. Measured while writing this: none
 * of his windows carried the mark, so nothing had been damaged yet — that is a
 * fact about that afternoon, not about the code.
 *
 * This is the same guard NODE_ENV already gives the database (#319), the
 * settings file (#321) and `tmuxpane`'s `new-session` (which refuses without
 * AGENTGLASS_TMUX_SOCKET), and it is the invariant `test/tmuxIsolated.ts`
 * exists to defend after a suite once restored somebody's whole workspace into
 * itself. It FAILS CLOSED: a test that needs a real tmux must name a private
 * TMUX_TMPDIR, which is the thing that made it safe in the first place, so a
 * test file that forgets gets a sweep that does nothing rather than a sweep
 * that reaches the desk.
 *
 * A LIMIT, stated rather than papered over: `NODE_ENV=test` is set by
 * `bun test` in the TEST process, and measured on Bun 1.3.9 it reaches a child
 * spawned with `env: {...process.env}` and NOT one spawned with a named
 * environment — which is how most of the suite spawns the server. Those
 * children are covered by `tmux-test-isolation.test.ts`, which reads every test
 * file and fails if one spawns `src/index.ts` without handing it a TMUX_TMPDIR.
 * Guard and lint are two halves of one rule; neither is sufficient alone.
 *
 * WHAT "SET" MEANS, and the reason this used to fail open despite the sentence
 * above claiming otherwise. The test was `!process.env.TMUX_TMPDIR` — the
 * variable, not the directory. A TMUX_TMPDIR naming a directory that is NOT
 * THERE therefore read as isolation while tmux silently fell back to
 * /tmp/tmux-<uid>: the one arrangement where the guard unlocked itself and the
 * command went to the developer's server. Reproduced through this module, with
 * NODE_ENV=test, `$TMUX` cleared and TMUX_TMPDIR naming an absent directory:
 *
 *   socketPath([])         /tmp/agx-test-tmux-ABSENT/tmux-1000/default
 *   guard says allowed     true
 *   commands that landed   display-message -p -t @1 #{window_width}
 *                          show-options -gv prefix        ** on his server **
 *
 * That precondition is not contrived: `test/tmuxTmp.ts` creates one fixed
 * directory in a `catch {}` and exports the path either way, so a single failed
 * mkdir — a stale root-owned /tmp/agx-test-tmux, a full disk, someone's cleanup
 * script — hands every spawned child exactly this. Asking the filesystem
 * instead of the environment is what makes the sentence above true.
 */
function blindTmuxBanned(): boolean {
  if (process.env.NODE_ENV !== "test") return false;
  return usableTmuxTmpdir() === null;
}

/**
 * May a tmux command reach this socket at all?
 *
 * Exported so it can be asserted directly, and that is not a convenience. The
 * rule is about the socket a bare `tmux` — no `-S`, no `-L` — lands on, and a
 * bare invocation cannot be aimed at a stand-in: `-S` and `-L` are the only two
 * things that redirect it, and using either makes it no longer the case under
 * test. A test that drove a real command through the empty socket to watch it
 * be refused would therefore be aimed at the developer's own server, and would
 * hit it on the one run the guard was missing — which is the run the test
 * exists for. So the refusal is asserted here, where asserting it costs
 * nothing, and the behavioural half of the test only ever drives `-S <stand-in>`.
 *
 * THREE refusals, because there are three ways for this process to be next to
 * his tmux and each version of this guard has known one more than the last:
 *
 *   1. `$TMUX`, ALWAYS — a private TMUX_TMPDIR does not buy it back. Agents in
 *      this repo run inside his tmux, so `bun test` inherits a `$TMUX` naming
 *      his socket, and a bare command goes there whatever TMUX_TMPDIR says.
 *      Nothing in this repo ever sets `$TMUX`: the four suites that run a
 *      server of their own name it with `-L agx-…`, which is checked first and
 *      is not this. So "the socket $TMUX names" is a precise spelling of "his",
 *      not a heuristic.
 *
 *   2. `/tmp/tmux-<uid>/default`, ALWAYS — the machine's real socket, refused
 *      as a constant rather than inferred. This is the one that was missing,
 *      and its absence is what made the other two conditional on a model.
 *      Every earlier version asked "is the socket about to be used the same as
 *      the one `socketDir()` predicts", so a `socketDir()` that predicted the
 *      wrong directory unlocked the right one. Two ways that happened: a
 *      TMUX_TMPDIR naming an absent directory (tmux falls back to /tmp, the
 *      model did not — see `usableTmuxTmpdir`), and TMPDIR redirected while
 *      TMUX_TMPDIR was unset (`os.tmpdir()` follows TMPDIR, tmux ignores it —
 *      see `machineSocketDir`), which is the arrangement
 *      `tmux-test-isolation.test.ts` itself runs in. Neither needs a model to
 *      be caught: under test that path is not ours, whatever else is true.
 *
 *   3. The default socket of the directory in force, when no usable
 *      TMUX_TMPDIR was named. This is the CI shape — no `$TMUX`, nothing set —
 *      and it is what makes the guard fail closed for a test file that forgets.
 *      It also still carries the stand-in case: with TMPDIR redirected, the
 *      stand-in's own `default` is refused, which is what stops that fixture
 *      from passing vacuously.
 *
 * Compared through `sameSocket`, not raw. `-S //tmp/tmux-1000/default`,
 * `-S /tmp/tmux-1000/./default` and `-S /tmp/tmux-1000/../tmux-1000/default`
 * all named his socket and all three used to be ALLOWED by all three rules
 * above, because each one compared strings. Nothing spells it that way today;
 * "nothing spells it that way today" is also what was true of the two holes
 * this same function has already been fixed for.
 *
 * The old LIMIT here — "with TMUX_TMPDIR set and no `$TMUX`, an explicit
 * `-S /tmp/tmux-<uid>/default` is allowed" — is gone rather than restated:
 * refusal 2 is exactly it, closed.
 */
export function tmuxSocketAllowed(socket: string[]): boolean {
  // NODE_ENV first so a production call pays one string compare and never the
  // `socketPath` join, the stat() in `usableTmuxTmpdir` or the realpath() in
  // `sameSocket`.
  if (process.env.NODE_ENV !== "test") return true;
  const path = sameSocket(socketPath(socket));
  const inherited = inheritedSocket();
  if (inherited && path === sameSocket(inherited)) return false;
  if (path === sameSocket(join(machineSocketDir(), "default"))) return false;
  return !blindTmuxBanned() || path !== sameSocket(join(socketDir(), "default"));
}

/**
 * Is this socket inside the private socket directory this process was given?
 *
 * A DIFFERENT question from `tmuxSocketAllowed`, and the reason it exists is
 * that it is not gated on NODE_ENV. Measured on Bun 1.3.9, `bun test` puts
 * NODE_ENV=test in the test process and it does NOT reach a child spawned with
 * a named environment — which is how nearly every suite here starts the server.
 * To every `process.env.NODE_ENV` check in this repo, such a child is
 * indistinguishable from production, so no amount of NODE_ENV guarding reaches
 * it.
 *
 * TMUX_TMPDIR is the one signal that does survive that spawn — the lint at the
 * bottom of `tmux-test-isolation.test.ts` fails the build if a suite spawns the
 * server without one — so it is the only thing a rule for that child can be
 * built on. The rule: a process handed a private socket directory may act on
 * servers INSIDE it and nowhere else. `/tmp/tmux-1000/default` is not inside
 * `/tmp/agx-test-tmux`.
 *
 * Free in production, checked: nothing in `server/src` or `desktop/` sets
 * TMUX_TMPDIR, so a real user's process is unconfined and this answers true —
 * and a user who does set one keeps their server inside it, so it answers true
 * for them too. It only ever refuses a process that was confined and then
 * reached outside its confinement.
 *
 * Applied at the two spawns in `themesync.ts` AND inside `tmux()` — the second
 * of those was the "obvious next change" this note used to defer, and what
 * made it due was finding the same reach through a door no NODE_ENV guard can
 * see: six scripts in `scripts/` spawn `server/src/index.ts`, none under `bun
 * test`, and every tmux command that server runs — the boot sweep, and
 * `listPanes` on every `/panes` request — resolved against `/tmp/tmux-<uid>`.
 * With those scripts now naming a private TMUX_TMPDIR (`scripts/tmuxTmp.ts`),
 * this is what makes that naming binding on all of them at once instead of on
 * the one call site somebody remembered.
 */
export function tmuxSocketConfined(socket: string[]): boolean {
  const named = usableTmuxTmpdir();
  if (!named) return true;
  const dir = sameSocket(join(named, `tmux-${process.getuid?.() ?? 0}`));
  return sameSocket(socketPath(socket)).startsWith(`${dir}/`);
}

/**
 * Every tmux server this user could be running.
 *
 * Discovered from the socket directory rather than from one of our own clients,
 * because the question "where is that agent sitting" has an answer whether or
 * not this app has a terminal open — the tmux server has been running all along
 * and holds every pane in it. Requiring a client first made the feature depend
 * on a view the user might never have visited, and answer "open the terminal
 * once" to a question that was already answerable.
 *
 * The known client's socket goes first when there is one: it is the server the
 * user is demonstrably using, so its panes are the likeliest match and the
 * ordering costs nothing.
 */
export function tmuxSockets(known?: string[]): string[][] {
  // Discovery is exactly how this process would learn about the developer's own
  // server: nothing else in the app knows that socket's name. See
  // blindTmuxBanned. The known client is dropped too — under `bun test` it was
  // resolved out of /proc, and /proc on this machine has his tmux in it.
  if (blindTmuxBanned()) return [];
  const dir = socketDir();
  let found: string[] = [];
  try { found = readdirSync(dir).map((n) => join(dir, n)); }
  catch { /* no socket directory: no tmux has ever run here */ }

  // The known client's server first when there is one — it is demonstrably the
  // one the user is on, so its panes are the likeliest match — and then the
  // rest, each once. Normalised to a path so a server named two ways is one
  // entry; see socketPath.
  const first = known ? socketPath(known) : null;
  const ordered = first ? [first, ...found.filter((p) => p !== first)] : found;
  return ordered.map((p) => ["-S", p]);
}

/**
 * Every pane on every one of them.
 *
 * Rows carry the socket they came from so a later "take me there" reaches the
 * same server. Panes are addressed by tmux ids, which are unique per server and
 * not across them, so acting on an id without knowing its socket is how you end
 * up selecting a window in somebody else's session.
 */
/**
 * Sessions that are only ever shown INSIDE another session — a floating window.
 *
 * A tmux popup runs its command in a pane of the outer tmux, so the client it
 * creates sees `TERM=tmux-256color` where a real terminal's client sees
 * `xterm-256color`. That is the mark, and it is a fact about how the client was
 * started rather than a convention: it holds whatever the session is called.
 *
 * Two earlier attempts at this were wrong and are worth naming so nobody tries
 * them again. A popup carries no flag and no option of its own — `show-options`
 * on one answers nothing. And "attached with no client" looked right in a
 * single sample and is not: sampled eight times in a row with a popup open, the
 * session had a client every time.
 *
 * A session ATTACHED FROM INSIDE another tmux counts too, and should: for a
 * phone it is not a separate place to go, it is a view already on the screen.
 */
/**
 * Sessions somebody is actually looking at.
 *
 * A tmux server accumulates detached sessions — a test that did not clean up, a
 * worktree opened last week, something a script left behind. They are real
 * sessions and they are on nobody's screen, and the desk's own terminal panel
 * never shows them: it shows the session its client is attached to.
 *
 * So the phone follows the same rule. Anything with no client is not a place
 * you are, and a picker listing four of those beside the one you work in is a
 * picker you have to read every time.
 */
function attachedSessions(socket: string[]): Set<string> {
  const out = tmux(socket, ["list-sessions", "-F", "#{session_name}\t#{session_attached}"]);
  if (out === null) return new Set();
  const live = new Set<string>();
  for (const line of out.split("\n")) {
    const [name, count] = line.split("\t");
    if (name && count && count !== "0") live.add(name);
  }
  return live;
}

function nestedSessions(socket: string[]): Set<string> {
  const clients = tmux(socket, ["list-clients", "-F", "#{client_session}\t#{client_termname}"]);
  if (clients === null) return new Set();

  const outer = new Set<string>();
  const nested = new Set<string>();
  for (const line of clients.split("\n")) {
    const [session, term] = line.split("\t");
    if (!session) continue;
    // `screen` as well as `tmux`: the same nesting, an older multiplexer.
    if (/^(tmux|screen)/.test(term ?? "")) nested.add(session);
    else outer.add(session);
  }
  // Only when EVERY client of it is nested. A session you also have open in a
  // real terminal is somewhere you work, whatever else is showing it.
  for (const session of outer) nested.delete(session);
  return nested;
}

/**
 * A row of /terminal/panes as this file can answer it.
 *
 * The contract's own shape, minus the one field only the route can fill —
 * `agentSession` is joined on from the hook notes, see `withAgentSessions` —
 * plus the socket it was read from, which is a filesystem path and stays on
 * this side of the wire.
 *
 * Written as `AgentPane` and not beside it. `popup` and `attached` used to be
 * declared inline in the return type below, where the phone that filters on
 * `attached` could not see them; the note on `AgentPane.attached` has what that
 * bought. Being `Omit<AgentPane, …>` also welds `PaneRow` to the contract in
 * passing: the object built below has to satisfy both, so a field added to one
 * and not the other stops compiling here.
 */
export type PaneWireRow = Omit<AgentPane, "agentSession"> & { socket: string[] };

export function listPanes(known?: string[]): PaneWireRow[] {
  const rows: PaneWireRow[] = [];
  /* The server we were last on, read once rather than per socket. Null when
     nothing is remembered, which is exactly how this behaved before. */
  const ours = recall()?.socket ?? null;
  for (const socket of tmuxSockets(known)) {
    /*
     * Servers somebody is attached to — or the one we ourselves were last on.
     *
     * The filter is doing a real job and keeps it: this project's own test
     * suite leaves a tmux server behind on a stray socket, and a
     * resurrect/continuum config then restores the user's real sessions into
     * it, so an unattached server CAN be a convincing duplicate of the one you
     * work in, with different pane ids. Offering those was offering to move a
     * window nobody would see move.
     *
     * But agentglass's own panel is usually the only client on the server it
     * shows, so closing the app detaches that session — and this line then hid
     * the session the app had just put down. Reported as having to run
     * `tmux attach -t <name>` in a terminal outside the app after every
     * restart, to be shown your own work again.
     *
     * A socket this app was demonstrably attached to is not a stray, whatever
     * the client count says now, and it is the ONE detached server that gets
     * through. Everything else is unchanged. See tmuxmemory.ts.
     */
    const mine = ours !== null && socketPath(socket) === ours;
    if (!mine && !tmux(socket, ["list-clients", "-F", "#{client_tty}"])?.trim()) continue;
    const out = tmux(socket, ["list-panes", "-a", "-F", PANE_FORMAT]);
    if (!out) continue;
    const nested = nestedSessions(socket);
    const live = attachedSessions(socket);
    // A plain loop rather than `push(...map(…))` so the object literal is
    // checked against `PaneWireRow` at the point it is written: renaming a
    // field here is then an unknown property on this line, which is exactly
    // what did not happen while the shape lived in an inline return type.
    for (const r of parsePanes(out)) {
      rows.push({ ...r, socket, popup: nested.has(r.session), attached: live.has(r.session) });
    }
  }
  return rows;
}

/**
 * The pane inside a window that the keyboard is going to.
 *
 * A window is what the panel's tab strip knows about; a pane is what an agent
 * actually runs in, and a split window has several. Asked of tmux directly
 * rather than filtered out of `listPanes`, because that format string does not
 * carry `pane_active` and widening it would change a parser three other
 * features read — this is one small call on the way to answering one question.
 *
 * The window id is checked against tmux's own syntax before it goes anywhere
 * near a command: it arrives from the browser. The socket does not — it is
 * discovered, and a server that has never heard of this window simply answers
 * nothing and the search moves on.
 *
 * The caller's own server is asked first — tmuxSockets already orders it there
 * — and that ordering is load-bearing rather than a speed-up: window ids are
 * per-server, so two tmux servers on one machine both have an `@3`, and taking
 * whichever the socket directory listed first would sometimes describe
 * somebody else's window with total confidence.
 */
export function activePane(known: string[] | undefined, windowId: string): { paneId: string; pid: number; socket: string[] } | null {
  if (!WINDOW_ID.test(windowId)) return null;
  for (const socket of tmuxSockets(known)) {
    const out = tmux(socket, ["list-panes", "-t", windowId, "-F", "#{pane_active}\t#{pane_id}\t#{pane_pid}"]);
    if (!out) continue;
    for (const line of out.split("\n")) {
      const [active, paneId, pid] = line.split("\t");
      const n = Number(pid);
      if (active === "1" && paneId && PANE_ID.test(paneId) && Number.isFinite(n) && n > 0) {
        return { paneId, pid: n, socket };
      }
    }
  }
  return null;
}

/**
 * Put a pane in front of the person attached to it.
 *
 * Three steps because a pane can be anywhere: move the client to the pane's
 * session if it is showing another, then the window, then the pane. Doing only
 * the last two lands silently on nothing when the pane is in a session no client
 * is attached to — the normal case for someone who keeps a session per project.
 *
 * Every id is checked against tmux's own syntax before it is passed. These
 * arrive from the UI, and a socket reachable from the UI must never be a way to
 * hand tmux an arbitrary argument — the same rule the terminal's own command
 * paths follow.
 */
export function focusPane(socket: string[], sessionId: string, windowId: string, paneId: string): boolean {
  if (!SESSION_ID.test(sessionId) || !WINDOW_ID.test(windowId) || !PANE_ID.test(paneId)) return false;
  // `switch-client` with no -c moves the most recently used client on this
  // server, which is the one the user was last looking at.
  if (tmux(socket, ["switch-client", "-t", sessionId]) === null) return false;
  if (tmux(socket, ["select-window", "-t", windowId]) === null) return false;
  return tmux(socket, ["select-pane", "-t", paneId]) !== null;
}

/**
 * Select a pane in the window already on screen.
 *
 * Deliberately NOT `focusPane`, which also switches the client's session and
 * window. This one is sent on a HOVER, many times a session, and it must not be
 * able to move anybody anywhere: the pane is in the window being drawn or the
 * command does not happen. `select-pane` on its own cannot leave that window.
 *
 * The id is checked against tmux's own syntax first, like every other id that
 * arrives from the UI.
 */
export function selectPane(t: TmuxTarget, paneId: string): boolean {
  if (!PANE_ID.test(paneId)) return false;
  return tmux(t.socket, ["select-pane", "-t", paneId]) !== null;
}

/**
 * Move a phone's pane through its own scrollback, in tmux's copy mode.
 *
 * ── why this is on the server at all ──────────────────────────────────────
 * Because the alternative puts KEYSTROKES on somebody's shell. A phone drag was
 * turned into wheel events and handed to xterm, and xterm's answer to a wheel on
 * the alternate screen with no scrollback of its own is a cursor key: measured
 * through the shipped page against a pane running `cat -v`, one drag delivered
 * 53 of them and the screen moved a single line. Arrows walk history onto a
 * prompt, and in an agent's TUI they move whatever is selected — including the
 * two buttons on a permission gate. Nothing on the phone can encode a scroll
 * safely, because a terminal has no way to say "scroll" that is not a key or a
 * mouse report. tmux does, and this is it.
 *
 * ── what it costs, said plainly ───────────────────────────────────────────
 * Copy mode is a property of the PANE, not of a client, so the desk sees it too
 * — and that is not a new cost this introduces. It is exactly what tmux itself
 * does when it has the mouse: `WheelUpPane` is bound to `copy-mode -e` followed
 * by the wheel, and with `mouse on` a phone drag already put the shared pane
 * into copy mode at scroll_position 33 (measured, same rig). The difference is
 * only which side asks for it.
 *
 * `-e` is what makes it clean up after itself: scrolling back down to the
 * bottom LEAVES copy mode. Measured on 3.6a — `send-keys -X -N 200 scroll-down`
 * against a pane 85 lines up ended with pane_in_mode 0 — so the ordinary way out
 * of a scroll is also the way out of the mode, with nothing to remember.
 *
 * The pane is the one the phone's own client is looking at, asked of tmux rather
 * than remembered from the attach: `windowId` on PhoneAttach is documented as
 * routing and not truth, and a phone can walk to another window with tmux's own
 * keys. The session name is ours and is checked against the one pattern this app
 * ever creates, so this can only ever address a window a phone of ours is on.
 *
 * Answers the pane it acted on and whether that pane is STILL in copy mode, so
 * the caller can hand the mode back if it was this that started it — and null
 * when it did nothing at all and so knows nothing.
 */
export function scrollPhonePane(
  socket: string[], phoneSession: string, lines: number,
): { paneId: string; entered: boolean; inMode: boolean } | null {
  if (!PHONE_SESSION.test(phoneSession)) return null;
  // A count, not a nudge: `-N` takes it, so a drag of forty lines is one tmux
  // call rather than forty. Clamped because it arrives from the UI and ends up
  // as an argument — and 500 is already more than any phone screen holds.
  const by = Math.trunc(Number(lines));
  if (!Number.isFinite(by) || by === 0) return null;
  const count = Math.min(500, Math.abs(by));

  const pane = tmux(socket, ["display-message", "-p", "-t", phoneSession, "#{pane_id}"])?.trim();
  if (!pane || !PANE_ID.test(pane)) return null;
  const inMode = tmux(socket, ["display-message", "-p", "-t", pane, "#{pane_in_mode}"])?.trim() === "1";

  /*
   * Scrolling forward when nothing is scrolled back is not a request, it is the
   * finger travelling the other way at the bottom of a screen. Entering copy
   * mode to answer it would put the desk's pane into copy mode for a gesture
   * that has nothing to show.
   */
  if (by > 0 && !inMode) return { paneId: pane, entered: false, inMode: false };
  if (!inMode && tmux(socket, ["copy-mode", "-e", "-t", pane]) === null) return null;
  const moved = tmux(socket, ["send-keys", "-X", "-t", pane, "-N", String(count), by < 0 ? "scroll-up" : "scroll-down"]);
  if (moved === null) return null;
  /*
   * Only a forward scroll can have ended the mode, so only a forward scroll
   * pays for asking. Going back into history cannot leave copy mode, and a
   * second `display-message` on every request of a drag is a tmux call per
   * frame of somebody's finger for an answer that is known.
   */
  const still = by < 0 || tmux(socket, ["display-message", "-p", "-t", pane, "#{pane_in_mode}"])?.trim() === "1";
  return { paneId: pane, entered: !inMode, inMode: still };
}

/**
 * Give a pane back out of copy mode, if this phone is what put it there.
 *
 * Owed for the same reason the window size is owed (see `restoreWindows`): the
 * mode is on the SHARED pane, so a phone that scrolled back and then went away
 * leaves the desk's next keystroke being read as a copy-mode command by a pane
 * that looks perfectly ordinary. `-e` covers the case where the person scrolled
 * back to the bottom themselves; this covers the case where they did not.
 *
 * `cancel` and not `send-keys q`: the binding for `q` is the user's to change,
 * and this must not depend on their config to undo something we did.
 */
export function leaveCopyMode(socket: string[], paneId: string): boolean {
  if (!PANE_ID.test(paneId)) return false;
  if (tmux(socket, ["display-message", "-p", "-t", paneId, "#{pane_in_mode}"])?.trim() !== "1") return false;
  return tmux(socket, ["send-keys", "-X", "-t", paneId, "cancel"]) !== null;
}

/** Find the server holding this pane, then go there. The socket is never sent
 *  to the client and never accepted from it — a filesystem path from the UI is
 *  exactly what must not reach a spawn. */
export function focusPaneAnywhere(known: string[] | undefined, _sessionId: string, _windowId: string, paneId: string): boolean {
  if (!PANE_ID.test(paneId)) return false;
  // A grouped session — a phone mirror, `agx-phone-…` — shares this pane's
  // window, so `list-panes -a` reports the pane under BOTH the real session and
  // the mirror. `switch-client` onto the mirror is what moved the desk onto a
  // phone-sized, doubled view it could not close without reloading tmux. So
  // exclude the mirror and aim at the real session that owns the pane, using
  // that row's own session and window ids rather than the ones the click
  // carried — which, coming from the same duplicated list, may be the mirror's.
  const row = listPanes(known).find((r) => r.paneId === paneId && !PHONE_SESSION.test(r.session));
  return row ? focusPane(row.socket, row.sessionId, row.windowId, paneId) : false;
}

/**
 * The command that shows a pane to somebody who is somewhere else — a phone.
 *
 * `attach-session` would be the obvious call and is the wrong one. tmux sizes a
 * session to the SMALLEST client attached to it, so a phone attaching to the
 * session on the desk squeezes the desk's panes down to phone width for as long
 * as it is looking. Nobody would use that twice.
 *
 * `new-session -t <session>` makes a session in the same *group*: same windows,
 * same live processes, but its own name and its own client list.
 *
 * That alone is NOT enough, and measuring is the only way anyone would know.
 * A grouped session shares the WINDOWS, and tmux sizes a window to whichever
 * client used it last (`window-size latest`, the default). Measured with two
 * real ptys: a 40-column phone joining a 200-column desk took the desk down to
 * 40 — identically for the grouped session and for a naive `attach -t`. The
 * whole point of the grouped session was to avoid exactly that, and it did not.
 *
 * `window-size largest` is what does it: the window follows the biggest client
 * instead of the newest, so the desk keeps its size and the phone sees the
 * top-left of it. The option is set on a session named HERE and belonging to
 * us, never on the user's — a companion that permanently changes an option on
 * somebody's working session has fixed its own problem by creating theirs.
 *
 * That session also runs with tmux's own status line off. Without it the phone
 * shows two window lists stacked: the app draws its own tab strip, and directly
 * under it tmux paints the same windows again, on the screen with the least
 * vertical space to spare. `status` is a session option, so turning it off on
 * the session named here costs nobody else anything — measured with two real
 * ptys against a grouped pair, the desk's client went on painting its bar (its
 * session name and its clock kept arriving on its pty after the phone attached,
 * and its session still reports no `status` of its own, so it is still reading
 * the user's global value) while the phone's pty carried neither. Without the
 * option the phone painted the bar, which is the control that says it is this
 * line doing the work. The desk's bar is the user's own configuration and is
 * not ours to switch off.
 *
 * Every id is checked against tmux's own syntax and the pane is looked up in
 * the live list rather than trusted, so a caller can only ever name a pane that
 * exists on a server this machine is already running. The socket comes from
 * that lookup — it is never accepted from a client, because a filesystem path
 * from the UI reaching a spawn is the whole class of bug this file avoids.
 */
/** How wide and tall a window is, as tmux has it right now. Null when tmux
 *  cannot be asked — a caller that shows this must say nothing rather than
 *  make a number up. */
export function windowSize(socket: string[], windowId: string): { cols: number; rows: number } | null {
  if (!WINDOW_ID.test(windowId)) return null;
  const out = tmux(socket, ["display-message", "-p", "-t", windowId, "#{window_width}\t#{window_height}"]);
  const [w, h] = (out ?? "").trim().split("\t");
  const cols = Number(w), rows = Number(h);
  return Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 ? { cols, rows } : null;
}

/**
 * The way back written ONTO the window, so it outlives the process that took it.
 *
 * A tmux user option. tmux never sets one itself and never reads it, so a
 * window carrying `@agx-had-size` was written by exactly one line of this file
 * — that is the whole evidence-of-ownership the startup sweep acts on, and the
 * same trick `@agx-owned` already plays for the status line.
 *
 * Its value is what `window-size` was set to on that window a moment before a
 * phone's command touched it, or `none` for "the window carried nothing of its
 * own". A sentinel word rather than an empty string because an unset user
 * option and one set to "" are indistinguishable in a format (measured:
 * `list-windows -F '[#{@agx-had-size}]'` prints `[]` for both), and "was it
 * unset" is precisely the question the restore has to answer. `none` cannot
 * collide with a real value: tmux takes only the four below.
 */
const HAD_SIZE = "@agx-had-size";
const HAD_NOTHING = "none";
/** What tmux itself accepts for `window-size`. A mark holding anything else was
 *  not written by us however it got there, and the sweep declines to act on it. */
const WINDOW_SIZE_VALUE = /^(largest|smallest|manual|latest)$/;

/**
 * Who is holding this mark, written beside it — and the reason the sweep can no
 * longer call every mark it sees "stale by definition".
 *
 * That argument was: at boot no phone in THIS process has attached yet, so any
 * `@agx-had-size` belongs to a run that is gone. It is wrong about one instant,
 * and MEASURED rather than reasoned about. `windowSizeOptions` writes the mark
 * BEFORE its caller spawns the attach argv, and the phone's session — which is
 * the only thing `phoneWindows()` can see — does not exist until that spawn
 * lands. On a private server, with the argv held back:
 *
 *   after attachArgvFor   mark=none   sessions=desk   phoneWindows=[]
 *   a second server boots  restored=0
 *   after that sweep      mark=(gone)
 *
 * `restored=0`, so nothing moved and nothing looked wrong. But the durable
 * record was gone, and the fit that ran a millisecond later pinned that window
 * with nothing on it to say who by — so if that server is then SIGKILLed the
 * window stays `manual` for the life of the tmux server. That is precisely the
 * bug the whole feature exists to fix, reachable through the feature itself. He
 * runs about ten of these servers, so "two booting at once" is a Tuesday.
 *
 * So ownership stops being an assumption and becomes a fact on the window: the
 * pid that took the mark, and that process's start time from /proc so a reused
 * pid cannot inherit the claim. The sweep skips any window whose claimant is
 * still running. A killed server's claim is dead with it, which is the case the
 * sweep is for; a live server's claim is honoured, which is the case it must
 * not touch.
 *
 * Cleared in `clearSizeMark` and nowhere else, so it cannot drift from the mark
 * it qualifies.
 */
const HAD_SIZE_BY = "@agx-had-size-by";

/*
 * ------------------------------------------------------------------------
 * THE PIN LEDGER: which tmux servers this installation has ever pinned on.
 *
 * WHY THIS EXISTS RATHER THAN ANOTHER ENVIRONMENT VARIABLE. The boot sweep
 * used to be handed `tmuxSockets()` — a listing of `$TMUX_TMPDIR/tmux-<uid>`,
 * which with TMUX_TMPDIR unset is `/tmp/tmux-<uid>`, this developer's own
 * sockets — and the only thing standing in front of it was
 * `blindTmuxBanned()`, whose first line is `if (process.env.NODE_ENV !==
 * "test") return false`. A server that is not under `bun test` was therefore
 * not guarded at all, and six scripts in `scripts/` spawn exactly that server:
 * soak, loadtest, perfbudget, capture-live, conflict-drive, browser-drive.
 * Each one carefully redirects AGENTGLASS_DB, XDG_CONFIG_HOME, XDG_DATA_HOME
 * and XDG_CACHE_HOME, and none of them set NODE_ENV or TMUX_TMPDIR. Measured
 * with the exact environment `perfbudget.ts` hands its child, `$TMUX` cleared:
 *
 *   NODE_ENV = undefined   TMUX_TMPDIR = undefined
 *   socketPath([])  /tmp/tmux-1000/default
 *   allowed([])     true
 *   tmuxSockets()   25 sockets, his default among them
 *
 * That is the THIRD time this same reach has been closed, each time through a
 * door the previous fix did not know about: a guard for `bun test`, then a lint
 * over `server/test` and `mobile/test`, and now a population — files that spawn
 * the server — that neither of those had a name for. Giving those six scripts a
 * TMUX_TMPDIR (done, `scripts/tmuxTmp.ts`) is the same shape as both previous
 * fixes: it protects the six that exist and nothing about the seventh.
 *
 * So the default is inverted. The sweep no longer asks "is there a reason to
 * refuse"; it asks the process to DEMONSTRATE the socket is one it owns, and
 * touches nothing it cannot prove. NODE_ENV is not consulted, so this holds for
 * a script's server, a `bun run` in a checkout, CI, and an Electron sidecar
 * alike.
 *
 * WHAT COUNTS AS PROOF. The sweep exists to undo `window-size manual` that a
 * previous run of THIS INSTALLATION left on a window and was SIGKILLed before
 * releasing. There is exactly one line in this file that writes the
 * `@agx-had-size` mark such a run leaves — the `set-option` in
 * `windowSizeOptions` — so "sockets we could have marked" is a set this app can
 * write down at the instant it marks one, and read back at the next boot. It
 * lives beside the database and the settings, under $XDG_DATA_HOME, because
 * that is where this app's identity already is.
 *
 * WHAT IT COVERS: any launcher whose data directory is not this installation's
 * — which is all six scripts (they redirect XDG_DATA_HOME today), every test
 * that redirects it, CI, and a fresh checkout — sweeps NOTHING, whatever it
 * does with NODE_ENV or TMUX_TMPDIR, because its ledger is empty. A boot that
 * has never pinned anything issues zero tmux commands, so it never even lists
 * his socket directory.
 *
 * WHAT IT DOES NOT COVER, plainly: a launcher that redirects nothing at all.
 * Such a process reads this installation's ledger and would perform this
 * installation's own recovery — the same windows the app itself would release
 * at its next boot, never a stranger's socket. That residue is irreducible: a
 * process holding the app's database, settings and data directory is the app by
 * every signal that exists. What changed is the blast radius — from "every tmux
 * server on the machine" to "the servers this install has pinned on".
 *
 * AND THE ONE THING IT COSTS: a window pinned by a build from BEFORE this
 * ledger existed, orphaned by a SIGKILL, is never released — there is no entry
 * for it and no way to invent one. One upgrade boundary, for the windows
 * orphaned across it; `fit` and `takeover` still clear their own marks, and
 * everything pinned after the upgrade is recorded.
 */

/** Most-recent-first, and capped. He runs about ten servers; 32 is well past
 *  what a machine has and small enough that the file stays one read. */
const PIN_LEDGER_MAX = 32;

/** One scratch ledger per test process, made once. Per CALL would be a new
 *  empty file every time — a record nothing could ever read back. */
let testLedgerPath: string | null = null;

/**
 * WITH THE SOCKETS IT NAMES, whenever a socket directory has been named at all;
 * otherwise beside the database (`db.ts`) and the browsing history
 * (`placestore.ts`), under the XDG_DATA_HOME they read.
 *
 * The first rule is not a test convenience, and the first full suite run after
 * this ledger was written is why it exists. It put a fixture socket into the
 * developer's real `~/.local/share/agentglass/pinned-tmux-sockets`:
 *
 *   /tmp/agx-tmux-claim-1440175/tmux-1000/agx-claim
 *
 * `tmux-attach-claim.test.ts` drives `attachArgvFor`, which pins a window,
 * which writes here. That file is correctly isolated — private TMUX_TMPDIR,
 * `-f /dev/null`, its own socket name — and it still wrote into his data
 * directory, because nothing in tmuxctl.ts had ever written there before and no
 * test had reason to redirect XDG_DATA_HOME. Every other suite that pins is the
 * same shape, and so is every launcher: `tmux-sigkill-restore` hands its server
 * child TMUX_TMPDIR and XDG_CONFIG_HOME and no XDG_DATA_HOME. Requiring a
 * second variable would be the third round of "protect the callers that exist".
 *
 * So the record follows the thing it is a record OF. A process handed a private
 * TMUX_TMPDIR has a private tmux world, its pins are about servers in that
 * directory, and they are meaningless to any other. It also fixes the lifetime:
 * a fixture's entries die with `rmSync(TMPDIR)` instead of outliving the sockets
 * they name by months. And it holds for a real user who exports TMUX_TMPDIR —
 * the file sits beside their sockets and persists exactly as long as those do,
 * so their boot sweep goes on working across restarts.
 *
 * `$TMUX_TMPDIR/agentglass-pinned-sockets`, and NOT inside `tmux-<uid>/` one
 * level down: `tmuxSockets()` maps every entry of that directory to a socket,
 * so a file in there would be handed to the sweep as a server to walk.
 *
 * The NODE_ENV floor underneath is for the case neither covers — a test that
 * pins with no TMUX_TMPDIR at all. `tmuxSocketAllowed` refuses those before
 * they reach a real server, so it is belt and braces; it costs one string
 * compare and it means no arrangement of variables writes a test's pins into
 * the file a real boot reads.
 */
function pinLedgerPath(): string {
  const named = usableTmuxTmpdir();
  if (named) return join(named, "agentglass-pinned-sockets");
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const scratch = tmpdir();
  if (process.env.NODE_ENV !== "test" || base === scratch || base.startsWith(`${scratch}/`)) {
    return join(base, "agentglass", "pinned-tmux-sockets");
  }
  return (testLedgerPath ??= join(mkdtempSync(join(scratch, "agx-test-pins-")), "pinned-tmux-sockets"));
}

/**
 * The sockets on record, newest first.
 *
 * Dead entries are dropped on the way past, and the liveness test is weaker
 * than it looks: measured on tmux 3.6a, `kill-server` does NOT unlink the
 * socket file — it was still there, `srw-rw----`, after the server was gone. So
 * `statSync` only sheds entries a reboot or a /tmp sweeper has already cleared.
 * `PIN_LEDGER_MAX` is what actually bounds the file; this is here because a
 * path that is gone can hold no window and no mark, so spending a `list-windows`
 * on it would be a spawn for nothing.
 */
function pinLedger(): string[] {
  let raw: string;
  try { raw = readFileSync(pinLedgerPath(), "utf8"); } catch { return []; } // never pinned anything
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const p = line.trim();
    // Absolute only. The file is ours, but it is a file on disk, and a relative
    // path would resolve against whatever cwd the launcher happened to have.
    if (!p.startsWith("/") || out.includes(p)) continue;
    try { statSync(p); } catch { continue; }
    out.push(p);
    if (out.length >= PIN_LEDGER_MAX) break;
  }
  return out;
}

/**
 * Write down that we have taken a window's size on this server.
 *
 * Called from the one place that writes the mark, in the same breath, and
 * synchronously: the run this record exists for is one that is about to be
 * SIGKILLed, so anything deferred is a record that does not survive the thing
 * it was written for.
 *
 * Best-effort. An unwritable data directory means no record and so no sweep,
 * which is the direction to fail: a window that keeps a `manual` it should have
 * lost is visible and recoverable by hand, and a sweep acting without evidence
 * is the bug this whole ledger exists to close.
 */
function notePinnedSocket(socket: string[]): void {
  const path = socketPath(socket);
  const have = pinLedger();
  if (have.some((p) => sameSocket(p) === sameSocket(path))) return;
  const file = pinLedgerPath();
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // 0600 like the token and the places database: a socket path names a
    // session directory and a uid, and another local user has no business
    // reading which servers this app has touched.
    writeFileSync(file, `${[path, ...have].slice(0, PIN_LEDGER_MAX).join("\n")}\n`, { mode: 0o600 });
  } catch { /* unwritable data dir — see above: no record, no sweep */ }
}

/**
 * The sockets the boot sweep is allowed to look at, as tmux argv.
 *
 * This is what `index.ts` hands `sweepPinnedWindows`, in place of
 * `tmuxSockets()`. The difference is the whole fix: `tmuxSockets()` answers
 * "every tmux server this user could be running" — the right answer for "where
 * is that agent sitting", and the wrong one for "what did I leave behind".
 */
export function pinnedSockets(): string[][] {
  return pinLedger().map((p) => ["-S", p]);
}

/** Is this a server we have a record of pinning on? Compared through
 *  `sameSocket`, so `-L work` and `-S /tmp/…/work` are one server — the same
 *  folding `tmuxSocketAllowed` does, and for the same reason: three spellings
 *  of one path used to compare unequal and be let through. */
function pinnedHere(socket: string[], ledger: Set<string>): boolean {
  return ledger.has(sameSocket(socketPath(socket)));
}

/**
 * What `window-size` is set to ON each window of this group — the way back.
 *
 * Read before the phone's command runs, because both halves of that command
 * write this option onto the USER'S windows: the fit is a `resize-window -x`,
 * which the manpage says "will automatically set window-size to manual in the
 * window options", and even a phone with no fit sets `largest` (measured: the
 * `set-option -t <our session> window-size largest` in `attachArgvFor` lands on
 * the shared window, not on our session — `show-options -wv` on the desk's own
 * window reports `largest` the moment a phone is on it).
 *
 * Deliberately the LOCAL value and not `#{window-size}`, which is the effective
 * one: a window with nothing set of its own answers `latest` there, and putting
 * `latest` back would leave an option written on somebody's window that was
 * never on it. Empty string means exactly that — nothing was set — and the
 * restore unsets rather than guessing at a default. Same rule the status line
 * follows with `set-option -u`, for the same reason.
 *
 * One spawn per window rather than one batched call, because a batch stops at
 * its first error: a window that dies between the list and the read would take
 * every other window's answer with it. Measured on an 8-window session: 9-11ms
 * for the lot, once, at attach — the sweep that runs twice a second is not
 * involved.
 *
 * THE SAME ANSWER IS ALSO WRITTEN ONTO THE WINDOW, and that is what survives
 * being killed. The in-memory copy this returns is reached only by `cleanup`
 * and `shutdownTerminals`, and neither of those runs under SIGKILL or an OOM
 * kill — which is how a user ended up with one window at 54 rows inside a
 * 59-row client, `window-size manual`, for the rest of that tmux server's life
 * and with nothing on screen to say what had done it. See `sweepPinnedWindows`.
 *
 * FIRST WRITER WINS. The existing mark is read in the same `list-windows` that
 * enumerates the windows (free — the format string carries it) and is never
 * overwritten. Two phones on one window: the second one's capture is the
 * `manual` the FIRST one's fit already wrote, so overwriting would record our
 * own footprint as the way back and pin the window exactly as the original bug
 * did. It is the same rule the shutdown path spends its `seq` ordering on —
 * oldest capture wins — expressed where the process cannot take it with it.
 */
function windowSizeOptions(socket: string[], sessionId: string): Record<string, string> {
  const had: Record<string, string> = {};
  if (!SESSION_ID.test(sessionId)) return had;
  const out = tmux(socket, ["list-windows", "-t", sessionId, "-F", `#{window_id}\t#{${HAD_SIZE}}`]);
  for (const line of (out ?? "").split("\n")) {
    const [id, mark] = line.split("\t");
    if (!id || !WINDOW_ID.test(id)) continue;
    const v = tmux(socket, ["show-options", "-wv", "-t", id, "window-size"]);
    // Null is a window that went away between the list and the read, not an
    // unset option: measured, `show-options -wv` on a real option nobody has
    // set exits 0 with empty output. Recording nothing for it is right — there
    // is no longer a window to put anything back on.
    if (v === null) continue;
    had[id] = v.trim();
    if (!(mark ?? "").trim()) {
      // The ledger BEFORE either option, and that order is the same argument
      // the two options make between themselves. A record with no mark costs
      // one `list-windows` at the next boot and finds nothing; a mark with no
      // record is a window this app pinned and can never prove it owns, so a
      // SIGKILL here would strand it for the life of that tmux server — which
      // is the failure the sweep exists for. See THE PIN LEDGER above.
      notePinnedSocket(socket);
      // The claim first, then the mark. A sweep that reads between the two must
      // see either nothing at all (harmless: it walks past an unmarked window)
      // or a mark that is already spoken for. The other order leaves a window
      // marked and unclaimed for one spawn — which is exactly the gap this
      // whole option exists to close, so writing it in the wrong order would
      // reintroduce the bug in miniature.
      tmux(socket, ["set-option", "-w", "-t", id, HAD_SIZE_BY, thisRun()]);
      tmux(socket, ["set-option", "-w", "-t", id, HAD_SIZE, had[id] || HAD_NOTHING]);
    }
  }
  return had;
}

/** Take the mark off, once the window has been put back or once somebody else
 *  has taken the option over. Its own function because forgetting it in one of
 *  the four places that owe it is how the startup sweep would come back months
 *  later and undo a value it never wrote. The claim goes with it, in this one
 *  function, so a window can never be left claimed by a run that no longer owns
 *  its size. */
function clearSizeMark(socket: string[], windowId: string): void {
  if (!WINDOW_ID.test(windowId)) return;
  tmux(socket, ["set-option", "-uw", "-t", windowId, HAD_SIZE]);
  tmux(socket, ["set-option", "-uw", "-t", windowId, HAD_SIZE_BY]);
}

/**
 * This run's identity, as `<pid>:<start time>`.
 *
 * The start time is field 22 of /proc/<pid>/stat, in clock ticks since boot,
 * and it is what makes a pid unambiguous: pids are reused, and a reused one
 * would let a stranger's process go on vouching for a claim its owner made
 * before it died — a window that then never recovers, which is the failure this
 * is here to prevent rather than a smaller version of it.
 *
 * Parsed from after the LAST `)`, never by splitting the whole line: field 2 is
 * the executable name in parentheses and it may contain spaces and parentheses
 * of its own, so `split(" ")[21]` is wrong for any process with a space in its
 * name.
 *
 * Where /proc is not there, the pid stands alone. That is weaker and it is the
 * honest fallback: this file is Linux-only anyway (it reads /proc to find the
 * tmux client at all), so nothing reaches it in practice.
 */
function startTimeOf(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22 overall; the slice dropped fields 1 and 2, so index 19.
    const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return started && /^\d+$/.test(started) ? started : null;
  } catch { return null; } // no such process, or no /proc
}

/** This run's identity. Without /proc there is no start time to carry and the
 *  pid stands alone — weaker, and the honest fallback on a system this file
 *  cannot read anyway (it finds the tmux client through /proc to begin with). */
function thisRun(): string {
  const started = startTimeOf(process.pid);
  return started ? `${process.pid}:${started}` : String(process.pid);
}

/**
 * Is the run that took this mark still going?
 *
 * Fails towards NO, and that direction is chosen rather than inherited: a wrong
 * "no" costs one window one restore it did not need, and a wrong "yes" leaves a
 * window pinned for the life of the tmux server — which is the bug, not a
 * smaller version of it. So an unparseable claim, and a pid nothing is running
 * under, both answer no.
 *
 * The liveness read comes FIRST and it is what makes the whole thing work. An
 * earlier version derived this run's identity for the claimed pid and compared
 * the strings — which looked equivalent and was not: for a pid with no /proc
 * entry the fallback produced the bare pid, so a bare-pid claim matched a
 * process that does not exist and every such window was protected for ever. It
 * failed on the first test written for it.
 */
function claimAlive(claim: string): boolean {
  const [pidPart, started] = claim.split(":");
  const pid = Number(pidPart);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const running = startTimeOf(pid);
  if (running === null) return false;
  // No start time on the claim: it was written where /proc could not be read,
  // so the pid is all it recorded and the pid is all there is to check. The
  // read above has already established that something is running under it.
  return started === undefined || started === running;
}

/** The sessions this app makes for a phone: `agx-phone-<pane digits>-<suffix>`,
 *  built in `attachArgvFor` below. One regex so the two cannot drift, and
 *  declared above both readers rather than between them. */
const PHONE_SESSION = /^agx-phone-(\d+)-[a-z0-9]+$/;

/** Is this session name one of the mirrors this app makes? The mirror is the
 *  only session whose bar the panel may re-assert: it is ours, and hiding it
 *  costs nobody else anything. The session the mirror shares its windows with
 *  is the user's, and re-asserting there would take the desk's bar away. */
export function isPhoneSession(session: string | null | undefined): boolean {
  return typeof session === "string" && PHONE_SESSION.test(session);
}

/**
 * Put the phone's view back on one of OUR mirrors when its client has
 * wandered onto a session that is not ours.
 *
 * `prefix s`, an `attach-session` typed into the pane, a continuum restore —
 * all of them move the tmux client off the grouped mirror this app made, and
 * the mirror dies with the client (`destroy-unattached`). The session the
 * client lands on has no `status off` of its own, so tmux's own bar comes
 * back — and hiding it THERE would take the desk's bar away too, because
 * `status` is a session option and the desk is attached to that same session.
 *
 * So instead of hiding on the moved-to session, a fresh mirror of it is made —
 * the same shape `attachArgvFor` builds: grouped (`new-session -t`), sharing
 * the windows, sized `largest` so the desk is not squeezed, `status off` — and
 * OUR client is switched back onto it by tty. The old mirror is already gone;
 * the new one dies the same way when the client leaves.
 *
 * No fit and no zoom here: both were owed by the window the phone originally
 * opened, and this move has nothing to do with it. The new mirror renders the
 * moved-to window at the desk's size, exactly as a fresh attach would.
 *
 * `destroy-unattached` is set LAST on purpose: measured, tmux kills a session
 * carrying it the moment it has no attached client — so a detached mirror
 * created with it already set would be gone before `switch-client` reached it.
 *
 * The name is a contract, not a label: `PHONE_SESSION` (and so `phoneWindows`,
 * the strip's phone mark, the #487 width notice, and `reclaimPinnedWindow`)
 * treats any `agx-phone-…` session as "a phone is on this window". That is
 * correct here — the caller only remounts an attach that HAD a mirror
 * (`session.phoneAttach`), so the new session is a phone by definition — but
 * it is load-bearing: a mirror ever remounted for a desk client would need its
 * own prefix, not a silent fifth reader of this one.
 */
export function remountPhoneClient(c: TmuxClient, target: TmuxTarget): boolean {
  if (!SESSION_ID.test(target.id)) return false;
  if (isPhoneSession(target.session)) return false;
  // The digits the regex needs are the client's own pid; the suffix is random
  // so two remounts on the same client cannot collide.
  const name = `agx-phone-${c.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const created = tmux(c.socket, [
    "new-session", "-d", "-t", target.id, "-s", name,
    ";", "set-option", "-t", name, "window-size", "largest",
    ";", "set-option", "-t", name, "status", "off",
  ]);
  if (created === null) return false;
  // Address our own client by its tty: `switch-client` run from the server has
  // no client context of its own, and the tty is how tmux names the client
  // back — the same field `readFrame` matches on. The flags are the 3.7 order:
  // `-c` is the target client, `-t` the target session (`focusPane` uses only
  // `-t`, so it never met the swap).
  if (tmux(c.socket, ["switch-client", "-c", c.tty, "-t", name]) === null) {
    tmux(c.socket, ["kill-session", "-t", name]);
    return false;
  }
  // The client is on it now, so the mirror dies when the phone leaves.
  tmux(c.socket, ["set-option", "-t", name, "destroy-unattached", "on"]);
  return true;
}

/**
 * What a window's zoom is, and whether zooming it would mean anything.
 *
 * Three fields in one read because the decision needs all three. A window with
 * a single pane is measured, not assumed: `resize-pane -Z` on one is a silent
 * no-op on tmux 3.6a — exit 0, `window_zoomed_flag` still 0 — so the reason to
 * skip it is not that tmux would mind. It is that recording "this window was
 * not zoomed when we arrived" for a window we never zoomed is how the teardown
 * ends up undoing somebody ELSE'S zoom: split it, zoom it, and the phone
 * leaving takes the desk's own zoom off a window the phone never touched.
 *
 * `active` is here because a zoomed window's zoomed pane IS its active pane,
 * and "is it already zoomed onto the pane I am opening" is a different question
 * from "is it zoomed" — with a different answer and a different command.
 *
 * Session-qualified for the reason `fitWindow` is: measured today, a bare
 * window id stops resolving once a grouped session shares the window, and it
 * fails silently as far as anything reading a flag is concerned.
 */
function windowZoom(socket: string[], sessionId: string, windowId: string): { panes: number; zoomed: boolean; active: string } | null {
  if (!SESSION_ID.test(sessionId) || !WINDOW_ID.test(windowId)) return null;
  const out = tmux(socket, ["display-message", "-p", "-t", `${sessionId}:${windowId}`, "#{window_panes}\t#{window_zoomed_flag}\t#{pane_id}"]);
  const [panes, flag, active] = (out ?? "").trim().split("\t");
  const n = Number(panes);
  if (!Number.isInteger(n) || n < 1) return null;
  return { panes: n, zoomed: flag === "1", active: active ?? "" };
}

/**
 * Take a zoom off — and only ever a zoom that is really there.
 *
 * `resize-pane -Z` TOGGLES. tmux has no "unzoom", so a call made without
 * looking first is exactly as likely to zoom a window as to unzoom it, and the
 * caller that gets it wrong is the teardown: it runs seconds after a socket
 * closed, on a window somebody may already be using again.
 *
 * `onlyPane` is how the teardown stays inside its own footprint. When a window
 * is zoomed the zoomed pane is the active one, so "still zoomed, and still on
 * the pane we zoomed" is as close as tmux lets anyone get to "this zoom is the
 * one we made". It does not close the hole entirely — the desk unzooming and
 * re-zooming the same pane is indistinguishable — and that is the honest limit
 * rather than a claim to have solved it.
 */
function unzoomWindow(socket: string[], sessionId: string, windowId: string, onlyPane?: string): boolean {
  if (!SESSION_ID.test(sessionId) || !WINDOW_ID.test(windowId)) return false;
  if (onlyPane !== undefined && !PANE_ID.test(onlyPane)) return false;
  const target = `${sessionId}:${windowId}`;
  const [flag, active] = (tmux(socket, ["display-message", "-p", "-t", target, "#{window_zoomed_flag}\t#{pane_id}"]) ?? "").trim().split("\t");
  if (flag !== "1") return false;
  if (onlyPane !== undefined && active !== onlyPane) return false;
  return tmux(socket, ["resize-pane", "-Z", "-t", target]) !== null;
}

export function attachArgvFor(
  known: string[] | undefined,
  paneId: string,
  /** Injected so a test can assert the whole command rather than a shape with
   *  a random word in it. */
  suffix = Math.random().toString(36).slice(2, 8),
  /**
   * Let the phone's size win, reflowing the window to it.
   *
   * The default (`largest`) protects the desk and shows the phone the left-hand
   * corner of a 277-column window — which for a full-screen program is border
   * and a prompt, not the thing you opened it to read. `latest` makes the
   * window the phone's size, so a TUI redraws itself to fit and you see what is
   * actually running.
   *
   * It is a choice and not a default because the cost is real: while the phone
   * is attached, a client at the desk sees the same reflow. tmux puts it back
   * when the phone detaches, and somebody looking at their phone is usually not
   * also looking at their desk — but it is their call, not ours.
   */
  fit = false,
  /** The phone's own grid, which is what `fit` resizes the window to. Ignored
   *  without `fit`; a fit without one leaves the window alone rather than
   *  guessing at a size. */
  size?: { cols: number; rows: number },
): {
  argv: string[]; cwd: string; session: string; socket: string[]; groupedWith: string;
  grid: { cols: number; rows: number } | null;
  /** The window this attach lands on. For ROUTING — finding the socket to talk
   *  to about that window — and never for truth: the phone can walk to another
   *  window with `^b n` and this will not follow it. Ask tmux for that. */
  windowId: string;
  /** `window-size` as each window of the group had it a moment before this
   *  command runs. See windowSizeOptions and restoreWindows. */
  hadWindowSize: Record<string, string>;
  /**
   * The zoom this attach is responsible for: the window, and the pane it is
   * zoomed onto. Null when there is none to be responsible for.
   *
   * "Responsible for" and not "issued", because the two differ by exactly one
   * case: a window already zoomed onto this pane needs no command and is still
   * owed back, since our being here is what keeps the previous owner's teardown
   * from running.
   *
   * The window id is repeated here rather than read off `windowId` above,
   * which is documented as routing and not truth: the way out has to be
   * addressed to the window this attach acted on, and not to wherever the phone
   * has since walked. Handed over as a pair so a caller cannot hold a window
   * from one attach and a pane from another.
   */
  zoomed: { windowId: string; paneId: string } | null;
} | null {
  if (!PANE_ID.test(paneId)) return null;
  /*
   * Exactly one server may claim this id, or nothing happens.
   *
   * Pane ids are per SERVER, not per machine, so `%1` is an ordinary id on
   * every tmux running here — and this used to take the first match across all
   * of them. It cost a real session: a caller meant `%1` on its own test
   * server, the search answered with `%1` on the developer's, and a fit resized
   * a window they were working in down to 80 columns.
   *
   * Refusing an ambiguous id is the same rule `paneloc.ts` already applies to
   * finding an agent's pane, for the same reason: acting on the wrong one of
   * two candidates is worse than not acting, because nothing afterwards looks
   * like a mistake — it looks like the machine did something odd.
   *
   * Our OWN grouped sessions do not count towards that, and leaving them in was
   * a bug with teeth. Measured on a private server: with one phone attached,
   * `list-panes -a` returns every pane of the group TWICE — once under the
   * desk's session and once under `agx-phone-…` — so this refused every pane in
   * a window a phone was already on. The take-over path walks straight into it:
   * the desk clicks, the phone is told, the phone remounts, and the attach it
   * remounts with lands while the old grouped session is still up. What the
   * phone showed for that was "that pane is gone".
   *
   * They are not two candidates. They are one pane described twice, and the
   * desk's row is the one to keep — not by preference: `groupedWith` is what
   * the teardown addresses, and a phone session dies with its client, so
   * joining one leaves the restore pointed at a session that is already gone.
   *
   * Only ours is dropped. A user who has grouped two of their own sessions
   * really does have two answers, and this still declines — that is the rule
   * above doing its job rather than an omission in this one.
   */
  const rows = listPanes(known).filter((r) => r.paneId === paneId && !PHONE_SESSION.test(r.session));
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (!SESSION_ID.test(row.sessionId) || !WINDOW_ID.test(row.windowId)) return null;

  // Ours, and recognisable as ours in `tmux ls`. No `:` or `.` — tmux uses both
  // as target separators and refuses them in a session name.
  const session = `agx-phone-${paneId.slice(1)}-${suffix.replace(/[^a-z0-9]/gi, "")}`;
  // A deliberate fit ends any hold the desk had on this window. Take-over is not
  // a lock: it ends the reflow that is happening, and somebody tapping "reflow
  // it" afterwards is the user asking for it again.
  if (fit && size) releaseClaim(row.socket, row.windowId);
  /*
   * One tab, one pane.
   *
   * tmux draws a WINDOW, and a phone attaches to a window — so a four-pane
   * window gives the phone's tab strip four tabs that are all the same 2x2
   * grid. Measured on the emulator against a 44-column client: with no zoom the
   * phone's own screen carried the first line of all four panes (PANE-A/B/C/D
   * markers, every one of them), whichever pane had been tapped. Four
   * destinations, one destination. And each of them a quarter of an already
   * narrow screen — about 40 columns, where prose breaks every three words.
   * With the zoom the same client carried the tapped pane's marker and no other.
   *
   * ON, and not a switch, and that is a decision rather than an omission. A
   * switch would have to be asked for by the phone, and this server does not
   * own the phone's code — so an off-by-default zoom is a feature nothing can
   * turn on. It is also not a choice the person tapping a pane has any way to
   * make: they tapped ONE pane, which is the request.
   *
   * The cost is real and is the same cost the fit has: zoom is a window flag
   * and a grouped session shares the window, so the desk sees it, and it does
   * not undo itself when the phone goes (measured: a window left zoomed by a
   * killed phone still reports the flag two seconds later). Both halves are
   * answered the way the fit answers them — a notice with a way out on the desk
   * (see `takeover` and the row in TerminalPanel) and a restore on the way out
   * (see `restoreWindows`).
   *
   * Not a window the desk has just taken back. Take-over unzooms, and the phone
   * is told so and remounts with `fit` off — which comes straight back through
   * here. Without this the desk's click would be undone within the second by
   * the reconnection it caused. A deliberate fit releases the claim first (the
   * line above), so the phone asking again does get its zoom back.
   *
   * "Already zoomed" is NOT a reason to stand down, and reading it as one is
   * the bug the emulator found: tapping the second tab of the same window
   * opened it with the window already zoomed by the first tab, so this sent
   * nothing — and the tab showed the 2x2 grid again, which is the whole defect
   * back for every tab but the first.
   *
   * The command sequence handles it, and only measurement says so (tmux 3.6a,
   * a three-pane window):
   *
   *   resize-pane -Z -t A            z=1  active=A
   *   select-pane  -t B              z=0  active=B   <- selecting UNZOOMS
   *   resize-pane -Z -t B            z=1  active=B
   *   ... and -Z -t B with no select first: z=0, active still A — the toggle
   *       applies to the WINDOW, so it takes the other pane's zoom off instead
   *
   * The `select-pane` above already runs before the zoom, so a window zoomed
   * onto somebody else's pane is unzoomed by it and re-zoomed onto ours. The
   * one case that must send nothing is a window already zoomed onto OUR pane —
   * a reconnect, or the same tab twice — where `select-pane` keeps the zoom
   * (measured) and a `resize-pane -Z` would take it off. It is still owed back:
   * whoever zoomed it has had its teardown skipped for as long as we are here.
   *
   * What is NOT restored is a zoom the desk had on a DIFFERENT pane: it is
   * unzoomed rather than put back, because tmux offers no way to tell a phone's
   * zoom from a person's, and showing the phone a pane it did not open is the
   * thing this exists to stop. The notice on the desk says the phone did it and
   * the button gives the window back.
   */
  const zoom = windowZoom(row.socket, row.sessionId, row.windowId);
  const worth = !!zoom && zoom.panes > 1 && !deskClaimed(row.socket, row.windowId);
  const already = !!zoom && zoom.zoomed && zoom.active === row.paneId;
  const willZoom = worth && !already;
  return {
    // A lone `;` is tmux's own command separator. One command list, in order:
    // join the group under our own name, stop the shared window following the
    // newest client, then land on the window and pane that were actually
    // tapped — a grouped session otherwise opens wherever the group last was,
    // which is whatever somebody at the desk was looking at — and last the two
    // that are conditional, the zoom and the fit. Every `-t` on an option names
    // OUR session, which is what keeps those off the desk's.
    argv: [
      "tmux", ...row.socket, "new-session", "-t", row.sessionId, "-s", session,
      /*
       * `largest` ALWAYS, even when fitting — and the switch below does the
       * fitting instead. This used to be `latest` for a fit, and that is what
       * cost somebody four windows they were not even looking at: `window-size`
       * is read per window and a grouped session shares every window in the
       * group, so "size to the newest client" sized ALL of them to the phone.
       *
       * Measured, three windows, one phone: with `latest` the group followed
       * the phone; with `largest` plus one explicit `resize-window`, the window
       * that was opened went to 80x24 and the other two stayed at 200x49.
       */
      ";", "set-option", "-t", session, "window-size", "largest",
      // Goes away when the phone does. Without it the session outlives the
      // client that made it — measured: two visits left two `agx-phone-…`
      // sessions sitting in `tmux ls` after both sockets had closed, and a tab
      // strip somebody scrolls through would leave one per tab, for good. The
      // windows are the group's and are not touched; only our view of them
      // ends.
      ";", "set-option", "-t", session, "destroy-unattached", "on",
      // The row the app's own tab strip already draws, and on a phone the
      // scarcest one there is. Session-scoped, so the desk's bar stays up.
      ";", "set-option", "-t", session, "status", "off",
      ";", "select-window", "-t", row.windowId,
      ";", "select-pane", "-t", row.paneId,
      /*
       * The zoom, in the same breath as the attach rather than as a call after
       * it. Two commands means a phone that paints the grid and then jumps,
       * and a window left zoomed by the second half of an attach whose first
       * half failed.
       *
       * `-t <pane>` and not the window: the pane that was tapped is the one to
       * zoom, and tmux zooms whichever pane the target names. The active pane
       * is a window property the desk shares, so this moves the desk's cursor —
       * but the `select-pane` on the line above already did that, and has
       * since this feature existed.
       */
      ...(willZoom ? [";", "resize-pane", "-Z", "-t", row.paneId] : []),
      /*
       * The fit, as one window and not as a policy.
       *
       * Named explicitly — `-t <this window>` — so the cost is exactly the
       * window that was opened, for exactly as long as the phone is on it.
       * `restoreWindows` puts it back with `resize-window -A`, and the
       * measurement above is that the other windows never move at all.
       *
       * It is still the desk's window being spent, which is why it is a switch
       * and not a default: tmux renders one window at one size, so a live view
       * is either the phone's shape or the computer's. There is no third
       * answer, and pretending otherwise would just hide which one was picked.
       */
      ...(fit && size
        ? [";", "resize-window", "-t", row.windowId, "-x", String(size.cols), "-y", String(size.rows)]
        : []),
    ],
    cwd: row.path,
    session,
    /*
     * How wide the window really is, which the phone cannot work out for
     * itself and has to be told.
     *
     * Without a fit, tmux goes on rendering this window at the desk's size and
     * the phone sees the left-hand N columns of it — everything past them is
     * not clipped, it never arrives. That looked to the person holding it like
     * text being cut off for no reason. Handing the number over lets the screen
     * say so, and say what the one control that changes it does.
     */
    grid: windowSize(row.socket, row.windowId),
    windowId: row.windowId,
    /* Read HERE, before the caller spawns the command above, because the
     * command itself is what changes it — a capture taken on the way out would
     * be a capture of our own footprint. */
    hadWindowSize: windowSizeOptions(row.socket, row.sessionId),
    zoomed: worth ? { windowId: row.windowId, paneId: row.paneId } : null,
    // Kept so the size can be put back when the phone lets go. See
    // `restoreWindows`, and the measurement in its comment.
    socket: row.socket,
    groupedWith: row.sessionId,
  };
}

/**
 * Put a window at the size a phone has just told us it really is.
 *
 * The fit in `attachArgvFor` runs once, with whatever geometry the client sent
 * on the query string — and a phone's FIRST number is not its real one. The
 * WebView measures itself after the page loads, so the socket opens on the
 * default 80x24 and the true size arrives a moment later on a resize frame.
 * Reported from a phone: the conversation wrapped correctly at 80 columns and
 * then stopped two thirds of the way down the screen, because the window was
 * 24 rows tall inside a terminal with room for about fifty.
 *
 * So this is called again on every resize while a fit is on. It is one tmux
 * call on a window we already resized once, and it is the difference between
 * a pane that fills the phone and one that fills a quarter of it.
 *
 * Session-qualified, never a bare window id: measured, `resize-window -t @0`
 * answers "no such window" once a grouped session shares that window, and it
 * fails silently as far as anything watching the size is concerned.
 */
export function fitWindow(socket: string[], sessionId: string, windowId: string, cols: number, rows: number): boolean {
  if (!SESSION_ID.test(sessionId) || !WINDOW_ID.test(windowId)) return false;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || rows < 4) return false;
  markPinned(socket, windowId);
  return tmux(socket, ["resize-window", "-t", `${sessionId}:${windowId}`, "-x", String(cols), "-y", String(rows)]) !== null;
}

/**
 * Write the durable "this app pinned this window's size" record, if the window
 * does not already carry one.
 *
 * `windowSizeOptions` writes it for every window of the group at attach, which
 * covers the fit that runs with the attach itself. It did not cover the fits
 * that come AFTER, and the gap is a state a machine was found in: a window at
 * `window-size manual`, 80 columns inside a 285-column terminal, with nobody
 * attached to it and no mark on it. The way there is the ordinary one — a
 * phone leaves a window, the teardown restores it and clears the mark, and a
 * resize from a socket that had not finished dying fits it again — and once
 * the mark is gone nothing can ever prove the window is ours to put back.
 *
 * So the record is written wherever the pin is, not only where the pin usually
 * starts. `resize-window` sets `window-size manual` as a side effect, so every
 * call below IS a pin.
 *
 * Only when unmarked, and that is what makes it safe to call on every fit: the
 * value being kept is what the window had before ANY of this touched it, and
 * overwriting it with `manual` half way through a phone's visit would make the
 * restore put back the squeeze instead of undoing it.
 */
function markPinned(socket: string[], windowId: string): void {
  if (!WINDOW_ID.test(windowId)) return;
  const marked = tmux(socket, ["show-options", "-qwv", "-t", windowId, HAD_SIZE]);
  if (marked === null || marked.trim()) return;
  const had = tmux(socket, ["show-options", "-qwv", "-t", windowId, "window-size"]);
  if (had === null) return;
  // Ledger, claim, then mark — the same order and for the same reasons as
  // `windowSizeOptions`. See THE PIN LEDGER.
  notePinnedSocket(socket);
  tmux(socket, ["set-option", "-w", "-t", windowId, HAD_SIZE_BY, thisRun()]);
  tmux(socket, ["set-option", "-w", "-t", windowId, HAD_SIZE, had.trim() || HAD_NOTHING]);
}

/**
 * How long a window has to be phone-free before this run puts it back.
 *
 * Not zero, and the number is the same race the teardown's 1500ms answers from
 * the other side: switching tabs on the phone closes one socket and opens the
 * next, and between them there is a moment with the window pinned and no phone
 * on it. Reclaiming inside that gap gives the desk its width back and takes it
 * away again as the next attach lands — two reflows of a full-screen program to
 * arrive back where it started.
 *
 * Two seconds is that gap with room, and it is still fast enough that a phone
 * put down in a pocket is a window back at the desk's size before anybody has
 * finished looking away.
 */
const RECLAIM_AFTER_MS = 2000;
/**
 * And how long before looking again at a narrow window that turned out not to
 * be ours.
 *
 * The mark can only be read with a tmux call, and this runs off a poll that
 * ticks twice a second per attached client. A window somebody narrowed
 * themselves stays narrow for as long as they want it to, so without a backoff
 * it would cost a spawn every couple of seconds, for ever, to be told the same
 * thing. A minute is short enough that a window that BECOMES ours — a phone
 * fitting it — is picked up while the phone is still on it.
 */
const RECHECK_MS = 60_000;
/** Per socket and window: the next moment this window is worth looking at.
 *  Cleared the moment a phone is back on it, so a tab switch cannot accumulate
 *  time towards a reclaim. */
const freeSince = new Map<string, number>();

/**
 * Put back a window this app pinned for a phone that is no longer on it.
 *
 * WHY THIS EXISTS. The teardown owes the restore and usually pays it: the
 * socket closes, and 1.5 and 3 seconds later `restoreWindows` gives the desk
 * its columns back. Three ordinary things stop that from happening, and all of
 * them leave the same wreck — a window at phone width with nobody on it:
 *
 *   the socket never closes (a phone that loses its network hands the server no
 *   FIN, so the teardown is not scheduled at all);
 *
 *   the restore runs while the phone is still attached to that window and
 *   correctly skips it — both attempts are inside three seconds, and after that
 *   nothing is watching;
 *
 *   this server was killed, or reinstalled, between the fit and the teardown.
 *
 * The boot sweep answers the third and only at a boot, and only for a mark left
 * by a run that is dead. This answers all three while the app is running, off
 * the poll the tab strip is already paying for.
 *
 * The mark is the whole of the authority. A narrow window is not evidence of
 * anything on its own — somebody who ran `resize-window -x 80` themselves has
 * exactly that, and undoing it would be this app editing a tmux somebody else
 * is driving. `@agx-had-size` says the size was taken by us and what it was
 * before, which is the same proof the boot sweep insists on.
 */
export function reclaimPinnedWindow(socket: string[], sessionId: string, windowId: string, free: boolean): boolean {
  if (!SESSION_ID.test(sessionId) || !WINDOW_ID.test(windowId)) return false;
  const key = claimKey(socket, windowId);
  if (!free) { freeSince.delete(key); return false; }
  const at = freeSince.get(key);
  if (at === undefined) { freeSince.set(key, Date.now() + RECLAIM_AFTER_MS); return false; }
  if (Date.now() < at) return false;
  const mark = tmux(socket, ["show-options", "-qwv", "-t", windowId, HAD_SIZE])?.trim();
  // Not ours, which is the commonest answer: somebody narrowed their own
  // window. Asked again in a minute rather than on the next tick — see
  // RECHECK_MS.
  if (!mark) { freeSince.set(key, Date.now() + RECHECK_MS); return false; }
  freeSince.delete(key);
  // A value this code cannot act on stops being a reason to come back.
  if (mark !== HAD_NOTHING && !WINDOW_SIZE_VALUE.test(mark)) { clearSizeMark(socket, windowId); return false; }
  const want = mark === HAD_NOTHING ? "" : mark;
  /*
   * `-A` first, the option second. Measured into `restoreWindows` and repeated
   * in the boot sweep: setting the option alone leaves the window squeezed
   * (tmux applies `window-size` when something makes it recompute, and nothing
   * has), and `resize-window` in either form writes `manual`, so the other
   * order puts the squeeze back over the restore.
   */
  tmux(socket, ["resize-window", "-A", "-t", `${sessionId}:${windowId}`]);
  tmux(socket, want
    ? ["set-option", "-w", "-t", windowId, "window-size", want]
    : ["set-option", "-uw", "-t", windowId, "window-size"]);
  clearSizeMark(socket, windowId);
  // A pane whose size ends where it started is not redrawn by tmux, and a
  // program that drew itself at 80 columns stays drawn that way.
  tmux(socket, ["refresh-client"]);
  return true;
}

/**
 * End the session this app made for a phone, now, instead of waiting for tmux
 * to notice its client has gone.
 *
 * Nothing on the ordinary path needs this. A phone's session carries
 * `destroy-unattached on`, so it goes when its client does, and the teardown in
 * `cleanup` has 1.5 and 3 seconds to spend waiting for that. The shutdown path
 * has none: it runs in a signal handler with `process.exit(0)` on the next
 * line. And waiting is exactly what the restore needs, because `restoreWindows`
 * skips any window a phone is still on — so on the way out the restore either
 * makes that condition true itself or silently does nothing.
 *
 * Measured on a private server (tmux 3.6a, `-f /dev/null`, a fitted phone on a
 * two-pane window): `kill-session` returns 0 and the very next `list-sessions`
 * — the same call `phoneWindows` makes — no longer lists it. The window is not
 * touched by this and must not be mistaken for a restore: right after the kill
 * it still read `80x24`, `window-size manual`, `window_zoomed_flag 1`. Ending
 * the session is what makes the restore ALLOWED, not what performs it.
 *
 * Only ever a name this app itself created, and that guard is why this is a
 * function rather than an inlined call: `kill-session` is the most destructive
 * command in this file, and `PHONE_SESSION` is the whole difference between
 * ending a view we made and ending the session somebody is working in.
 *
 * `=` for an exact match. tmux otherwise resolves a target name by prefix, and
 * a prefix match here would be a session we did not name. It is spelled out per
 * command rather than assumed because tmux is not consistent about it —
 * `set-option -t =name` is rejected outright (see TmuxTarget.id) — and
 * `kill-session -t =…` was measured accepting it on 3.6a rather than believed.
 */
export function endPhoneSession(socket: string[], session: string): boolean {
  if (!PHONE_SESSION.test(session)) return false;
  return tmux(socket, ["kill-session", "-t", `=${session}`]) !== null;
}

/**
 * Put the group's windows back the way the phone found them.
 *
 * `window-size latest` — what `fit` sets — is read per WINDOW, and a grouped
 * session shares every window in the group, not just the one being looked at.
 * Measured on a live desk while a phone was attached to one pane of a
 * five-window session: the four windows the desk was NOT on had all been pulled
 * down to the phone's 80 columns, and the fifth had been squeezed and let go
 * again, leaving the program inside it drawn at 80 in a 277-column pane. That
 * is the screenshot this exists because of.
 *
 * Changing the option back is not enough on its own — also measured. tmux
 * applies `window-size` when something makes it recompute, so a window already
 * squeezed stays squeezed until asked. `resize-window -A` is that ask.
 *
 * And `-A` is not enough either, which is the bug this function shipped with.
 * `resize-window` SETS `window-size manual` on the window it resizes — the
 * manpage says so and a private server confirms it — so the version of this
 * that ran `-A` and stopped left every window of the user's session pinned:
 *
 *   phone fitted                          80x24  window-size=manual
 *   `-A` on the way out                  200x49  window-size=manual
 *   desk then resizes its terminal 160x45 200x49  window-size=manual
 *
 * One phone visit and the user's own terminal stopped reflowing their tmux, on
 * every window in the session, permanently, with nothing on screen to say why.
 * So the option goes back too — AFTER the `-A`, because the `-A` is what sets
 * it, and doing them the other way round writes `manual` over the restore.
 *
 * `hadWindowSize` is what each window carried before the phone's command ran
 * (see `windowSizeOptions`); an empty string means the window had none of its
 * own and the restore is an unset. Only those windows are touched: they are the
 * ones that existed when the phone arrived, and `-A`ing a window we have no
 * record of would cost it its `window-size` to fix a squeeze it never had.
 *
 * Called on the way out rather than trusted to happen: our session dies with
 * the client (`destroy-unattached on`), and a window whose only small client
 * has gone still holds the small size until somebody recomputes it.
 *
 * The zoom is the second thing owed back and the reason this is no longer
 * called `restoreWindowSizes`. A zoom is not a size — it is a window flag, it
 * belongs to the shared window exactly as `window-size` does, and it outlives
 * the phone in exactly the same way: measured on a private server, a window a
 * phone zoomed still reports `window_zoomed_flag` 1 with the phone's client
 * killed and its session gone. `zoomed` names the one window this attach is
 * responsible for and the pane it is zoomed onto, so nothing else is touched.
 */
export function restoreWindows(
  socket: string[], sessionId: string, hadWindowSize: Record<string, string>,
  /** What `attachArgvFor` zoomed, straight from the object it returned. */
  zoomed?: { windowId: string; paneId: string } | null,
): void {
  if (!SESSION_ID.test(sessionId)) return;
  /*
   * Not a window another phone is still on, and this is why `fit` appeared to
   * do nothing at all.
   *
   * Turning the switch tears the old socket down and opens a new one, in that
   * order but not atomically: the new session resized the window to the phone,
   * and 300ms later the OLD session's teardown ran `resize-window -A` over
   * every window in the group and undid it. Measured — the window went to
   * 72x30 and came back to 220 on its own, which from the phone is a switch
   * that does nothing.
   *
   * So a window with a phone still on it is left alone. That is the same
   * question `phoneWindows` already answers, asked at the one moment it
   * decides something.
   */
  const busy = phoneWindows(socket);
  for (const [id, had] of Object.entries(hadWindowSize)) {
    if (!WINDOW_ID.test(id) || busy.has(id)) continue;
    /*
     * And not a window the desk has just taken back, which is the same race
     * from the other end and it costs both commands, not just the option.
     *
     * Measured, take-over then this teardown on the same window: `-A` alone
     * turned the `largest` the desk asked for back into `manual` (so the desk
     * stops reflowing — the very bug above), and putting the captured value
     * back on top of that dropped the window to 80x24 with the phone still
     * attached. The plan for this said `-A` was idempotent with take-over; the
     * probe says it is not, so the whole window is skipped.
     */
    if (deskClaimed(socket, id)) continue;
    /*
     * The zoom comes off inside this loop, and that is the point of it being
     * here: the two skips above are the two skips a zoom needs and they are now
     * literally the same code rather than a copy that can drift. A window
     * another phone is still on keeps the zoom that phone is relying on; a
     * window the desk has taken back has already been unzoomed by the take-over
     * itself, and touching it again is how the width restore used to hand the
     * window straight back.
     *
     * `zoomed.windowId` is always one of these keys — `windowSizeOptions` lists
     * every window of the session this attach joined, and the window it zoomed
     * is one of them, both read in the same breath in `attachArgvFor`.
     *
     * Before the `-A`, so the window is recomputed once, with the layout it is
     * going to keep.
     */
    /*
     * What the window carries NOW, against what was recorded when this phone
     * arrived. Three answers, and only one of them is a restore (#488).
     *
     * `hadWindowSize` lists every window of the group, because a phone's
     * grouped session shares them all — but the phone only ever MOVED the one
     * it fitted. Walking the rest was writing a snapshot over windows nothing
     * had touched, and the snapshot ages: measured, a desk that pressed "Fit to
     * this window" after the phone arrived had its deliberate `manual` replaced
     * by the `largest` this record was taken with, minutes later, by a teardown
     * for a window the phone was never on.
     *
     * `show-options -qwv` answers empty for a window option that is not set,
     * rather than the inherited value — measured on 3.7b — so "" here really is
     * "this window carries none of its own", which is what `had` spells the
     * same way.
     */
    const now = (tmux(socket, ["show-options", "-qwv", "-t", id, "window-size"]) ?? "").trim();
    // Already where it belongs. Nothing to put back, and nothing owed, so the
    // mark comes off rather than inviting a later pass to act on it.
    if (now === (had ?? "")) { clearSizeMark(socket, id); continue; }
    /*
     * Not a value this app leaves behind, so not this app's to overwrite.
     *
     * The only two we ever write are `manual` (a fit, via `resize-window`) and
     * `largest` (the attach, and the desk's take-over). Anything else — a
     * `latest`, a `smallest`, a value somebody set by hand while the phone was
     * here — is a deliberate act by somebody who is not us, and putting an old
     * snapshot over it is the same class of mistake as the stale restore above.
     * The mark stays: the window is still one we touched, and a later pass can
     * decide with fresher information than this teardown has.
     */
    if (now !== "manual" && now !== "largest") continue;
    if (zoomed && zoomed.windowId === id) unzoomWindow(socket, sessionId, id, zoomed.paneId);
    tmux(socket, ["resize-window", "-A", "-t", id]);
    tmux(socket, had
      ? ["set-option", "-w", "-t", id, "window-size", had]
      : ["set-option", "-uw", "-t", id, "window-size"]);
    /*
     * And the durable copy of the same answer, now that it has been used.
     *
     * Last, after both commands: a mark taken off before the restore ran would
     * leave a window still pinned and no longer marked — the one state the
     * startup sweep can never fix, and strictly worse than the bug.
     *
     * Only for windows this loop actually restored. The `continue`s above
     * leave the mark deliberately: a window another phone is still on is still
     * owed the restore, and leaving the mark is what lets the next boot finish
     * the job if that phone's server is the one that gets killed.
     *
     * And only when the restore WORKED, which is the other half of #488. This
     * used to clear unconditionally, so a restore that put back the wrong value
     * — or none at all, because tmux refused the command — destroyed the only
     * evidence that the window was ever ours. `reclaimPinnedWindow` reads that
     * mark and nothing else; without it the safety net cannot fire on the one
     * case that needs it, which is a teardown that has already gone wrong. The
     * two bugs are invisible from each other's code and were found together.
     *
     * Verified by reading the option back rather than by trusting the write:
     * `tmux()` returning non-null means the command was accepted, not that the
     * value took.
     */
    const after = (tmux(socket, ["show-options", "-qwv", "-t", id, "window-size"]) ?? "").trim();
    if (after === (had ?? "")) clearSizeMark(socket, id);
  }
  // And make the desk repaint. A program that was resized twice has drawn
  // itself for the wrong width in between, and tmux does not redraw a pane
  // whose size ends up where it started — which is exactly this case.
  tmux(socket, ["refresh-client"]);
}

/** Servers whose leftover marks this process has already dealt with. Separate
 *  from `swept`, which guards the status line: sharing one set would let a boot
 *  sweep cancel the status-line release that runs on first client contact. */
const sizeSwept = new Set<string>();

/**
 * Put back every `window-size` a previous run of this app took and was killed
 * before returning — at STARTUP, which is the only moment that survives SIGKILL.
 *
 * THE HOLE THIS FILLS. `restoreWindows` is correct and is reached from three
 * places: the socket closing, `cleanup`'s two timers, and `shutdownTerminals`
 * on SIGINT/SIGTERM. Every one of them is code running inside the server. A
 * SIGKILL, an OOM kill, or the machine going down runs none of it, and the
 * `window-size manual` that a phone's fit writes onto the DESK'S window then
 * lasts as long as that tmux server does.
 *
 * It is not theoretical. Reported with a screenshot after the app had been
 * killed hard several times in one day — one window of a five-window session
 * stuck with a gap along the bottom:
 *
 *   work:2  agent-a  267x59  window-size=latest
 *   work:3  agent-b  267x59  window-size=latest
 *   work:4  agent-c  267x59  window-size=latest
 *   work:5  agent-d  277x54  window-size=manual   <- the only one
 *   work:6  agent-e  267x59  window-size=latest
 *
 * 54 rows against a 59-row client: those five rows ARE the gap. The window had
 * stopped following the terminal it was drawn in, permanently, and nothing
 * anywhere pointed at the app that had done it.
 *
 * WHAT PROVES A SERVER IS OURS TO WALK, asked before any of what follows and
 * answered without consulting NODE_ENV: the pin ledger, which this installation
 * writes at the instant it takes a window's size. No record, no walk — not even
 * a `list-windows`. That is what stops a server spawned by `make soak`, `make
 * perf` or `make loadtest` from reaching the developer's own sockets, and it is
 * the level the two previous fixes for this (a `bun test` guard, then a lint
 * over the test roots) were both aimed below. See THE PIN LEDGER above for what
 * it covers and what it does not.
 *
 * WHAT PROVES A WINDOW IS OURS, since the alternative is undoing somebody's own
 * setting. Only the `@agx-had-size` mark, written in `windowSizeOptions` at the
 * moment of capture and nowhere else. tmux neither sets nor reads user options,
 * so a window carrying one carries it because this file put it there.
 *
 * Three further narrowings, each closing a way to be wrong:
 *
 *  - A window a live phone is on is skipped. That is `phoneWindows`, the same
 *    question `restoreWindows` asks, and it is what keeps a second agentglass
 *    server booting on this machine from tearing down a phone session that is
 *    mid-sentence.
 *  - A window whose `window-size` ALREADY equals the recorded value is not
 *    touched at all — the mark is simply removed. Nothing is owed there, and
 *    the `resize-window -A` a blind restore would run is itself a visible
 *    change: `-A` sizes the window to the largest attached client and, per the
 *    manpage and the probe, writes `manual` while doing it.
 *  - A mark holding anything but one of tmux's four legal values is removed and
 *    obeyed by nothing.
 *
 * AND WHAT WOULD STILL MAKE IT WRONG, stated rather than papered over: a user
 * who sets `window-size manual` BY HAND on a window that is carrying a mark
 * from an earlier phone visit. The next boot would put their value back to what
 * the phone found. The two deliberate paths inside the app — the panel's `fit`
 * button and `takeover`, which are how a `manual` gets set on purpose here —
 * drop the mark as they write, so this is narrowed to a `set-option` typed into
 * tmux itself. Window ids cannot make it worse: measured on 3.6a, killing `@1`
 * and creating two windows gave `@2` and `@3`, so a mark cannot be inherited by
 * a different window on the same server.
 *
 * ONCE PER SERVER. At the moment this runs no phone in THIS process has
 * attached to anything, so every mark it can see belongs to a run that is gone
 * — the same "stale by definition" argument `releaseStale` makes, at the same
 * point in the lifecycle. Both entry points share `sizeSwept`, so a server
 * reached at boot is not walked again when a panel first resolves a client on
 * it.
 *
 * Cost, measured on this machine against a private server holding an 8-window
 * session: 2.4ms for the whole walk when no window carries a mark, which is
 * every boot after a clean shutdown and is one `list-windows -a` and nothing
 * else. 28.3ms in the worst case measured — all eight marked, one of them
 * actually pinned — and that is the run that happens once, after a kill.
 */
export function sweepPinnedWindows(sockets: string[][]): number {
  /*
   * The second door into this, and the one `tmuxSockets` cannot close:
   * `releaseStale` calls it with a socket read off a tmux client in /proc, not
   * with a discovered one. Under `bun test` there is no window-size sweep worth
   * doing on a socket nobody named — every test that means to exercise this
   * one sets TMUX_TMPDIR (tmux-sigkill-restore, tmux-shutdown-restore) — so the
   * whole function stands down rather than the directory walk alone.
   *
   * Before `sizeSwept.add` on purpose: a run that was refused has not swept
   * anything, and must not be recorded as having done so — otherwise a test
   * that sets TMUX_TMPDIR later in the same process would find the socket
   * already ticked off and silently assert on a sweep that never ran.
   */
  if (blindTmuxBanned()) return 0;
  /*
   * Read once for the whole walk, and it is the guard that does not depend on
   * NODE_ENV — the reason a script's server, which `blindTmuxBanned` waves
   * straight through on its first line, now touches nothing. See THE PIN
   * LEDGER: a socket this installation has no record of pinning on is one it
   * cannot prove anything about, and the sweep's only business is undoing what
   * it left behind.
   *
   * The caller normally hands over `pinnedSockets()`, which is built from this
   * same file, so the check looks redundant from `index.ts`. It is not: the
   * other door into here is `releaseStale`, which passes a socket read off a
   * tmux client in /proc — on this machine, /proc has his tmux in it — and that
   * caller cannot be asked to remember. Both doors, one rule.
   */
  const ledger = new Set(pinLedger().map(sameSocket));
  if (!ledger.size) return 0;
  let restored = 0;
  for (const socket of sockets) {
    const key = socketPath(socket);
    /*
     * Every refusal BEFORE `sizeSwept`, for the reason spelled out above
     * `blindTmuxBanned`: a socket that was refused has not been swept, and
     * recording it as swept silently retires the real one.
     *
     * `tmuxSocketAllowed` and `tmuxSocketConfined` are asked here even though
     * `tmux()` asks them again — that is the same question, and asking it in
     * the wrong place is a bug this test caught rather than a hypothetical.
     * With the confinement check only inside `tmux()`, the walk below marked
     * the socket swept and THEN had every command refused: the run consumed the
     * server's one sweep without touching it, so the next caller — the panel
     * resolving a client on a socket that had since come into range — skipped
     * it for the life of the process. Measured as a red test: `refused even
     * with a record` passed, and the very next test, the same socket now inside
     * TMUX_TMPDIR, restored 0 windows instead of 1.
     */
    if (!pinnedHere(socket, ledger)) continue;
    if (!tmuxSocketAllowed(socket) || !tmuxSocketConfined(socket)) continue;
    if (sizeSwept.has(key)) continue;
    sizeSwept.add(key);
    /*
     * One call for the whole server, and the fields are chosen so the common
     * case costs exactly this and no more.
     *
     * `-a` repeats a window once per session that shares it — measured, a
     * grouped pair listed `@0 @2 @3` twice — so the rows are deduped by window
     * id. The session name rides along to qualify the target with a session
     * that is not one of ours, the way `fitWindow` does.
     */
    const out = tmux(socket, ["list-windows", "-a", "-F", `#{session_id}\t#{session_name}\t#{window_id}\t#{${HAD_SIZE}}`]);
    if (!out) continue;
    const marked = new Map<string, { session: string; mark: string; phone: boolean }>();
    for (const line of out.split("\n")) {
      const [sessionId, name, id, mark] = line.split("\t");
      if (!id || !WINDOW_ID.test(id) || !sessionId || !SESSION_ID.test(sessionId)) continue;
      const m = (mark ?? "").trim();
      if (!m) continue;
      // A phone's own session is the worst target there is: it dies with its
      // client, and on this path that client is long gone. So a row from one is
      // kept only until a row from anything else turns up.
      const phone = PHONE_SESSION.test(name ?? "");
      const prev = marked.get(id);
      if (prev && (phone || !prev.phone)) continue;
      marked.set(id, { session: sessionId, mark: m, phone });
    }
    if (!marked.size) continue;
    const busy = phoneWindows(socket);
    let here = 0;
    for (const [id, { session, mark }] of marked) {
      if (busy.has(id)) continue;
      /*
       * The mark has to be ON THIS WINDOW, and the format above cannot tell.
       *
       * Measured, and it would have been the bug this whole change exists to
       * avoid: `set-option -gw @agx-had-size none` makes `#{@agx-had-size}`
       * resolve to `none` for EVERY window on the server, because a format
       * reads the effective value. The sweep would then claim every window it
       * can see, put `window-size` back on windows it never touched — and never
       * stop, since `set-option -uw` cannot clear a global, so it would do it
       * again at every boot for the life of that config.
       *
       * `show-options -qwv` is the one that answers the right question:
       * measured on the same server, it returns empty for a window that only
       * inherits the global and the literal value for one that carries it. That
       * is the same local-versus-effective distinction `windowSizeOptions`
       * makes for `window-size`, and for the same reason.
       *
       * `-q` is not optional: without it, a user option that is not set exits 1
       * ("invalid option") and `tmux()` hands back null, which this reads as a
       * window that has gone away.
       *
       * The capture side deliberately does NOT pay for this check — it reads
       * the mark out of the `list-windows` format it was already running. The
       * asymmetry is on purpose: there, a global mark means the durable record
       * is not written and the SIGKILL recovery simply does not happen, which
       * is where this feature started. Here it means writing on windows that
       * were never ours. Only one of those is worth a spawn per window.
       */
      const own = tmux(socket, ["show-options", "-qwv", "-t", id, HAD_SIZE]);
      if (own === null || own.trim() !== mark) continue;
      /*
       * Somebody else's, and still theirs.
       *
       * The "stale by definition" argument above holds for a mark left by a run
       * that is GONE, and only for that. A second server booting while a first
       * one is mid-attach sees a window that is marked and not yet in
       * `phoneWindows` — measured on a private server, and it stripped the mark
       * — so the claim written beside the mark is what tells the two apart.
       *
       * A dead claimant falls through and the window is put back, which is the
       * whole point of the sweep. `HAD_SIZE_BY` missing also falls through: a
       * mark from before this option existed is exactly the stale one, and
       * refusing to act on it would strand every window an older build pinned.
       */
      const claim = tmux(socket, ["show-options", "-qwv", "-t", id, HAD_SIZE_BY])?.trim();
      if (claim && claimAlive(claim)) continue;
      // The mark comes off whatever happens below, so a value this code cannot
      // act on stops being a reason to come back here every boot for ever.
      if (mark !== HAD_NOTHING && !WINDOW_SIZE_VALUE.test(mark)) { clearSizeMark(socket, id); continue; }
      const want = mark === HAD_NOTHING ? "" : mark;
      const now = tmux(socket, ["show-options", "-wv", "-t", id, "window-size"]);
      if (now === null) continue; // the window went away; nothing to put back
      if (now.trim() !== want) {
        /*
         * `-A` first and the option second, which is the order the fix to
         * `restoreWindows` was measured into and it is the same trap here:
         * changing the option alone leaves a window that is still squeezed
         * (tmux applies `window-size` when something makes it recompute, and
         * nothing has), and `resize-window` in either form SETS `manual`, so
         * doing them the other way round writes `manual` over the restore.
         *
         * Session-qualified, never a bare id. The bare form measured fine on a
         * server with no clients attached, which is not the state this runs in
         * — the desk's client is up — and `fitWindow` carries a measurement of
         * a bare id failing silently against a shared window. Silently is the
         * word that decides it.
         */
        tmux(socket, ["resize-window", "-A", "-t", `${session}:${id}`]);
        tmux(socket, want
          ? ["set-option", "-w", "-t", id, "window-size", want]
          : ["set-option", "-uw", "-t", id, "window-size"]);
        here++;
      }
      clearSizeMark(socket, id);
    }
    // The same repaint `restoreWindows` ends with, for the same measured
    // reason: a pane whose size ends where it started is not redrawn by tmux,
    // and a program that drew itself at 80 columns stays drawn that way.
    // Counted per SERVER — a `refresh-client` sent to a socket this pass did
    // nothing on is a repaint charged to somebody else's session.
    if (here) tmux(socket, ["refresh-client"]);
    restored += here;
  }
  return restored;
}

/**
 * Which windows on this server a phone is looking at right now.
 *
 * The desk has no other way to know. A phone joins as its own grouped session
 * and shares the window, so from the desk it is invisible until something it
 * did — a reflow, a moved cursor, a pane that scrolled on its own — shows up
 * with nothing to attribute it to. The name carries the pane id, so no extra
 * bookkeeping is needed: what tmux already knows is enough.
 *
 * Attached only. A session left behind by a phone that lost its network is not
 * somebody looking, and marking it would make the mark mean nothing.
 */
export function phoneWindows(socket: string[]): Set<string> {
  const windows = new Set<string>();
  const live = attachedSessions(socket);
  const phones = [...live].filter((name) => PHONE_SESSION.test(name));
  if (!phones.length) return windows;
  /*
   * Each phone asked WHERE IT IS, rather than worked out from the pane id in
   * its own name — and the two obvious ways of doing that both answer wrongly.
   *
   * Measured against a two-window session with one grouped session beside it:
   * `list-panes -a` reported `%1 @1` TWICE and never mentioned `%0`, because
   * grouped sessions share their windows and the walk repeats some and misses
   * others. `display-message -t %0` came back empty for the same reason.
   * Asking the phone's own session answers exactly, in one call, and follows it
   * if it moves to another window — which is the behaviour actually wanted and
   * which neither of the others would have given.
   *
   * A mark that is right about half the windows is worse than no mark, because
   * the half it is wrong about is invisible.
   */
  for (const session of phones) {
    const window = tmux(socket, ["display-message", "-p", "-t", session, "#{window_id}"])?.trim();
    if (window && WINDOW_ID.test(window)) windows.add(window);
  }
  return windows;
}
