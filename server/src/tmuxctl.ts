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
import { readFileSync, readlinkSync } from "node:fs";
import type { TmuxWindow } from "../../shared/types.ts";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parsePanes, PANE_FORMAT, type PaneRow } from "./paneloc.ts";

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
 */
export function tmuxClientPid(pid: number, depth = 0): number | null {
  if (process.platform !== "linux" || depth > 4) return null;
  let children: string[];
  try {
    // `children` needs CONFIG_PROC_CHILDREN; when absent this reads empty and
    // we report no tmux, rather than throwing.
    children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
  } catch { return null; }
  for (const c of children) {
    let comm: string;
    try { comm = readFileSync(`/proc/${c}/comm`, "utf8").trim(); } catch { continue; }
    if (comm === "tmux" || comm.startsWith("tmux")) return Number(c);
    const deeper = tmuxClientPid(Number(c), depth + 1);
    if (deeper) return deeper;
  }
  return null;
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

/** Run a tmux command against a specific server. stdout only; a failure is a
 *  null, never a throw, because every caller is inside a poll. */
function tmux(socket: string[], args: string[]): string | null {
  try {
    const r = Bun.spawnSync(["tmux", ...socket, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: TMUX_TIMEOUT_MS,
      env: process.env,
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
    const [id, index, name, active, flags] = line.split("\t");
    const i = Number(index);
    if (!WINDOW_ID.test(id ?? "") || !Number.isInteger(i)) continue;
    windows.push({ id: id!, index: i, name: name ?? "", active: active === "1", flags: (flags ?? "").trim() });
  }
  return windows;
}

export interface TmuxFrame {
  target: TmuxTarget;
  windows: TmuxWindow[];
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
    "list-clients", "-F", "c\t#{client_tty}\t#{session_name}\t#{session_id}",
    ";",
    "list-windows", "-a",
    "-F", "w\t#{session_id}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_raw_flags}",
  ]);
  if (!out) return null;
  const f = parseFrame(out, c.tty);
  return f ? { target: { pid: c.pid, socket: c.socket, session: f.session, id: f.id }, windows: f.windows } : null;
}

/**
 * Pick our client's session out of the server's answer, and its windows out of
 * every session's windows.
 *
 * Windows are filtered by session id and not by anything friendlier: session
 * *names* are not unique enough to bet a `kill-window` on — resurrect happily
 * restores a second session called `main` — and the id is what tmux itself uses.
 */
export function parseFrame(out: string, tty: string): { session: string; id: string; windows: TmuxWindow[] } | null {
  let session: string | null = null;
  let id: string | null = null;
  const windowRows: string[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("c\t")) {
      const [, clientTty, name, sid] = line.split("\t");
      if (clientTty === tty && name && sid) { session = name; id = sid; }
    } else if (line.startsWith("w\t")) {
      windowRows.push(line);
    }
  }
  if (!session || !id) return null;
  const mine = windowRows
    .filter((r) => r.startsWith(`w\t${id}\t`))
    // Drop the tag and the session id; what is left is what parseWindows reads.
    .map((r) => r.split("\t").slice(2).join("\t"));
  return { session, id, windows: parseWindows(mine.join("\n")) };
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
 * the same four. That matters because the terminal is already the widest thing
 * this server hands out, and "the panel can run arbitrary tmux commands" would
 * quietly widen it further.
 */
export type TmuxAction = "select" | "new" | "kill" | "rename";

/** Window names are echoed back into a shell prompt and a status line, so they
 *  are held to printable, single-line, and short. tmux itself is happy with far
 *  worse, which is exactly why this is checked here. */
export const sanitizeWindowName = (s: unknown): string | null => {
  if (typeof s !== "string") return null;
  const name = s.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
  return name || null;
};

export function runAction(t: TmuxTarget, action: TmuxAction, window?: string, name?: string): boolean {
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
 * Taking it over used to mean `status off`, which is not the same thing as
 * taking it over — it is removing it, and tmux still needs somewhere to put a
 * prompt. With no status row allocated, `prefix ,`, `prefix .`, `prefix :` and
 * every `display-message` (continuum's "Tmux environment saved!", say) are
 * drawn *over the top line of the shell*, because that is the row where the
 * status line would have been. The pane's own content is untouched underneath
 * and comes back when the message clears, so nothing is lost — it just looks
 * like the terminal is being scribbled on, and the line you were reading is
 * gone while you answer.
 *
 * So the row is blanked rather than removed: `status on` with an empty
 * `status-format[0]`, styled in the terminal's own default colours so an empty
 * bar is invisible against the panel. tmux keeps a row it can draw prompts and
 * messages into, the tab strip stays the only window list on screen, and the
 * shell keeps every line it had. The cost is honest and small: one row, which
 * is what the status line was costing anyway.
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
 */
export function newWindowRunning(t: TmuxTarget, cwd: string, name: string, argv: string[]): boolean {
  const clean = sanitizeWindowName(name);
  return tmux(t.socket, [
    "new-window", "-t", t.id, "-c", cwd,
    ...(clean ? ["-n", clean] : []),
    ...argv,
  ]) !== null;
}

export function setStatusLine(t: TmuxTarget, visible: boolean): boolean {
  if (visible) {
    // Give everything back, and do not stop at the first failure: a session that
    // kept `status-format[0]` blank because `status` failed to restore is a
    // session with an invisible status line and no way to know why.
    return BORROWED.map((opt) => tmux(t.socket, ["set-option", "-t", t.id, "-u", opt]) !== null).every(Boolean);
  }
  // Nothing to borrow from someone whose config runs without one. They already
  // live with prompts drawing over their shell in every other terminal they
  // use, and adding a row here would be the panel deciding it knows better.
  if (statusInConfig(t) === "off") return false;
  const set = (opt: string, val: string) => tmux(t.socket, ["set-option", "-t", t.id, opt, val]) !== null;
  const on = set("status", "on");
  // `bg=default` is the terminal's background, which is the panel's background,
  // so the row reads as part of the app rather than as a bar with nothing in it.
  const styled = set("status-style", "bg=default,fg=default");
  const blank = set("status-format[0]", "");
  // The blanking is the part that matters; if it took, we borrowed the bar and
  // the caller must remember to give it back.
  return blank && (on || styled);
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
  const dir = join(process.env.TMUX_TMPDIR || tmpdir(), `tmux-${process.getuid?.() ?? 0}`);
  // Normalised to a path, always. A client can name its server three ways — no
  // flag (the default socket), `-L name`, `-S path` — and they can all be the
  // SAME server. Adding the known client's spelling alongside the directory
  // listing put that server in the list twice, and every pane on it came back
  // twice with it. tmux resolves all three to a file in this directory, so
  // resolving them here is what makes "the same server" one entry.
  const pathOf = (args: string[]): string => {
    const i = args.indexOf("-S");
    if (i >= 0 && args[i + 1]) return args[i + 1]!;
    const l = args.indexOf("-L");
    if (l >= 0 && args[l + 1]) return join(dir, args[l + 1]!);
    return join(dir, "default");
  };

  let found: string[] = [];
  try { found = readdirSync(dir).map((n) => join(dir, n)); }
  catch { /* no socket directory: no tmux has ever run here */ }

  // The known client's server first when there is one — it is demonstrably the
  // one the user is on, so its panes are the likeliest match — and then the
  // rest, each once.
  const first = known ? pathOf(known) : null;
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
export function listPanes(known?: string[]): (PaneRow & { socket: string[] })[] {
  const rows: (PaneRow & { socket: string[] })[] = [];
  for (const socket of tmuxSockets(known)) {
    // Only servers somebody is attached to. "Take me there" means nothing on a
    // server nobody is looking at, and skipping them is not a nicety: this
    // project's own test suite leaves a tmux server behind on a stray socket,
    // and a resurrect/continuum config then restores the user's real sessions
    // into it — so an unattached server can be a convincing duplicate of the
    // one you actually work in, with different pane ids. Offering those was
    // offering to move a window nobody would see move.
    if (!tmux(socket, ["list-clients", "-F", "#{client_tty}"])?.trim()) continue;
    const out = tmux(socket, ["list-panes", "-a", "-F", PANE_FORMAT]);
    if (out) rows.push(...parsePanes(out).map((r) => ({ ...r, socket })));
  }
  return rows;
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

/** Find the server holding this pane, then go there. The socket is never sent
 *  to the client and never accepted from it — a filesystem path from the UI is
 *  exactly what must not reach a spawn. */
export function focusPaneAnywhere(known: string[] | undefined, sessionId: string, windowId: string, paneId: string): boolean {
  if (!PANE_ID.test(paneId)) return false;
  const row = listPanes(known).find((r) => r.paneId === paneId);
  return row ? focusPane(row.socket, sessionId, windowId, paneId) : false;
}
