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
      // After the current window rather than at the end, which is where `^b c`
      // puts it when `renumber-windows` is on and where the eye expects it.
      return tmux(t.socket, ["new-window", "-a", "-t", t.id]) !== null;
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

/**
 * Hide or restore tmux's own status line for this session.
 *
 * Opt-in, and it has to be: `status` is a session option, not a client one, so a
 * second client attached to the same session from a real terminal loses its
 * status line too. Nobody should have that happen to them because they opened a
 * panel. `set-option -u` puts it back exactly as their config had it, rather
 * than guessing at "on".
 */
export function setStatusLine(t: TmuxTarget, visible: boolean): boolean {
  const args = visible
    ? ["set-option", "-t", t.id, "-u", "status"]
    : ["set-option", "-t", t.id, "status", "off"];
  return tmux(t.socket, args) !== null;
}
