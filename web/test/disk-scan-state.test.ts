/*
 * A disk scan keeps running when the Machine panel closes. These are the words
 * and the one-shot toast that tell the person so, from the server's frames.
 */
import { describe, expect, it } from "bun:test";
import type { DiskCleanLine, DiskCleanReport } from "../../shared/types.ts";

const S = await import("../src/lib/diskScan.ts");
const line = (id: string, bytes: number, verdict: DiskCleanLine["verdict"] = "safe"): DiskCleanLine => ({
  id, kind: "package-cache", mount: "/", label: id, bytes, verdict, why: "because",
  target: verdict === "safe" ? { via: "fs", root: "/h/.cache/orbit", path: "/h/.cache/orbit" } : null,
});
const report = (lines: DiskCleanLine[]): DiskCleanReport => ({ lines, mounts: [], safeBytes: 0, at: 1, generatedAt: 2, state: "ready", problems: [] });

describe("what the pill and the panel say while a scan runs", () => {
  it("names what is being read", () => {
    S.resetDiskScan();
    S.applyKept({ report: null, scanning: true, reading: "Docker and checkouts" });
    expect(S.diskScanNow()).toEqual({ scanning: true, reading: "Docker and checkouts" });
    expect(S.scanPillLabel(S.diskScanNow())).toBe("Disk cleanup · Scanning… Docker and checkouts");
  });
  it("says only Scanning… when the server names nothing", () => {
    S.resetDiskScan();
    S.applyKept({ report: null, scanning: true });
    expect(S.scanPillLabel(S.diskScanNow())).toBe("Disk cleanup · Scanning…");
  });
  it("is silent when idle", () => {
    S.resetDiskScan();
    expect(S.scanPillLabel(S.diskScanNow())).toBeNull();
  });
});

describe("the one toast when a scan ends", () => {
  it("fires once, on the running-to-finished edge, with what can go", () => {
    S.resetDiskScan();
    expect(S.applyKept({ report: null, scanning: true })).toBeNull();
    const r = report([line("a", 3e9), line("b", 1e9), line("c", 9e9, "ask")]);
    expect(S.applyKept({ report: r, scanning: false })).toBe("Disk scan finished · 4.0 GB can go");
    expect(S.applyKept({ report: r, scanning: false })).toBeNull();
    expect(S.diskScanNow().scanning).toBe(false);
  });
  it("says so when nothing may go", () => {
    S.resetDiskScan();
    S.applyKept({ report: null, scanning: true });
    expect(S.applyKept({ report: report([line("c", 9e9, "ask")]), scanning: false })).toBe("Disk scan finished · nothing to remove");
  });
  it("a first read of an idle server is not a finish", () => {
    S.resetDiskScan();
    expect(S.applyKept({ report: report([line("a", 3e9)]), scanning: false })).toBeNull();
  });
});
