/*
 * The transcript scanner reads a file one window at a time, and peak memory
 * follows the window, not the file. Measured on a real database over 13 GB of
 * transcripts: a 64 MB window peaked at 2.2 GB RSS, 8 MB at 0.73 GB, 2 MB at
 * 0.54 GB. This pins the default so a change back is a decision, not a drift.
 */
import { expect, test } from "bun:test";
import { SCAN_WINDOW_DEFAULT_BYTES } from "../src/transcripts";

test("the scan window default stays small enough to bound the boot sweep", () => {
  expect(SCAN_WINDOW_DEFAULT_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(SCAN_WINDOW_DEFAULT_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
});
