/*
 * What the window does with a disk cleanup an agent staged (diskclean.stage),
 * without a renderer: the handler leaves the ids in the mailbox and opens the
 * machine panel's Resources tab and nothing else, the plan keeps only the lines
 * the scan on screen calls safe and says why it dropped the rest, and the other
 * screens that share the mailbox leave the request alone.
 *
 * The registry half (what the door takes) is server/test/ui-stage.test.ts; the
 * level model's guard over the handler is ui-level-guards.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";
import type { ControlCmd, DiskCleanLine } from "../../shared/types.ts";
import type { UiCtx } from "../src/lib/uiActions.ts";

const stubGlobal = globalStubs();
stubGlobal("window", new EventTarget());
stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 } as unknown as Storage);
stubGlobal("location", new URL("http://localhost:5173/"));
stubGlobal("document", { documentElement: { getAttribute: () => "graphite", setAttribute: () => {}, style: { setProperty: () => {}, getPropertyValue: () => "" } } });
stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
const fetched: unknown[] = [];
stubGlobal("fetch", ((...a: unknown[]) => { fetched.push(a); throw new Error("a staging handler must not fetch"); }) as unknown as typeof fetch);

const { runControl } = await import("../src/lib/uiActions.ts");
const { latchStage, peekStage, clearStage } = await import("../src/lib/stageIntent.ts");
const { diskStageOf, clearDiskStage, needsStageScan, planDiskStage } = await import("../src/lib/diskStage.ts");
const { labelOf } = await import("../src/lib/offerLabels.ts");

const ui = (id: string, args: Record<string, unknown>) => ({ cmd: "ui", do: id, args }) as unknown as ControlCmd;
function ctx(as?: string) {
  const calls: unknown[][] = [];
  const c = { goView: (...a: unknown[]) => { calls.push(["goView", ...a]); }, setMachine: (...a: unknown[]) => { calls.push(["setMachine", ...a]); }, as } as unknown as UiCtx;
  return { c, calls };
}
const read = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");

const line = (over: Partial<DiskCleanLine> & { id: string }): DiskCleanLine => ({
  kind: "package-cache", mount: "/", label: "cache", bytes: 1e9, verdict: "safe", why: "ok",
  target: { via: "fs", root: "/home/acme/.cache", path: "/home/acme/.cache/x" }, ...over,
});
const LINES: DiskCleanLine[] = [
  line({ id: "cache:uv", bytes: 3e9 }),
  line({ id: "docker:cache", kind: "docker-cache", bytes: 8e9, target: { via: "docker", what: "cache" } }),
  line({ id: "docker:images-used", kind: "docker-images", verdict: "inuse", target: null }),
  line({ id: "worktree:/home/acme/code/orbit-wip", kind: "worktree", verdict: "ask", target: null }),
  line({ id: "snapshots", kind: "snapshots", verdict: "explain", bytes: null, target: null }),
  line({ id: "trash", kind: "trash", bytes: null }),
];

beforeEach(() => { clearStage(); fetched.length = 0; });
afterEach(() => { clearStage(); });

describe("the handler", () => {
  it("latches the ids under the caller's name, opens Machine > Resources, and touches no network", () => {
    const k = ctx("tidy-bot");
    expect(runControl(ui("diskclean.stage", { ids: "cache:uv\ndocker:cache" }), k.c)).toBe("diskclean.stage");
    expect(peekStage()).toMatchObject({ id: "diskclean.stage", by: "tidy-bot", a: { ids: "cache:uv\ndocker:cache" } });
    expect(k.calls).toEqual([["setMachine", "resources"]]);
    expect(fetched).toEqual([]);
  });

  it("a caller with no name is shown as 'an agent'", () => {
    runControl(ui("diskclean.stage", { ids: "cache:uv" }), ctx().c);
    expect(peekStage()?.by).toBe("an agent");
  });

  it("a frame with a bad argument latches nothing and opens nothing (the window's second look)", () => {
    const k = ctx("x");
    for (const ids of ["", "cache:uv\ncache:uv", "cache:uv‮", "a".repeat(600)]) expect(runControl(ui("diskclean.stage", { ids }), k.c), JSON.stringify(ids)).toBeNull();
    expect(peekStage()).toBeNull();
    expect(k.calls).toEqual([]);
  });

  it("the handler is the latch and the machine panel and names no api, run or fetch", async () => {
    const src = await read("lib/uiActions.ts");
    const at = src.indexOf('"diskclean.stage":');
    expect(at).toBeGreaterThan(0);
    const h = code(src.slice(at, src.indexOf("\n  // Stage:", at)));
    expect(h).toContain("latchStage(");
    expect(h).toContain('c.setMachine("resources")');
    expect(h).not.toMatch(/\bapi\.|\bfetch\s*\(|machineDiskCleanRun|\brun\w*\(/);
  });

  it("has words for its chip", () => {
    expect(labelOf(ui("diskclean.stage", { ids: "cache:uv\ndocker:cache" }))).toBe("Machine > Clean up disk (2 chosen)");
  });
});

describe("the plan the machine panel draws", () => {
  const req = (ids: string) => { latchStage({ id: "diskclean.stage", a: { ids } }, "tidy-bot"); return diskStageOf(peekStage())!; };

  it("keeps the safe lines in the order they were named and adds their bytes", () => {
    const p = planDiskStage(req("docker:cache\ncache:uv"), LINES);
    expect(p.ids).toEqual(["docker:cache", "cache:uv"]);
    expect(p.bytes).toBe(11e9);
    expect(p.dropped).toEqual([]);
    expect(p.by).toBe("tidy-bot");
  });

  it("drops a line that is in use, needs a look, is only explained or is gone, each with its reason", () => {
    const p = planDiskStage(req("docker:images-used\nworktree:/home/acme/code/orbit-wip\nsnapshots\ncache:gone\ncache:uv"), LINES);
    expect(p.ids).toEqual(["cache:uv"]);
    expect(p.dropped.map((d) => d.id)).toEqual(["docker:images-used", "worktree:/home/acme/code/orbit-wip", "snapshots", "cache:gone"]);
    expect(p.dropped[0]!.why).toContain("in use");
    expect(p.dropped[1]!.why).toContain("needs a look");
    expect(p.dropped[2]!.why).toContain("never removed");
    expect(p.dropped[3]!.why).toContain("not in the scan");
  });

  it("a line whose verdict is safe but has no target is not kept, whatever the scan said", () => {
    const p = planDiskStage(req("cache:odd"), [line({ id: "cache:odd", target: null })]);
    expect(p.ids).toEqual([]);
    expect(p.dropped).toHaveLength(1);
  });

  it("a line that is not safe is dropped even if something handed it a target", () => {
    for (const verdict of ["ask", "inuse", "explain"] as const) {
      const p = planDiskStage(req("cache:odd"), [line({ id: "cache:odd", verdict })]);
      expect(p.ids, verdict).toEqual([]);
      expect(p.dropped, verdict).toHaveLength(1);
    }
  });

  it("an unmeasured line counts for nothing, and an empty scan keeps nothing", () => {
    expect(planDiskStage(req("trash"), LINES)).toMatchObject({ ids: ["trash"], bytes: 0 });
    expect(planDiskStage(req("cache:uv"), []).ids).toEqual([]);
  });

  it("a new request is a new plan", () => {
    const a = planDiskStage(req("cache:uv"), LINES);
    const b = planDiskStage(req("cache:uv"), LINES);
    expect(b.n).toBeGreaterThan(a.n);
  });
});

describe("fetching the cached scan for a staged plan", () => {
  it("is tried once per request: a scan that fails does not make the panel ask again and again", () => {
    // The panel's effect, run again every time its inputs change; the scan fails each time, so nothing is ever shown.
    let triedFor: number | null = null, scans = 0;
    const effect = (n: number, scanning: boolean) => { if (needsStageScan({ n }, triedFor, scanning)) { triedFor = n; scans++; } };
    effect(7, false);                        // the request arrives
    effect(7, true); effect(7, false);       // the scan runs and fails: scanning goes true, then false
    for (let i = 0; i < 5; i++) effect(7, false);
    expect(scans).toBe(1);
    effect(8, false);                        // a new request is a new try
    expect(scans).toBe(2);
  });
  it("waits while a scan is already running", () => {
    expect(needsStageScan({ n: 1 }, null, true)).toBe(false);
    expect(needsStageScan({ n: 1 }, null, false)).toBe(true);
  });
});

describe("the mailbox is shared with the pull request panel and the Finder", () => {
  it("diskStageOf answers only for a disk request", () => {
    latchStage({ id: "finder.op.stage", a: { op: "trash", path: "/home/acme/a.txt" } }, "x");
    expect(diskStageOf(peekStage())).toBeNull();
    latchStage({ id: "diskclean.stage", a: { ids: "cache:uv" } }, "x");
    expect(diskStageOf(peekStage())?.a.ids).toBe("cache:uv");
    expect(diskStageOf(null)).toBeNull();
  });

  it("clearDiskStage leaves another screen's request where it is", () => {
    latchStage({ id: "pr.comment.stage", a: { repo: "acme/orbit", number: 42, body: "Looks right." } }, "x");
    clearDiskStage();
    expect(peekStage()?.id).toBe("pr.comment.stage");
    latchStage({ id: "diskclean.stage", a: { ids: "cache:uv" } }, "x");
    clearDiskStage();
    expect(peekStage()).toBeNull();
  });

  it("the pull request panel and the Finder both pass over a disk request", async () => {
    const pr = code(await read("components/PrPanel.tsx"));
    expect(pr).toContain('r.id === "finder.op.stage" || r.id === "diskclean.stage"');
    const fin = code(await read("components/finder/machine/useFinderOps.tsx"));
    expect(fin).toContain('staged.id !== "finder.op.stage"');
  });
});
