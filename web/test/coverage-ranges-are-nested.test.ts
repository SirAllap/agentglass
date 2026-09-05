/*
 * A SCRIPT CANNOT RUN MORE BYTES THAN IT HAS.
 *
 * Measured against a real page, on the running app:
 *
 *     {"url": "node:electron/js2c/sandbox_bundle",
 *      "usedBytes": 476253, "totalBytes": 133567}
 *
 * More than three times the file's own length. Not a number anybody can act
 * on, and worse than no number because it looks like one — "did my change even
 * load" is the question this verb exists to answer, and 356% coverage answers
 * nothing.
 *
 * V8's precise coverage is NESTED: per function it hands back an outer range
 * plus the sub-ranges inside it whose count differs. Adding up every range
 * with `count > 0` counts a function body once for itself and again for every
 * executed block inside it. A byte's real count is the count of the INNERMOST
 * range covering it.
 */
import { describe, expect, test } from "bun:test";
import { coverageOf } from "../src/lib/browserDrive.ts";

const r = (start: number, end: number, count: number) => ({ startOffset: start, endOffset: end, count });

describe("counting nested ranges", () => {
  test("a covered function with a covered block inside it is counted once", () => {
    /* The exact shape that produced 356%: the old sum gave 100 + 40 = 140 for
       a hundred-byte script. */
    const out = coverageOf([{ ranges: [r(0, 100, 1), r(20, 60, 5)] }]);
    expect(out.totalBytes).toBe(100);
    expect(out.usedBytes).toBe(100);
  });

  test("an uncovered block inside a covered function is subtracted", () => {
    /* This is what coverage is FOR: the `else` that never ran. The old sum
       could not see it at all — it only ever added. */
    const out = coverageOf([{ ranges: [r(0, 100, 1), r(30, 50, 0)] }]);
    expect(out.usedBytes).toBe(80);
    expect(out.totalBytes).toBe(100);
  });

  test("and a covered block inside an uncovered one is counted", () => {
    /* Three deep, alternating. The innermost range wins for its own bytes,
       whichever way it goes. */
    const out = coverageOf([{ ranges: [r(0, 100, 1), r(20, 80, 0), r(40, 50, 3)] }]);
    expect(out.usedBytes).toBe(20 + 10 + 20);
  });

  test("a function nobody called contributes nothing", () => {
    expect(coverageOf([{ ranges: [r(0, 100, 0)] }]).usedBytes).toBe(0);
  });

  test("used never exceeds total, whatever the nesting", () => {
    /* The invariant the reported number broke. Built deep on purpose: ten
       nested covered ranges is where naive addition multiplies. */
    const deep = Array.from({ length: 10 }, (_, i) => r(i * 5, 200 - i * 5, i + 1));
    const out = coverageOf([{ ranges: deep }]);
    expect(out.usedBytes).toBeLessThanOrEqual(out.totalBytes);
    expect(out.usedBytes).toBe(200);
  });

  test("several functions in one file add up without overlapping", () => {
    const out = coverageOf([
      { ranges: [r(0, 50, 1), r(10, 20, 0)] },
      { ranges: [r(50, 120, 1)] },
    ]);
    expect(out.usedBytes).toBe(40 + 70);
    expect(out.totalBytes).toBe(120);
  });

  test("nothing at all is nothing, not a divide by zero", () => {
    expect(coverageOf([])).toEqual({ usedBytes: 0, totalBytes: 0 });
    expect(coverageOf([{ ranges: [] }])).toEqual({ usedBytes: 0, totalBytes: 0 });
    /* A zero-width range is not a byte. */
    expect(coverageOf([{ ranges: [r(7, 7, 1)] }])).toEqual({ usedBytes: 0, totalBytes: 0 });
  });
});
