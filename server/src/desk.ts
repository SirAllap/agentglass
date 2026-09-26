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
 * And a server started by hand has no desk until the app adopts it and claims
 * one (below); until then the Origin rule and its limit stand there
 * (mayReleaseAHold in index.ts).
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

/*
 * The claim: the key of a server the desktop app ADOPTED rather than started.
 *
 * Such a server was never handed a pipe — it was started by hand, or by an
 * earlier launch — so it has no key, and the Origin rule was all that stood
 * between a machine-token holder and the two things the key guards. The app
 * that adopts it names a key of its own on `/desk/claim` and holds that request
 * open; the key is this server's for exactly as long as the connection lives.
 *
 * Who may claim is the point, and index.ts decides it: the machine token
 * itself, with no Origin, from a direct loopback socket. Every one of those
 * callers can already forge the app's Origin, so a claim made by one that is
 * not the app buys it nothing it did not have — except turning the forgery away
 * from everyone else, which the same caller could do by stopping the server.
 *
 * CEILING: first come, first served. A token holder that claims before the app
 * adopts the server, or in the moment between a dropped claim and the app's
 * next attempt, holds the desk until it lets go: it is then the only caller
 * that can register a browser window or release a hold from the desk, and the
 * app's own window is refused both (a paired phone still answers a hold). The
 * same caller could already take the browser role by forging the Origin, or
 * stop the server; what it gains is keeping the person's window out, quietly.
 * The app says so in its log and in a banner with a Retry; it does not start a
 * second server on the same database. A server started by an app — this launch
 * or an earlier one, whose sidecar outlived it — never takes a claim: it has
 * its key from the pipe, and an app that adopts it is refused the same way.
 */
let claim: { key: string } | null = null;

/**
 * Take the desk for `k`: the release for this claim, or null where there is a
 * key already, piped or claimed. The release frees only the claim it came with
 * and does nothing a second time, so a drop that arrives late cannot free a
 * later claim made with the same key.
 */
export function claimDesk(k: string): (() => void) | null {
  if (DESK_STARTED || claim) return null;
  const mine = { key: k };
  claim = mine;
  return () => { if (claim === mine) claim = null; };
}

/** The key, or "" where there is none. */
export const deskKey = (): string => key || claim?.key || "";

/** Somebody holds this server's desk: the key, and not an Origin, lets a hold go. */
export const deskHeld = (): boolean => DESK_STARTED || !!claim;

/** The header the desktop app's renderer carries it in. */
export const DESK_HEADER = "x-agentglass-desk";
