import { closeSync, fsyncSync, openSync } from "node:fs";

/**
 * Make a rename into `dir` durable. Syncing the temp file makes its bytes
 * durable, but the rename that puts it under the real name is a change to the
 * directory, and on a power cut it can be lost or replayed out of order with
 * the data: the old file comes back, or the new name points at nothing.
 *
 * Best effort and never throws: the rename has already happened, so a platform
 * that cannot open or sync a directory (Windows) must not turn a finished write
 * into a failure. The ceiling: on such a platform the rename is as durable as
 * the OS makes it, which is what it was before this call.
 */
export function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try { fd = openSync(dir, "r"); fsyncSync(fd); } catch { /* see above */ } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* nothing to close */ }
  }
}
