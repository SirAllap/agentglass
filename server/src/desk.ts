/**
 * The desk's key: what lets a held call go, where the desktop app started this
 * server.
 *
 * Every other credential a release can present, the process being held can
 * read. The machine token is a 0600 file of this user's and a variable in every
 * environment the app starts; an Origin is a header anybody can set. So the
 * desktop app mints a key for each sidecar, keeps it in memory, and hands it to
 * the sidecar it spawns down a pipe — never the environment or argv, which any
 * process of this user reads in /proc — and to its own renderer through the
 * preload. `AGENTGLASS_DESK_FD=<fd>:<pid>` names only the descriptor, and only
 * for a server whose parent is that pid: Bun gives its children the environment
 * it started with whatever `delete process.env` says, so every terminal and
 * agent this server starts inherits the variable, and a server started by hand
 * from one of them must not wait on a descriptor that is no desk's.
 *
 * Read synchronously, and in the second module index.ts imports, so the pipe
 * is drained and closed before anything this process starts could be holding
 * it. Measured, Bun passed it to none of the children it spawned (Bun.spawn,
 * spawnSync, execSync); this is for a child started any other way, which would
 * inherit it and could read the key first. The desktop app writes the key and
 * closes its end as it spawns the server, so the read ends at once; a desk that
 * died first closes it too, and the key is then empty — a server that refuses a
 * released hold rather than one that falls back to trusting an Origin.
 *
 * Its ceiling: a process that can read another's memory reads this too —
 * `kernel.yama.ptrace_scope=0`, root, a core dump kept where this user can read
 * it, or the renderer's debugging port when AGENTGLASS_DEBUG_PORT is set — and
 * so does a script running in the app's own window. It answers the Origin
 * forgery; the device store, the other way in, is held in memory (devices.ts).
 * And a server started by hand has no desk, so the Origin rule
 * and its limit stand there (mayReleaseAHold in index.ts).
 */
import { closeSync, readFileSync } from "node:fs";

const named = /^(\d+):(\d+)$/.exec(process.env.AGENTGLASS_DESK_FD?.trim() ?? "");

/** This server was started by the desktop app, key or no key. */
export const DESK_STARTED = !!named && Number(named[2]) === process.ppid;

let key = "";
if (DESK_STARTED) {
  const fd = Number(named![1]);
  try { key = readFileSync(fd, "utf8").trim(); } catch { /* an unreadable pipe is an empty one */ }
  try { closeSync(fd); } catch { /* already closed */ }
  if (!key) {
    console.error("[agentglass] the desktop app started this server and sent no key: a held call can be "
      + "released from a paired device only until it is restarted");
  }
}

/** The key, or "" where there is none. */
export const deskKey = (): string => key;

/** The header the desktop app's renderer carries it in. */
export const DESK_HEADER = "x-agentglass-desk";
