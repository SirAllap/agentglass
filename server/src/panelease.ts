// A lease on a tmux window THIS server opened, and the only thing allowed to
// close one.
//
// The pane engine already reclaims memory, and it does it the way a memory
// optimisation is usually done: `evictIdlePanes` lists every session on our
// socket and kills the ones nothing has touched in thirty minutes. That is the
// right shape for chat panes, whose names this app mints, and it is the wrong
// shape for everything a run opens — for two measured reasons.
//
//   - It cannot see them. A run opens a WINDOW inside the checkout's engine
//     session (`engineWindowRunning`); the sweeper enumerates SESSIONS and
//     `killPane` kills a session. So an interactive agent left in a run window
//     is invisible to the only cleanup there is, and stays resident until
//     somebody notices. Measured on this machine while writing this: 24
//     `claude` processes, 5.5GB resident, the largest 1028MB, several alive 50
//     hours.
//   - Widening it to windows would be worse than the leak. Eight of those 24
//     are the user's OWN work, in another repository, 43 to 51 hours old, and
//     they are continued tomorrow morning. A sweep that decides from what a
//     window LOOKS like — a name that starts with `understudy:`, a `claude` in
//     a worktree shaped like ours, an age — is one heuristic away from killing
//     one of those, and being wrong once costs more than the feature saves.
//
// So closing is never inferred. A window this app opens is STAMPED at the
// moment it is opened, with a random token nothing else can produce, and the
// stamp is recorded. Closing reads the stamp back off that exact window id and
// refuses unless it matches the token recorded for it. Nothing is enumerated,
// no name is matched, no age is consulted: the only candidates are the ones in
// our own record, and each of them still has to prove it is the window we
// stamped.
//
// Why the stamp as well as the id: tmux window ids (`@7`) are unique per tmux
// SERVER, not for ever. Our engine survives this process — that is the point of
// it — but it does not survive a reboot or a `kill-server`, and after one the
// ids start again at `@0`. A record written before that restart would then name
// a window somebody else opened, and the first `@0` on the engine is the user's
// own terminal view. The stamp is what makes a stale record inert instead of
// dangerous.
//
// The record is on disk rather than in memory because the failure this exists
// for includes the server restarting mid-run: the process that knew about the
// window is gone, the window is not.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmuxStateDir } from "./tmuxbin.ts";
import { tmux } from "./tmuxpane.ts";

/** The tmux user option the stamp is written to. A user option must begin with
 *  `@`, and this one is namespaced so it cannot collide with anything a person
 *  sets in their own config — which they could not reach anyway, since this
 *  server never loads it. */
export const LEASE_OPTION = "@agx_lease";

export interface Lease {
  /** The tmux window id, `@N`, as `new-window -P` printed it. */
  windowId: string;
  /** What we stamped that window with. The proof of ownership. */
  token: string;
  /** For the log line when a stale one is dropped; never used to decide. */
  label: string;
  opened: number;
}

/** Where the record lives. Alongside the engine's binary and restore data, and
 *  under test that resolves to a scratch dir — see `tmuxStateDir`. */
const leaseFile = (): string => join(tmuxStateDir(), "leases.json");

/** The tmux calls this module makes, injectable so the rule can be tested
 *  without a tmux server. A test that reached a real one would be reading —
 *  and killing in — whatever the developer had open. */
export interface LeaseIo {
  /** `false` for any tmux failure, which is always read as "cannot prove it". */
  stamp: (windowId: string, token: string) => Promise<boolean>;
  /** The stamp currently on that window, or "" if it has none / is gone. */
  readStamp: (windowId: string) => Promise<string>;
  kill: (windowId: string) => Promise<void>;
}

const REAL: LeaseIo = {
  stamp: async (windowId, token) =>
    (await tmux(["set-option", "-w", "-t", windowId, LEASE_OPTION, token])).ok,
  readStamp: async (windowId) => {
    const r = await tmux(["show-options", "-w", "-v", "-t", windowId, LEASE_OPTION]);
    return r.ok ? r.stdout.trim() : "";
  },
  kill: async (windowId) => { await tmux(["kill-window", "-t", windowId]); },
};

/* The record, read from disk once and written through on every change. Held in
   memory as well so the common path — open a window, close it a minute later —
   does not depend on the file still being readable. */
let held: Map<string, Lease> | null = null;

function load(): Map<string, Lease> {
  if (held) return held;
  held = new Map();
  try {
    const raw = JSON.parse(readFileSync(leaseFile(), "utf8")) as unknown;
    // Shape-checked entry by entry rather than trusted: this file is read at
    // startup and its contents decide what gets killed, so a truncated write or
    // a hand-edit must lose the record, never widen it.
    if (Array.isArray(raw)) {
      for (const e of raw as Lease[]) {
        if (e && typeof e.windowId === "string" && e.windowId.startsWith("@")
          && typeof e.token === "string" && e.token.length >= 8) {
          held.set(e.windowId, { windowId: e.windowId, token: e.token, label: String(e.label ?? ""), opened: Number(e.opened) || 0 });
        }
      }
    }
  } catch { /* no file yet is the common case, not an error */ }
  return held;
}

function save(): void {
  const path = leaseFile();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify([...load().values()]), { mode: 0o600 });
  } catch { /* the in-memory record still covers this process's own exits */ }
}

/** Every window we currently believe we hold. Read-only; a caller that wants
 *  one closed goes through `endLease`. */
export const leases = (): Lease[] => [...load().values()];

/**
 * Take ownership of a window that has just been opened.
 *
 * Null when the stamp could not be written, and the caller must treat that as
 * "this window is not ours to close" rather than falling back to the id alone.
 * An unstamped window is indistinguishable from one of the user's, which is
 * exactly the case this module exists to refuse.
 */
export async function takeLease(
  windowId: string, label: string, io: LeaseIo = REAL, now = Date.now(),
): Promise<Lease | null> {
  if (!windowId.startsWith("@")) return null;
  const token = randomBytes(16).toString("hex");
  if (!await io.stamp(windowId, token)) return null;
  const lease: Lease = { windowId, token, label, opened: now };
  load().set(windowId, lease);
  save();
  return lease;
}

/**
 * Close a window we opened, and only that.
 *
 * Returns whether it killed anything. False covers three different endings and
 * deliberately does not distinguish them, because the action is the same in all
 * three: we hold no record of that window, the window is gone already, or the
 * stamp on it is not the one we wrote. The record is dropped either way — a
 * lease we cannot prove is a lease we will never act on, and keeping it would
 * only mean carrying it into the next startup sweep.
 */
export async function endLease(windowId: string, io: LeaseIo = REAL): Promise<boolean> {
  const rec = load().get(windowId);
  if (!rec) return false;
  const seen = await io.readStamp(windowId);
  const ours = seen === rec.token;
  if (ours) await io.kill(windowId);
  load().delete(windowId);
  save();
  return ours;
}

/**
 * Is the window we leased still there, still ours?
 *
 * The liveness question, asked the only way that cannot be wrong about it: the
 * stamp we wrote is either still on that window id or it is not. A window that
 * closed answers "" and so does a tmux that is not running, and both mean the
 * same thing to a caller waiting on the agent inside it — there is nothing left
 * to wait for.
 *
 * Written for the run loop, which used to have no liveness signal at all and
 * waited out its full forty-five minute budget on an agent that had died in the
 * first two. It is deliberately the same check `endLease` makes before killing:
 * one rule for "this window is ours", used both to close it and to notice it is
 * gone.
 *
 * False for a window we never recorded, which is the honest answer — this can
 * only speak for windows this process opened.
 */
export async function leaseHeld(windowId: string, io: LeaseIo = REAL): Promise<boolean> {
  const rec = load().get(windowId);
  if (!rec) return false;
  return (await io.readStamp(windowId)) === rec.token;
}

/**
 * Close everything still recorded, and say what went.
 *
 * Called at startup, where it is the answer to "the server restarted mid-run":
 * the process that would have closed those windows died, so the record left
 * behind is the only thing that knows about them. Each one is still verified
 * against its stamp, so a record that outlived the tmux server closes nothing.
 */
export async function reapLeases(io: LeaseIo = REAL): Promise<string[]> {
  const killed: string[] = [];
  for (const { windowId } of leases()) if (await endLease(windowId, io)) killed.push(windowId);
  return killed;
}

/** Test seam: forget the in-memory record without touching the file, so a suite
 *  can act out a server restart. */
export function __forgetLeases(): void { held = null; }

/** Test seam: drop the record entirely, file included. */
export function __resetLeases(): void {
  held = new Map();
  try { if (existsSync(leaseFile())) writeFileSync(leaseFile(), "[]", { mode: 0o600 }); } catch { /* nothing to clear */ }
}
