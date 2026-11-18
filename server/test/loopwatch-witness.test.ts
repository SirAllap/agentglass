/*
 * A stall of "waiting, not computing" says the host was paging but not how
 * hard or who held the memory. The stall log now carries the kernel's memory
 * pressure and the three biggest processes after any stall over a second.
 */
import { expect, test } from "bun:test";
import { pressureLine, topRss } from "../src/loopwatch.ts";

test("pressure keeps the avg10 of some and full", () => {
  const psi = "some avg10=12.50 avg60=3.00 avg300=1.00 total=1\nfull avg10=4.25 avg60=1.00 avg300=0.50 total=2\n";
  expect(pressureLine(psi)).toBe("mem-pressure some=12.50 full=4.25");
  expect(pressureLine("")).toBe("");
});

test("top RSS is the three largest, in MB", () => {
  const ps = "  1024 small\n 2097152 tsc\n 1048576 bun\n 524288 claude\n 512 x\n";
  expect(topRss(ps)).toBe("tsc=2048M bun=1024M claude=512M");
});

test("the stall line says whether the loop computed or waited, and io/cpu pressure rides with memory", async () => {
  const { stallDetail, somePressure } = await import("../src/loopwatch.ts");
  expect(stallDetail({ cpuMs: 60, waiting: true, majorFaults: 0, diskReads: 0 })).toBe("waiting cpu=60ms");
  expect(stallDetail({ cpuMs: 900, waiting: false, majorFaults: 2, diskReads: 8 })).toBe("computing cpu=900ms swapin=2 diskblk=8");
  expect(somePressure("io", "some avg10=1.32 avg60=0.9 avg300=0.7 total=5\nfull avg10=0.10 avg60=0 avg300=0 total=1")).toBe("io=1.32");
  expect(somePressure("io", "")).toBe("");
});
