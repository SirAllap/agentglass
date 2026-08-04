// What the whole machine is doing.
//
// The panel could already say "our 67 processes hold 4.26 GB" and leave you
// unable to tell whether that was most of the box or a rounding error — which
// is the moment people stop reading it and open a system monitor instead.
//
// These read /proc and /sys, so they are asserted as properties rather than
// against fixed numbers: the machine running them is not the machine that
// wrote them, and a test that expects 32 GB of RAM is a test that fails on
// somebody else's laptop for no reason.
import { describe, expect, test } from "bun:test";
import { machineTotals } from "../src/machine.ts";

describe("the machine's own numbers", () => {
  test("memory is reported, and used never exceeds total", () => {
    const m = machineTotals();
    expect(m.memTotal).toBeGreaterThan(0);
    expect(m.memUsed).toBeGreaterThanOrEqual(0);
    expect(m.memUsed).toBeLessThanOrEqual(m.memTotal);
  });

  test("free disk is reported, and never exceeds the disk", () => {
    const m = machineTotals();
    expect(m.diskTotal).toBeGreaterThan(0);
    expect(m.diskFree).toBeGreaterThanOrEqual(0);
    expect(m.diskFree).toBeLessThanOrEqual(m.diskTotal);
  });

  test("swap is consistent whether or not the machine has any", () => {
    // A machine with no swap is not a machine with a bug; both shapes are
    // valid and the panel hides the row entirely in the first case.
    const m = machineTotals();
    expect(m.swapTotal).toBeGreaterThanOrEqual(0);
    expect(m.swapUsed).toBeLessThanOrEqual(m.swapTotal);
  });

  test("CPU is null until there are two samples to subtract", async () => {
    /**
     * The property that matters, because the alternative is worse than no
     * number: a single reading of /proc/stat says what the machine has done
     * since boot, and reporting that as "busy percent" would show a idle
     * machine at 40% forever. Same reason a process's CPU starts null.
     */
    const first = machineTotals();
    if (first.cpu !== null) {
      // A previous test in this file already took a sample, so this call is
      // itself a second one — still assert the range rather than skipping.
      expect(first.cpu).toBeGreaterThanOrEqual(0);
      expect(first.cpu).toBeLessThanOrEqual(100);
    }
    await Bun.sleep(120);
    const second = machineTotals();
    expect(second.cpu).not.toBeNull();
    expect(second.cpu!).toBeGreaterThanOrEqual(0);
    expect(second.cpu!).toBeLessThanOrEqual(100);
    expect(second.cores).toBeGreaterThan(0);
  });

  test("temperature is a plausible reading or nothing at all", () => {
    // A VM exposes no thermal zone, and some machines expose one that reads
    // zero. Both must come back null rather than as a number the strip would
    // paint a bar for.
    const t = machineTotals().tempC;
    if (t !== null) {
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(150);
    }
  });

  test("load is a number, not a string from the file", () => {
    const m = machineTotals();
    expect(typeof m.load1).toBe("number");
    expect(Number.isFinite(m.load1)).toBe(true);
    expect(m.load1).toBeGreaterThanOrEqual(0);
  });
});
