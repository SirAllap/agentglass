/*
 * The slice's occupancy read in `ensureWorkerSlice` is only ever as fresh as
 * the moment it runs: a worker scope another process creates in the gap
 * between that read and the write landing is invisible to it, and a write
 * that races ahead of a real worker can under-wall it. A successful write
 * sets `sliceUsable = true`, so the only way a later, wrongly-sized wall is
 * ever revisited is if index.ts keeps calling `ensureWorkerSlice` on its sweep
 * clock regardless of that cached flag — the "keep the standing wall" branch
 * inside it then only ever raises, never lowers, a wall under live workers
 * (scopes.ts). Booting a real server to watch the 10-minute sweep tick is not
 * a test; the decision is read straight from index.ts instead.
 */
import { expect, test } from "bun:test";

const INDEX = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();

test("the slice retry sweep re-checks occupancy on every tick, not only while unusable", () => {
  const start = INDEX.indexOf("const retrySlice = setIntervalAs(");
  expect(start, "no retrySlice setIntervalAs in index.ts").toBeGreaterThan(-1);
  const end = INDEX.indexOf("retrySlice.unref", start);
  expect(end, "retrySlice.unref?.() not found after the interval").toBeGreaterThan(start);
  const block = INDEX.slice(start, end);
  // No trailing semicolon: the call sits inside its stall-log label now.
  expect(block).toContain("ensureWorkerSlice({ readOnly: !appCopy })");
  // A write that already succeeded must not stop the sweep from asking again:
  // gating this call on the cached flag is exactly the bug (a race-won write
  // sets it once and nothing ever re-checks occupancy again).
  expect(block).not.toContain("workerSliceUsable");
});
