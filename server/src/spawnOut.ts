/*
 * ONE CHILD, RUN BESIDE THE LOOP.
 *
 * The server has one thread. `Bun.spawnSync` holds it until the child ends,
 * and a child whose work grows with a folder (a search, a `du`) ends when the
 * folder says so. Measured on the installed app (server-stall.log,
 * 2026-11-11): five stalls in a row behind one blocking ripgrep, the longest
 * 19,933 and 20,030 ms, which is that call's own 20 s limit: every panel and
 * the event stream stopped for as long as the search ran.
 *
 * This is the shape those calls take instead: the output as text, the same
 * limit, and never a throw (`Bun.spawn` throws on a missing binary where
 * `spawnSync` answered with a failed exit).
 */
import { runChild } from "./broker/brokerRun.ts";

export interface SpawnOut {
  stdout: string;
  stderr: string;
  /** null when the child could not be started. */
  exitCode: number | null;
  /** Ended by the limit, or by a newer run with the same `latest` key. What had arrived is in `stdout`. */
  killed: boolean;
}

const latestRun = new Map<string, () => void>();

/**
 * `latest`: runs that share a key replace each other. A search box sends one
 * request per pause in typing and reads only the last answer, so the earlier
 * child is ended when the next one starts. Ceiling: two windows searching the
 * same key at the same moment end each other's search too; the one ended
 * answers with what had arrived and `killed: true`.
 */
/** End the run holding this `latest` key, if any (a cancel button). Whether one ended. */
export function endRun(key: string): boolean {
  const k = latestRun.get(key);
  if (!k) return false;
  k();
  return true;
}

export async function spawnOut(
  argv: string[],
  o: { cwd?: string; env?: Record<string, string>; timeoutMs: number; latest?: string },
): Promise<SpawnOut> {
  if (o.latest) latestRun.get(o.latest)?.();
  // Started by the spawn broker (broker/brokerRun.ts): a fork of this big
  // server held its only thread in kernel_clone (broker/wire.ts).
  let ended = false;
  let end = () => {};
  const mine = () => { ended = true; end(); };
  if (o.latest) latestRun.set(o.latest, mine);
  const r = await runChild(argv, {
    cwd: o.cwd, ...(o.env ? { env: o.env } : {}), timeoutMs: o.timeoutMs,
    onKill: (k) => { end = k; if (ended) k(); },
  });
  if (o.latest && latestRun.get(o.latest) === mine) latestRun.delete(o.latest);
  if (r.error !== undefined && !r.stdout) return { stdout: "", stderr: "", exitCode: null, killed: false };
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code, killed: ended || r.timedOut };
}
