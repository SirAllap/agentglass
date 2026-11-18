// The terminal relay's vocabulary: what the main server and the relay process
// say to each other, and the small decisions both sides share. A LEAF: no
// imports that run code, and above all nothing that opens the database
// (db.ts opens it on import), because the relay exists to stay off the thread
// that does.
//
// Why a relay at all, measured over a week of real use: the terminal froze for
// 5-31 s at a time because its WebSocket pump lived on the main server's one
// event loop, which also does SQLite (btrfs fsync and page waits), spawnSync
// tmux, transcript sweeps and git/PR work. Trimming the individual jobs moved
// the worst case but never removed it: any disk or CPU pressure on the machine
// stalls that loop and the terminal with it. The PTY itself is owned by a
// Python bridge that does not care, so the only part sharing the loop was the
// relay hop. This file describes the hop once that hop is its own process.

/** Main -> relay, one JSON object per line on the relay's stdin. */
export type ToRelay =
  | { op: "ticket"; id: string }
  /** Run a bridge for connection `conn`. `tap`: also copy output to main (only
   *  a shell whose prompts main parses needs it). */
  | { op: "spawn"; conn: number; argv: string[]; cwd: string; env: Record<string, string>; tap: boolean }
  /** A frame for the client of `conn`: text (control JSON). */
  | { op: "send"; conn: number; text: string }
  | { op: "write"; conn: number; b64: string }
  | { op: "close"; conn: number; code: number; reason: string };

/** Relay -> main, one JSON object per line on the relay's stdout. */
export type FromRelay =
  | { op: "ready"; port: number }
  /** A client redeemed a ticket. `query` is its URL query, untrusted. */
  | { op: "open"; conn: number; ticket: string; query: string }
  /** A client frame other than a keystroke (resize, control). */
  | { op: "msg"; conn: number; text: string }
  | { op: "closed"; conn: number }
  | { op: "spawned"; conn: number; pid: number }
  | { op: "failed"; conn: number; error: string }
  /** Output happened; `b64` only when the lane was spawned with `tap`. */
  | { op: "out"; conn: number; b64?: string }
  | { op: "keys"; conn: number }
  /** The bridge ended and every byte it wrote has reached the client. */
  | { op: "exited"; conn: number; code: number };

/** Splits a byte stream into complete lines, keeping the unfinished tail. */
export function lineSplitter(): (chunk: string) => string[] {
  let tail = "";
  return (chunk) => {
    tail += chunk;
    const parts = tail.split("\n");
    tail = parts.pop() ?? "";
    return parts.filter((l) => l.length > 0);
  };
}

/**
 * One-use, short-lived tickets. The relay holds the ids and burns one on the
 * first connection that presents it; main holds what the ticket stands for.
 * Unguessable (the caller supplies 32 random bytes) and never reused, so one
 * that lands in a log is already worthless.
 */
export class TicketBook {
  private ids = new Map<string, number>();
  constructor(private ttlMs = 45_000, private cap = 64) {}
  add(id: string, now = Date.now()): void {
    this.sweep(now);
    while (this.ids.size >= this.cap) this.ids.delete(this.ids.keys().next().value as string);
    this.ids.set(id, now + this.ttlMs);
  }
  /** True once per id, while it is fresh. */
  burn(id: string, now = Date.now()): boolean {
    const until = this.ids.get(id);
    this.ids.delete(id);
    return until !== undefined && until > now;
  }
  private sweep(now: number) { for (const [k, u] of this.ids) if (u <= now) this.ids.delete(k); }
  get size() { return this.ids.size; }
}

/** What a ticket stands for, decided by main from the authenticated mint
 *  request and never by the client that redeems it. */
export type TicketFacts = {
  worker: string | null;
  principal: "worker" | "seat" | "understudy" | "seat-browser" | null;
  ip: string | null;
};

/**
 * Restart policy for a relay that died: wait longer each time, and give up
 * (the in-process path keeps serving) when it has died 4 times in a minute.
 * Returns the delay in ms, or null to stay down.
 */
export function restartDelay(deaths: number[], now: number): number | null {
  const recent = deaths.filter((t) => now - t < 60_000);
  if (recent.length >= 4) return null;
  return Math.min(250 * 2 ** recent.length, 4000);
}

/** The largest query a client may hand the relay, mirrored at both ends. */
export const MAX_QUERY = 4096;

/**
 * Whether a page of this origin may knock on the relay's door at all (the
 * ticket is still the lock).
 *
 * The desktop window is served from `agentglass://app` (electron/main.js).
 * The first version of this list said `app://`, which is no origin this app
 * has: with the relay on, the real window was answered 403 on every try and
 * its terminal sat on "disconnected · reconnecting" until the relay was
 * switched off. The dev and test clients come from loopback http, and a
 * client that is not a page sends no Origin.
 */
export function relayOriginOk(origin: string | null): boolean {
  if (!origin) return true;
  return /^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?|agentglass:\/\/app|file:\/\/.*|null)$/.test(origin);
}

/**
 * Whether this server starts the relay: the environment when it says, the
 * person's stored choice when it does not.
 *
 * The relay used to be on only with AGENTGLASS_TERMRELAY=1 in the server's
 * environment. An app closed and opened again from the launcher starts
 * without it (a file under environment.d is read at the next login, and the
 * installer replays the variables only on a reinstall), so the relay went
 * off without a word: measured after such a restart, /health answered
 * relayEnabled false. The choice is now kept in the app's own settings and
 * read at boot. `1` and `0` in the environment still win, in both
 * directions, so a launcher or a test can hold it either way; any other
 * value says nothing.
 */
export function relayWanted(env: string | undefined, setting: boolean): boolean {
  if (env === "1") return true;
  if (env === "0") return false;
  return setting;
}

/** The environment's own say on the relay, for the sentence that explains a held switch: "1", "0" or null. */
export function relayHeldByEnv(env: string | undefined): "1" | "0" | null {
  return env === "1" || env === "0" ? env : null;
}
