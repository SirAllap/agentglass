import { describe, expect, it } from "bun:test";
import type { DiskCleanReport } from "../../shared/types.ts";

const S = await import("../src/lib/diskScan.ts");
const report = { lines: [], mounts: [], safeBytes: 0, at: 1, generatedAt: 2, state: "ready", problems: [] } as DiskCleanReport;

describe("replies about the kept scan", () => {
  it("an older reply landing last is dropped, so finished is never overwritten by scanning", () => {
    S.resetDiskScan();
    const ask = S.latestOnly();
    const first = ask();
    const second = ask();
    // The newer reply (finished) lands first, the older one (scanning) last.
    S.applyKept({ report: null, scanning: true });
    expect(second()).toBe(true);
    S.applyKept({ report, scanning: false });
    expect(first()).toBe(false);
    expect(S.diskScanNow().scanning).toBe(false);
  });
  it("the finished toast fires once", () => {
    S.resetDiskScan();
    S.applyKept({ report: null, scanning: true });
    expect(S.applyKept({ report, scanning: false })).toContain("Disk scan finished");
    expect(S.applyKept({ report, scanning: false })).toBeNull();
  });
});

describe("the report that starts by itself", () => {
  it("starts once per scan, not again after a cancel or a failure", () => {
    S.resetAutoReports();
    expect(S.claimAutoReport(10)).toBe(true);
    expect(S.claimAutoReport(10)).toBe(false);
    expect(S.claimAutoReport(11)).toBe(true);
  });
});
