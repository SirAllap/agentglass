// The session-scoped twin of panelease.ts, for phone mirrors rather than
// understudy windows.
//
// A phone mirror is a SESSION (`agx-phone-…`), not a window, and it is not
// always on our own engine socket: `attachArgvFor` finds the pane on whatever
// tmux server the desk is actually using, which can be the user's own. So the
// same rule panelease.ts applies to windows — stamp on create, verify the
// stamp before ever closing anything, never trust the name — has to carry a
// socket alongside the id, because a session name is unique per SERVER, not
// per machine.
//
// This module is only the record: load it, hold it, write it through on every
// change. The tmux calls that stamp, read and kill live in tmuxctl.ts, which
// already owns every rule about which socket may be touched (`tmuxSocketAllowed`,
// `tmuxSocketConfined`) — duplicating that here would be a second place for
// those rules to drift out of sync.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmuxStateDir } from "./tmuxbin.ts";

export interface MirrorLease {
  /** The `-L`/`-S` argv naming the tmux server this session lives on, exactly
   *  as `attachArgvFor`'s caller passed it in. */
  socket: string[];
  /** The mirror session's name, `agx-phone-…`. Never matched on its own —
   *  see the stamp below. */
  session: string;
  /** What we stamped that session with. The proof of ownership. */
  token: string;
  opened: number;
  /**
   * THE ZOOM THIS ATTACH APPLIED, so a restart can still take it off.
   *
   * A phone gets one pane, so a window with a split is zoomed for it — and the
   * zoom is a property of the WINDOW, shared with whoever else is looking at
   * that session. It was undone from an object held in memory, which is fine
   * until this process goes away: measured on the developer's machine after a
   * day of reinstalls, two windows sat zoomed with no phone attached and
   * nothing left that knew they should not be. "It stays like that even after
   * I have left the mobile app… I have to make a split and it goes back to
   * normal."
   *
   * Written down beside the session it belongs to, so the sweep that reaps a
   * dead mirror can undo exactly what that mirror did — and only that. A zoom
   * a PERSON applied is not in here and is never touched.
   */
  zoomed?: { sessionId: string; windowId: string; paneId: string } | null;
}

const mirrorLeaseFile = (): string => join(tmuxStateDir(), "mirror-leases.json");

const key = (socket: string[], session: string): string => `${JSON.stringify(socket)}\t${session}`;

let held: Map<string, MirrorLease> | null = null;

function load(): Map<string, MirrorLease> {
  if (held) return held;
  held = new Map();
  try {
    const raw = JSON.parse(readFileSync(mirrorLeaseFile(), "utf8")) as unknown;
    // Shape-checked entry by entry rather than trusted, the same reason
    // panelease.ts does: a truncated write or a hand-edit must lose the
    // record, never widen what it lets the startup sweep touch.
    if (Array.isArray(raw)) {
      for (const e of raw as MirrorLease[]) {
        if (e && Array.isArray(e.socket) && e.socket.every((s) => typeof s === "string")
          && typeof e.session === "string" && e.session.length > 0
          && typeof e.token === "string" && e.token.length >= 8) {
          held.set(key(e.socket, e.session), { socket: e.socket, session: e.session, token: e.token, opened: Number(e.opened) || 0 });
        }
      }
    }
  } catch { /* no file yet is the common case, not an error */ }
  return held;
}

function save(): void {
  const path = mirrorLeaseFile();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify([...load().values()]), { mode: 0o600 });
  } catch { /* the in-memory record still covers this process's own exits */ }
}

/** Every mirror session we currently believe we hold. Read-only. */
export const mirrorLeases = (): MirrorLease[] => [...load().values()];

/** Record a mirror the moment it is stamped, so the record survives the
 *  process that made it. */
export function recordMirrorLease(lease: MirrorLease): void {
  load().set(key(lease.socket, lease.session), lease);
  save();
}

/** Drop a record, whether or not anything was actually killed for it — a
 *  mirror lease we cannot prove is a lease we will never act on again. */
export function forgetMirrorLease(socket: string[], session: string): void {
  load().delete(key(socket, session));
  save();
}

/** Test seam: forget the in-memory record without touching the file, so a
 *  suite can act out a server restart. */
export function __forgetMirrorLeases(): void { held = null; }

/** Test seam: drop the record entirely, file included. */
export function __resetMirrorLeases(): void {
  held = new Map();
  try { if (existsSync(mirrorLeaseFile())) writeFileSync(mirrorLeaseFile(), "[]", { mode: 0o600 }); } catch { /* nothing to clear */ }
}
