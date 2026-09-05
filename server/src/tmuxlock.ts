/**
 * Sessions a person has said may not be ended.
 *
 * The picker can close a session and everything running in it, which is what
 * makes it useful — and asked for straight after it shipped: "can you add a
 * padlock to lock some of them so they cannot be deleted, to avoid
 * disasters".
 *
 * BY NAME, NOT BY SESSION ID. A session id changes every time tmux makes one,
 * so a lock held against it would quietly evaporate the first time the session
 * was recreated — which is precisely the moment a lock is for. Locking the name
 * means the protection survives the app restarting, tmux restarting, and the
 * session being restored from `layout.json`.
 *
 * A plain list on disk rather than a tmux option, for the same reason: an
 * option lives and dies with the session it is set on.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmuxStateDir } from "./tmuxbin.ts";

const filePath = (): string => join(tmuxStateDir(), "locked-sessions.json");

/** Read defensively: a lock file that cannot be parsed must not stop the app,
 *  and it must not silently unlock everything either — see `isLocked`. */
function read(): { locked: string[]; readable: boolean } {
  try {
    const raw = JSON.parse(readFileSync(filePath(), "utf8")) as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { locked?: unknown })?.locked;
    if (!Array.isArray(list)) return { locked: [], readable: true };
    return { locked: list.filter((x): x is string => typeof x === "string" && x.length > 0), readable: true };
  } catch (e) {
    /* Missing is the common case and means nothing is locked. Anything else —
       a truncated write, a permission change — is a file we could not read,
       and unlocking on that would be the failure this exists to prevent. */
    const missing = (e as { code?: string })?.code === "ENOENT";
    return { locked: [], readable: missing };
  }
}

/** The names that may not be ended. */
export function lockedSessions(): string[] {
  return read().locked;
}

/**
 * May this session be ended?
 *
 * FAILS CLOSED. If the lock file exists and cannot be read, nothing is
 * ended — a lock nobody can read is not a lock that has been lifted, and the
 * cost of being wrong here is somebody's work.
 */
export function isLocked(name: string): boolean {
  const { locked, readable } = read();
  if (!readable) return true;
  return locked.includes(name);
}

/** Turn the lock on or off for one name. Returns what it is now. */
export function setLocked(name: string, locked: boolean): boolean {
  if (!name) return false;
  const current = new Set(read().locked);
  if (locked) current.add(name); else current.delete(name);
  try {
    mkdirSync(tmuxStateDir(), { recursive: true });
    /* Written to a temp file and moved into place: an interrupted write must
       not leave a half-parsed list, which `isLocked` would then treat as
       unreadable and lock everything. */
    const tmp = `${filePath()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ locked: [...current].sort() }, null, 2));
    renameSync(tmp, filePath());
  } catch { /* the answer below is still what the caller asked for */ }
  return locked;
}
