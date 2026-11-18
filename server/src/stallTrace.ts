// A server stall, on disk.
//
// loopwatch.ts already knows when the loop stalled and what it was doing —
// it just never outlived the process (`console.warn`, nothing on disk). A
// freeze report with "nothing from the server" either means the server never
// stalled or it stalled and forgot by the time anyone looked; this is the
// file that tells the two apart. Rotation is split out as pure functions
// (no fs here) so the plan can be asserted without a real file.

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** How big the trace file gets before it rotates. */
export const ROTATE_BYTES = 1_000_000;
/** Files kept besides the live one: `file`, `file.1`, `file.2`. */
export const ROTATE_KEEP = 3;

/** Whether a file this size needs to rotate before the next write. */
export function shouldRotate(sizeBytes: number, maxBytes: number = ROTATE_BYTES): boolean {
  return sizeBytes > maxBytes;
}

/** The rename plan, oldest pair first — see electron/stallProbe.js, the same
 *  math for the renderer side's trace file. */
export function rotationPaths(file: string, keep: number = ROTATE_KEEP): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = keep - 1; i >= 1; i--) pairs.push([i === 1 ? file : `${file}.${i - 1}`, `${file}.${i}`]);
  return pairs;
}

/** Append one line, rotating first if the file has grown past `maxBytes`.
 *  Never throws: a trace nobody can write must not take a request down. */
export function appendStallLine(file: string, line: string, maxBytes: number = ROTATE_BYTES): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file) && shouldRotate(statSync(file).size, maxBytes)) {
      for (const [from, to] of rotationPaths(file)) {
        try { if (existsSync(from)) renameSync(from, to); } catch { /* best effort */ }
      }
    }
    appendFileSync(file, line);
  } catch { /* a log nobody can write is not worth an exception */ }
}
