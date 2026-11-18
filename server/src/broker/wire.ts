// The spawn broker's vocabulary: what the main server and the broker process
// say to each other, and the decisions both sides share. A LEAF like
// relay/wire.ts: no import that runs code, nothing that opens the database.
//
// Why a broker, measured on the installed app: the server's only thread was
// caught in `kernel_clone`, state D, in three one-second samples in a row
// (a 2,392 ms stall with almost no disk or swap traffic) while it started gh
// and git children. Starting a child is a fork of the server itself, about
// 1.1 GB at the time, on a machine short of memory; the fork holds the thread
// until the kernel is done, and awaiting the child afterwards changes nothing
// about that. A process with a few megabytes forks in no time, so the fork is
// done there: the server writes one line on a pipe and goes on.

/** Main -> broker, one JSON object per line on the broker's stdin. */
export type ToBroker =
  | {
      op: "run";
      id: number;
      argv: string[];
      cwd?: string;
      /** Set over the environment the broker was started with. */
      env?: Record<string, string>;
      /** Names taken out of it. */
      unset?: string[];
      /** Kill the child after this long. */
      timeoutMs: number;
      /** How long past the kill to wait for its output to end (a grandchild can hold the pipe). */
      graceMs?: number;
      stdin?: string;
      /** Per stream. Past it the stream is cut and `truncated` says so. */
      maxBytes: number;
    }
  | { op: "kill"; id: number }
  /** Are you there? Answered with a pong from the same loop that answers runs. */
  | { op: "ping" };

/** What one run came to. */
export type BrokerDone = {
  id: number;
  /** As `await proc.exited` gives it in the broker; null when it never started or its output never ended. */
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  /** The child was killed and something it started still held its output past the grace. */
  held: boolean;
  /** The child could not be started: the reason, as the in-process spawn would have thrown it. */
  error?: string;
};

/** Broker -> main, one JSON object per line on the broker's stdout. */
export type FromBroker = { op: "ready" } | { op: "pong" } | ({ op: "done" } & BrokerDone);

/** The environment name that puts the server binary in the broker role. */
export const BROKER_MARK = "AGENTGLASS_BROKER_CHILD";

/**
 * Collects one output stream up to `max` bytes.
 *
 * `push` returns false once the cap is reached; the caller goes on draining
 * the pipe (a child blocked on a full pipe never exits) and drops the rest.
 */
export function capped(max: number): { push(chunk: Uint8Array): boolean; text(): string; readonly truncated: boolean } {
  const parts: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  return {
    push(chunk) {
      if (cut) return false;
      const room = max - size;
      if (chunk.length <= room) { parts.push(chunk); size += chunk.length; return true; }
      if (room > 0) { parts.push(chunk.subarray(0, room)); size += room; }
      cut = true;
      return false;
    },
    // One decode of the whole: a character cut by a chunk boundary stays one character.
    text: () => new TextDecoder().decode(parts.length === 1 ? parts[0]! : Buffer.concat(parts)),
    get truncated() { return cut; },
  };
}

/**
 * What must be sent with a request so the child sees `now`, given the
 * environment `base` the broker was started with.
 *
 * The in-process spawn passed `{ ...process.env, …extras }` read at the moment
 * of the call. The broker has the environment of the moment it started, so
 * only the difference travels: a few names, not the whole block on every git.
 */
export function envDelta(base: Record<string, string | undefined>, now: Record<string, string | undefined>): { env: Record<string, string>; unset: string[] } {
  const env: Record<string, string> = {};
  const unset: string[] = [];
  for (const [k, v] of Object.entries(now)) if (v !== undefined && base[k] !== v) env[k] = v;
  for (const k of Object.keys(base)) if (base[k] !== undefined && now[k] === undefined) unset.push(k);
  return { env, unset };
}

/** The other half: the child's environment, from the broker's own and a request. */
export function envFor(own: Record<string, string | undefined>, env: Record<string, string> | undefined, unset: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(own)) if (v !== undefined) out[k] = v;
  for (const k of unset ?? []) delete out[k];
  Object.assign(out, env ?? {});
  // The mark that makes this binary a broker is not for the things it starts.
  delete out[BROKER_MARK];
  return out;
}
