import { describe, expect, test } from "bun:test";
import { offerFor, stateOfPlan, stateOfRow, tooltipOf, type LeftoverState, type Surface } from "../src/lib/leftovers.ts";
import type { Plan, PlanItem } from "../src/lib/cleanupPr.ts";

const SURFACES: Surface[] = ["card", "closedRow", "panel", "lane"];
const item = (kind: string, bytes?: number): PlanItem => ({ id: `${kind}:x`, kind, target: "x", detail: "", bytes });
const plan = (items: PlanItem[]): Plan => ({
  id: "p", repo: "/w/orbit", pr: 77, title: "Retry queue", url: "", state: "MERGED", mergedAt: 1, notMerged: false,
  branch: "ORBIT-1042-retry-queue", slug: "ORBIT-1042", items, blocks: [], notes: [],
});
const GB = 1e9;

describe("a Clean up control exists only for an inventory with a real item, on every surface", () => {
  const cases: [string, LeftoverState | undefined][] = [
    ["empty plan", stateOfPlan(plan([]), false)],
    ["own bookkeeping only", stateOfPlan(plan([item("own-state"), item("worklog")]), false)],
    ["failed inventory", stateOfPlan(null, true)],
    ["failed row", stateOfRow({ pr: 1, unknown: true })],
    ["missing row", stateOfRow(undefined)],
    ["computing", stateOfPlan(null, false)],
    ["not asked yet", undefined],
  ];
  for (const [name, state] of cases) {
    for (const surface of SURFACES) {
      test(`${name} on ${surface}: no button`, () => expect(offerFor(state, surface).button).toBe(false));
    }
  }
  test("one real item gives the button, the size and the breakdown on every surface", () => {
    const s = stateOfPlan(plan([item("docker-image", 6.1 * GB), item("worktree", 222e6), item("own-state")]), false);
    for (const surface of SURFACES) {
      const o = offerFor(s, surface);
      expect(o.button).toBe(true);
      expect(o.chip).toBe("6.3 GB");
      expect(o.tooltip).toBe("Docker 6.1 GB · Worktree 222 MB");
    }
  });
  test("a row from the server with items gives the button; zero items gives none", () => {
    expect(offerFor(stateOfRow({ pr: 1, items: 2, bytes: 5 * GB, groups: [{ group: "docker", items: 2, bytes: 5 * GB }] }), "closedRow").button).toBe(true);
    expect(stateOfRow({ pr: 1, items: 0, bytes: 0, groups: [] })).toEqual({ kind: "none" });
  });
});

describe("what is drawn instead of a button", () => {
  test("computing is a skeleton on every surface", () => {
    for (const surface of SURFACES) expect(offerFor({ kind: "computing" }, surface)).toMatchObject({ skeleton: true, button: false, chip: null });
  });
  test("unknown is a muted chip with the reason, only on the panel", () => {
    const s: LeftoverState = { kind: "unknown", why: "git is not installed" };
    expect(offerFor(s, "panel")).toMatchObject({ chip: "Leftovers ?", muted: true, tooltip: "git is not installed", button: false });
    for (const surface of ["card", "closedRow", "lane"] as Surface[]) expect(offerFor(s, surface)).toMatchObject({ chip: null, muted: false });
  });
  test("nothing draws nothing", () => {
    expect(offerFor({ kind: "none" }, "closedRow")).toEqual({ button: false, chip: null, muted: false, tooltip: "", skeleton: false });
  });
  test("a group with no size is counted, not shown as 0 B", () => {
    expect(tooltipOf([{ group: "stashes", items: 2, bytes: 0 }])).toBe("Stashes 2 items");
  });
});
