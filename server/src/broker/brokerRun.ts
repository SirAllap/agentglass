// One awaited call that starts a background command in the spawn broker, and
// forks the server only when there is no broker to ask. git.ts and prs.ts keep
// their own routed runners (they record and word their errors); everything
// else that runs a child in the background comes through here, so the fork of
// the big server (broker/wire.ts: 2.4 s in kernel_clone, measured) happens in
// the small broker instead.
import { brokerExec, brokerKill } from "./brokerHost.ts";
import { capped } from "./wire.ts";

export type ChildOut = {
  stdout: string;
  stderr: string;
  /** null when it never started, or ended by a signal. */
  code: number | null;
  signal: string | null;
  /** Ended by its own limit. */
  timedOut: boolean;
  /** An output stream passed `maxBytes` and was cut there. */
  truncated: boolean;
  /** Why it could not be started, when it could not. */
  error?: string;
};

export type ChildOpts = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  stdin?: string;
  /**
   * True only for a command safe to run twice (a read). A read the broker lost
   * or cut is run again here; anything else answers what the broker said.
   */
  read?: boolean;
  maxBytes?: number;
  /** Called with a function that ends the run early (a newer request replaced it). */
  onKill?: (kill: () => void) => void;
};

const MAX_BYTES = 32 * 1024 * 1024;

let forks = 0;
/** How many children this module forked from the server itself (no broker). For tests and the stall log. */
export const directForks = (): number => forks;

export async function runChild(argv: string[], o: ChildOpts): Promise<ChildOut> {
  const via = brokerExec({
    argv, cwd: o.cwd, env: o.env ?? process.env, timeoutMs: o.timeoutMs,
    maxBytes: o.maxBytes ?? MAX_BYTES, read: !!o.read,
    ...(o.stdin === undefined ? {} : { stdin: o.stdin }),
  });
  if (via) {
    o.onKill?.(() => brokerKill(via.id));
    const a = await via.done;
    const again = o.read && (a.lost || a.truncated);
    if (!again) {
      if (a.lost) return { stdout: "", stderr: "the spawn broker stopped before it answered; not run again", code: null, signal: null, timedOut: false, truncated: false, error: "lost" };
      return { stdout: a.stdout, stderr: a.stderr, code: a.code, signal: a.signal, timedOut: a.timedOut, truncated: a.truncated, ...(a.error === undefined ? {} : { error: a.error }) };
    }
  }
  return forkChild(argv, o);
}

async function forkChild(argv: string[], o: ChildOpts): Promise<ChildOut> {
  let proc: ReturnType<typeof Bun.spawn>;
  forks++;
  try {
    proc = Bun.spawn(argv, {
      cwd: o.cwd,
      env: (o.env ?? process.env) as Record<string, string>,
      stdin: o.stdin === undefined ? "ignore" : new TextEncoder().encode(o.stdin),
      stdout: "pipe", stderr: "pipe",
    });
  } catch (e) { return { stdout: "", stderr: "", code: null, signal: null, timedOut: false, truncated: false, error: String(e) }; }
  let timedOut = false;
  o.onKill?.(() => { try { proc.kill(); } catch { /* gone */ } });
  // loop-ok: ends one child at its limit
  const limit = setTimeout(() => { timedOut = true; try { proc.kill(); } catch { /* gone */ } }, o.timeoutMs);
  // The same cap the broker keeps (wire.ts): past it the rest is drained and dropped.
  const max = o.maxBytes ?? MAX_BYTES;
  const read = async (s: unknown) => {
    const c = capped(max);
    try { for await (const chunk of s as ReadableStream<Uint8Array>) c.push(chunk); } catch { /* ended */ }
    return c;
  };
  const [out, err] = await Promise.all([read(proc.stdout), read(proc.stderr)]);
  const code = await proc.exited.catch(() => null);
  clearTimeout(limit);
  return { stdout: out.text(), stderr: err.text(), code: proc.signalCode ? null : code, signal: proc.signalCode ?? null, timedOut, truncated: out.truncated || err.truncated };
}
