// How long the sweep may hold the loop before it hands it back.
//
// Pure, so the decision can be tested with numbers. The sweep shares one thread
// with the terminal's PTY; the stall log charged "transcript sweep" 55 stalls,
// 254 s, worst 32 s. 500 ordinary lines measured ~40 ms of parse + insert, so a
// line count alone lets one transaction hold the loop for tens of ms and a
// cluster of heavy lines for much more. A time cap bounds the batch whatever its
// lines cost, and the yield between files bounds a run of small ones.

export interface BatchLimits {
  lines: number;
  bytes: number;
  /** Wall-clock ms a single transaction may run before it is cut. */
  ms: number;
}

/** Is this batch full? Never before it holds one line, or a slow first line
 *  would make no progress at all. */
export function batchFull(n: number, bytes: number, elapsedMs: number, lim: BatchLimits): boolean {
  if (n < 1) return false;
  return n >= lim.lines || bytes >= lim.bytes || elapsedMs >= lim.ms;
}

/** Should the sweep give the loop back between two files? */
export function shouldYield(sinceYieldMs: number, budgetMs: number): boolean {
  return sinceYieldMs >= budgetMs;
}
