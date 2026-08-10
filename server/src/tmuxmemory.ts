/*
 * Which tmux server this app was last working in, remembered across restarts.
 *
 * The reason is a complaint with a repro: close agentglass, reopen it, and the
 * session you were in is not on offer — you have to go to a terminal outside
 * the app and `tmux attach -t <name>` before it will show you anything. After
 * a rebuild, every time.
 *
 * It is self-inflicted, and it takes two losses to happen. The panel's client
 * is usually the ONLY client on that server, so closing the app detaches the
 * session; `listPanes` then skips any server with no client at all, so the
 * session agentglass just put down is the one it refuses to show. And
 * `lastTarget` — the only place the socket was ever written — lives in a module
 * variable, so it dies with the process: on the next run the app does not even
 * know which of the machine's tmux servers was yours.
 *
 * This fixes the second loss, which is what makes the first one fixable: a
 * socket we were demonstrably attached to is not a stray, whatever the client
 * count says now. The filter it lets through is doing a real job otherwise —
 * this project's own suite leaves servers behind on scratch sockets, and a
 * resurrect config restores real sessions into them, so an unattached server
 * CAN be a convincing duplicate of the one you work in. The rule is not "show
 * every detached server"; it is "a server this app has used is one it may
 * still see".
 *
 * Nothing here touches the user's tmux. It is a file of our own, next to the
 * rest of our settings, and deleting it costs a session's memory and nothing
 * else.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Same rule the config, the theme sync and the database follow: under
 * `bun test` the real file is off limits, whatever the import order was. A
 * suite that redirects XDG_CONFIG_HOME at a scratch directory gets exactly
 * what it wrote there, and every other read is "nothing remembered".
 *
 * Written as a check per call rather than a constant, because a test sets the
 * variable after this module has been imported.
 */
const offLimits = (p: string): boolean => {
  if (process.env.NODE_ENV !== "test") return false;
  const scratch = tmpdir();
  return p !== scratch && !p.startsWith(scratch + "/");
};

export function memoryPath(): string {
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "agentglass",
    "tmux-last.json",
  );
}

/** What is worth keeping: the server, and the session that was on screen. */
export interface Remembered {
  /** The socket path, always resolved — `-S <path>`. `-L name` and the path it
   *  means are the same server, and only one of the two spellings can be
   *  compared, so the path is what is stored. */
  socket: string;
  /** The session's name, for saying WHICH session is waiting. Names can be
   *  renamed and reused, so this is a label rather than an address: what is
   *  reopened is looked up live. */
  session: string;
  /** When, so a socket from months ago can be treated as the guess it is. */
  at: number;
}

/** How long a remembered socket is worth trusting.
 *
 *  A socket path is reused: /tmp/tmux-1000/default is that name for ever, and
 *  the server behind it today is not the one from a fortnight ago. A week is
 *  long enough to cover a machine that is off over a holiday and short enough
 *  that a stale path stops being offered on its own. */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function remember(socketPath: string, session: string, at = Date.now()): void {
  if (!socketPath) return; // the default socket resolved to nothing: nothing to keep
  const p = memoryPath();
  if (offLimits(p)) return;
  try {
    mkdirSync(dirname(p), { recursive: true });
    const next: Remembered = { socket: socketPath, session, at };
    writeFileSync(p, JSON.stringify(next, null, 2) + "\n");
  } catch { /* a memory we could not write is a memory we do without */ }
}

/**
 * What was remembered, or null.
 *
 * Null for anything malformed, absent or older than STALE_AFTER_MS. Every
 * caller of this treats null as "we have never been anywhere", which is the
 * behaviour this app had before the file existed — so a corrupt file costs the
 * feature and never the run.
 */
export function recall(now = Date.now()): Remembered | null {
  const p = memoryPath();
  if (offLimits(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<Remembered>;
    if (typeof raw.socket !== "string" || !raw.socket) return null;
    if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return null;
    if (now - raw.at > STALE_AFTER_MS) return null;
    return { socket: raw.socket, session: typeof raw.session === "string" ? raw.session : "", at: raw.at };
  } catch { return null; }
}
