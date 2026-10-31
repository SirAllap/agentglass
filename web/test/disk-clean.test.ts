/*
 * The decisions behind the machine panel's disk cleanup block: which lines get a
 * button, the order they are listed in, which face the block shows, the sentence
 * on the low-disk badge, and how a finished clean is put in words.
 *
 * Fixtures are the shape of a real scan: two disks, one nearly full, with one line
 * of every verdict.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";
import type { DiskCleanLine, DiskCleanReport, DiskCleanRunResult } from "../../shared/types.ts";

const stubGlobal = globalStubs();
const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage);
stubGlobal("location", new URL("http://localhost:5173/"));
stubGlobal("document", { documentElement: { setAttribute: () => {}, getAttribute: () => null, style: { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => "" } } });
stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
stubGlobal("navigator", { webdriver: true, userAgent: "Linux" });
stubGlobal("window", new EventTarget());
afterAll(() => store.clear());

const D = await import("../src/lib/diskClean.ts");
const GB = 1e9;
const line = (id: string, verdict: DiskCleanLine["verdict"], bytes: number | null, withTarget = verdict === "safe"): DiskCleanLine => ({
  id, kind: "package-cache", mount: "/", label: id, bytes, verdict, why: "because", target: withTarget ? { via: "fs", root: "/h/.cache/uv", path: "/h/.cache/uv" } : null,
});
const report = (lines: DiskCleanLine[]): DiskCleanReport => ({
  lines, at: 0, problems: [], safeBytes: 0,
  mounts: [{ mount: "/", source: "/dev/a", size: 224 * GB, free: 5 * GB, safeBytes: 0 }],
});

describe("which lines may be cleaned", () => {
  it("only a safe line that has something to remove", () => {
    expect(D.cleanable(line("a", "safe", GB))).toBe(true);
    expect(D.cleanable(line("b", "safe", GB, false))).toBe(false);
    // a target on a line the scan does not call safe must not make a button
    expect(D.cleanable(line("c", "ask", GB, true))).toBe(false);
    expect(D.cleanable(line("d", "inuse", GB, true))).toBe(false);
    expect(D.cleanable(line("e", "explain", GB, true))).toBe(false);
  });

  it("the whole plan is those lines and their sum; an unmeasured one adds nothing", () => {
    const p = D.wholePlan(report([line("a", "safe", 2 * GB), line("b", "safe", null), line("c", "ask", 9 * GB, true), line("d", "inuse", 9 * GB)]));
    expect(p.ids).toEqual(["a", "b"]);
    expect(p.bytes).toBe(2 * GB);
  });
});

describe("the order", () => {
  it("safe first, then ask, in use, info; the biggest first inside a group; unmeasured last", () => {
    const ids = D.sortLines([
      line("info", "explain", 9 * GB), line("use", "inuse", 5 * GB), line("ask", "ask", GB),
      line("small", "safe", GB), line("unknown", "safe", null), line("big", "safe", 4 * GB),
    ]).map((l) => l.id);
    expect(ids).toEqual(["big", "small", "unknown", "ask", "use", "info"]);
  });
  it("does not reorder what it was given", () => {
    const given = [line("b", "safe", GB), line("a", "safe", 2 * GB)];
    D.sortLines(given);
    expect(given.map((l) => l.id)).toEqual(["b", "a"]);
  });
});

describe("the face of the block", () => {
  const plan = report([line("a", "safe", GB)]);
  const only = report([line("u", "inuse", GB)]);
  const s = (o: Partial<Parameters<typeof D.phaseOf>[0]>) => D.phaseOf({ report: null, scanning: false, error: null, result: null, ...o });
  it("idle until a scan is asked for", () => expect(s({})).toBe("idle"));
  it("a scan in flight wins over what was there", () => expect(s({ scanning: true, report: plan, result: {} as DiskCleanRunResult, error: "x" })).toBe("scanning"));
  it("a scan that threw is an error, with no report to show", () => expect(s({ error: "timed out" })).toBe("error"));
  it("a plan with something safe", () => expect(s({ report: plan })).toBe("plan"));
  it("a scan with nothing safe is empty, not a plan with a dead button", () => {
    expect(s({ report: only })).toBe("empty");
    expect(s({ report: report([]) })).toBe("empty");
  });
  it("a finished clean shows its report until the next scan", () => expect(s({ report: plan, result: { ok: true } as DiskCleanRunResult })).toBe("done"));
});

describe("words", () => {
  it("sizes in decimal like the free-space tile beside it", () => {
    expect(D.fmtBytes(null)).toBe("unknown");
    expect(D.fmtBytes(59.4 * GB)).toBe("59.4 GB");
    expect(D.fmtBytes(120 * GB)).toBe("120 GB");
    expect(D.fmtBytes(300_000)).toBe("1 MB");
    expect(D.fmtBytes(512e6)).toBe("512 MB");
    expect(D.fmtBytes(1000 * GB)).toBe("1 TB");
    expect(D.fmtBytes(1.5e12)).toBe("1.5 TB");
  });
  it("the confirm names what will go, with the plural right", () => {
    expect(D.confirmLabel(1, GB)).toBe("Yes, remove 1 item (1.0 GB)");
    expect(D.confirmLabel(3, 12.5 * GB)).toBe("Yes, remove 3 items (12.5 GB)");
  });
  it("one colour per meaning: only safe is green and only ask is amber", () => {
    expect(D.VERDICT.safe.tone).toBe("ok");
    expect(D.VERDICT.ask.tone).toBe("warn");
    expect(D.VERDICT.inuse.tone).toBe("muted");
    expect(D.VERDICT.explain.tone).toBe("muted");
  });
});

describe("the low-disk badge sentence", () => {
  const m = (mount: string, size: number, free: number) => ({ mount, size, free });
  it("names the mount and its share", () => expect(D.lowDiskLabel([m("/", 224 * GB, 5 * GB)], 10)).toBe("Low disk: / 2 % free"));
  it("is null when every disk is over the line, exactly at it, or the warning is off", () => {
    expect(D.lowDiskLabel([m("/", 100, 10)], 10)).toBeNull();
    expect(D.lowDiskLabel([m("/", 100, 1)], 0)).toBeNull();
  });
  it("counts the others instead of listing them", () => expect(D.lowDiskLabel([m("/", 100, 1), m("/data", 100, 2), m("/x", 100, 3)], 10)).toBe("Low disk: / 1 % free (+2 more)"));
  it("a scan, once published, replaces the machine tile's one number; dropping it brings the tile back", () => {
    D.publishDiskMounts("tile", [m("/", 100, 50)]);
    expect(D.lowDiskNow()).toBeNull();
    D.publishDiskMounts("scan", [m("/vault", 100, 3)]);
    expect(D.lowDiskNow()).toBe("Low disk: /vault 3 % free");
    D.publishDiskMounts("scan", null);
    expect(D.lowDiskNow()).toBeNull();
    D.publishDiskMounts("tile", null);
    expect(D.lowDiskNow()).toBeNull();
  });
  it("the machine tile alone lights the badge, from the dials' own disk numbers", () => {
    D.publishMachineDisk({ diskTotal: 500 * GB, diskFree: 38 * GB });
    expect(D.lowDiskNow()).toBe("Low disk: / 8 % free");
    D.publishMachineDisk({ diskTotal: 500 * GB, diskFree: 300 * GB });
    expect(D.lowDiskNow()).toBeNull();
    D.publishMachineDisk({ diskTotal: 0, diskFree: 0 });
    D.publishDiskMounts("tile", null);
  });
  it("follows the setting: off silences it, 20 % names a disk that 10 % does not", () => {
    D.publishDiskMounts("scan", [m("/", 100, 15)]);
    expect(D.lowDiskNow()).toBeNull();
    store.set("agentglass.disk.warnPct", "20");
    expect(D.lowDiskNow()).toBe("Low disk: / 15 % free");
    store.set("agentglass.disk.warnPct", "0");
    expect(D.lowDiskNow()).toBeNull();
    store.delete("agentglass.disk.warnPct");
    D.publishDiskMounts("scan", null);
  });
});

describe("the report after a clean", () => {
  const run = (over: Partial<DiskCleanRunResult> = {}): DiskCleanRunResult => ({
    ok: true, dryRun: false, freed: 6 * GB, mounts: [{ mount: "/", before: 5 * GB, after: 11 * GB }, { mount: "/vault", before: 9 * GB, after: 9 * GB }],
    lines: [
      { id: "a", label: "uv cache", status: "freed", freed: 6 * GB },
      { id: "b", label: "Checkout orbit-ORBIT-1070", status: "needs-sudo", freed: 0 },
      { id: "c", label: "Docker cache", status: "nothing", freed: 0 },
    ], ...over,
  });
  it("says what came back, per disk before and after", () => {
    const v = D.resultView(run());
    expect(v.headline).toBe("6.0 GB freed");
    expect(v.mounts.map((m) => m.gained)).toEqual([6 * GB, 0]);
  });
  it("a disk that lost room while the clean ran shows no negative gain", () => {
    const v = D.resultView(run({ mounts: [{ mount: "/", before: 9 * GB, after: 7 * GB }] }));
    expect(v.mounts[0]!.gained).toBe(0);
  });
  it("flags what root owns, and never as success", () => {
    const v = D.resultView(run());
    expect(v.sudo).toEqual(["Checkout orbit-ORBIT-1070"]);
    expect(v.rows[1]!.tone).toBe("warn");
    expect(v.rows[1]!.note).toContain("sudo");
    expect(v.rows[2]!.tone).toBe("muted");
  });
  it("a refused clean says why instead of 'freed'", () => {
    const v = D.resultView(run({ ok: false, error: "a clean is already running", lines: [], mounts: [], freed: 0 }));
    expect(v.failed).toBe(true);
    expect(v.headline).toBe("a clean is already running");
  });
  it("a dry run says nothing was removed", () => expect(D.resultView(run({ dryRun: true })).headline).toBe("Dry run: nothing was removed."));
  it("a clean that gave nothing back does not claim to have freed anything", () => expect(D.resultView(run({ freed: 0 })).headline).toBe("Nothing came back"));
});
