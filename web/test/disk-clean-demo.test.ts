/*
 * The demo twin of the disk cleanup scan: the demo has no server to be slow,
 * empty or broken, so each face of the block is a `?disk=` switch, and each one
 * has to give the block what that face needs.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();
let search = "";
const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage);
stubGlobal("location", { get search() { return search; }, href: "http://localhost:5173/", pathname: "/", origin: "http://localhost:5173", hostname: "localhost", protocol: "http:", host: "localhost:5173", hash: "" } as unknown as Location);
stubGlobal("document", { documentElement: { setAttribute: () => {}, getAttribute: () => null, style: { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => "" } } });
stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
stubGlobal("navigator", { webdriver: true, userAgent: "Linux" });
stubGlobal("window", new EventTarget());
afterAll(() => { search = ""; });

const demo = await import("../src/lib/demo.ts");
const D = await import("../src/lib/diskClean.ts");

describe("demo disk cleanup", () => {
  it("the default plan has every verdict on two disks, one of them low", () => {
    const r = demo.machineDiskClean();
    expect(new Set(r.lines.map((l) => l.verdict))).toEqual(new Set(["safe", "ask", "inuse", "explain"]));
    expect(r.mounts.length).toBe(2);
    expect(D.lowDiskLabel(r.mounts, 10)).not.toBeNull();
    expect(D.phaseOf({ report: r, scanning: false, error: null, result: null })).toBe("plan");
  });
  it("the empty face keeps lines to explain but nothing to clean", () => {
    const r = demo.machineDiskClean("empty");
    expect(r.lines.length).toBeGreaterThan(0);
    expect(r.safeBytes).toBe(0);
    expect(D.phaseOf({ report: r, scanning: false, error: null, result: null })).toBe("empty");
  });
  it("the error face names what could not be read and still lists the rest", () => {
    const r = demo.machineDiskClean("error");
    expect(r.problems.length).toBe(1);
    expect(r.lines.length).toBeGreaterThan(0);
  });
  it("a clean of the demo plan reports each line, and root keeps one checkout", () => {
    const plan = D.wholePlan(demo.machineDiskClean());
    const run = demo.machineDiskCleanRun(plan.ids);
    expect(run.ok).toBe(true);
    expect(run.lines.map((l) => l.status)).toContain("needs-sudo");
    expect(run.freed).toBeGreaterThan(0);
    expect(D.resultView(run).sudo.length).toBe(1);
  });
  it("a clean never takes a line the scan does not call safe", () => {
    expect(demo.machineDiskCleanRun(["docker:volumes-used", "nope"]).lines).toEqual([]);
  });
  it("the face comes from the address, and an unknown value is the plan", () => {
    search = "?disk=fail"; expect(demo.diskDemoVariant()).toBe("fail");
    search = "?disk=staged"; expect(demo.diskDemoVariant()).toBe("staged");
    search = "?disk=whatever"; expect(demo.diskDemoVariant()).toBe("plan");
    search = ""; expect(demo.diskDemoVariant()).toBe("plan");
  });
});
