/*
 * "Clean up all (N)" in the Closed tab runs the per-PR cleanup serially and a failed one does not stop the rest.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "../src/lib/api.ts";
import { cleanAll, cleanTargets, confirmBody, summaryWord } from "../src/lib/cleanAll.ts";
import type { LeftoverState } from "../src/lib/leftovers.ts";

const some = (items: number, bytes: number): LeftoverState => ({ kind: "some", items, bytes, groups: [] });
const plan = (pr: number, over: object = {}) => ({ ok: true, plan: { id: `p${pr}`, repo: "/r", pr, title: "t", url: "", state: "MERGED", mergedAt: 1, notMerged: false, branch: "b", slug: null, items: [], blocks: [], notes: [], ...over } });
const read = (f: string) => Bun.file(new URL(f, import.meta.url)).text();

describe("which cards count", () => {
  const states: Record<number, LeftoverState> = { 1: some(3, 100), 2: { kind: "none" }, 3: { kind: "computing" }, 4: some(1, 0), 5: { kind: "unknown", why: "x" }, 6: some(2, 5) };
  const rows = [1, 2, 3, 4, 5, 6].map((number) => ({ number, state: number === 6 ? "OPEN" : "MERGED" }));
  test("only finished cards whose inventory found something", () => {
    expect(cleanTargets(rows, (n) => states[n]).map((t) => t.pr)).toEqual([1, 4]);
  });
  test("a pull request listed twice is counted and run once", () => {
    expect(cleanTargets([{ number: 1, state: "MERGED" }, { number: 1, state: "MERGED" }], () => some(1, 1)).length).toBe(1);
  });
  test("the confirmation names the totals", () => {
    expect(confirmBody(cleanTargets(rows, (n) => states[n]))).toMatch(/^2 pull requests · 4 items · 100 B\n/);
  });
});

describe("running them", () => {
  const saved = { plan: api.cleanupPlan, run: api.cleanupRun };
  const log: string[] = [];
  let live = 0, peak = 0;
  beforeAll(() => {
    (api as any).cleanupPlan = async (_r: string, pr: number) => (pr === 3 ? plan(pr, { blocks: [{ kind: "x" }] }) : plan(pr));
    (api as any).cleanupRun = async (_r: string, pr: number) => {
      live++; peak = Math.max(peak, live); log.push(`run ${pr}`);
      await new Promise((r) => setTimeout(r, 2)); live--;
      if (pr === 2) throw new Error("docker is gone");
      return { ok: true, planId: `p${pr}`, items: [{ id: "a", kind: "worktree", target: "t", status: "done", detail: "" }], freedBytes: 10, failed: 0, summary: "" };
    };
  });
  afterAll(() => { (api as any).cleanupPlan = saved.plan; (api as any).cleanupRun = saved.run; });
  test("serially, in order, and a failure does not stop the rest", async () => {
    const steps: number[] = [];
    const s = await cleanAll("/r", [1, 2, 3, 4], (n) => steps.push(n));
    expect(log).toEqual(["run 1", "run 2", "run 4"]);
    expect(peak).toBe(1);
    expect(steps).toEqual([1, 2, 3, 4]);
    expect(s.done).toBe(2);
    expect(s.freed).toBe(20);
    expect(s.failed.map((f) => f.pr)).toEqual([2, 3]);
    expect(summaryWord(s)).toBe("Cleaned 2 pull requests · 20 B freed · 2 not cleaned");
  });
});

describe("where the button lives", () => {
  test("in the Closed header, hidden at zero, drawn from the house button", async () => {
    const btn = await read("../src/components/CleanAllButton.tsx");
    expect(btn).toContain("targets.length === 0");
    expect(btn).toContain("Clean up all (");
    expect(btn).toContain("<Button");
    expect(await read("../src/components/TriageBoard.tsx")).toContain("<CleanAllButton");
  });
});
