/*
 * Refresh with one pull request open refreshes that pull request.
 *
 * The button forced both lists and dropped the check, behind and card caches
 * of every row, so the board behind the page came back with every card
 * loading again — a page of requests to re-read one.
 */
import { describe, expect, it } from "bun:test";
import { overlayDetail, refreshPlan } from "../src/lib/prRefresh.ts";
import type { PrDetail, PrSummary } from "../../shared/types.ts";

const row = (number: number, title: string): PrSummary => ({
  number, title, author: "ada", state: "OPEN", isDraft: false, headRefName: `feat/x-${number}`,
  baseRefName: "main", url: `https://github.com/acme/orbit/pull/${number}`, updatedAt: "2026-01-01T00:00:00Z",
  reviewDecision: null, additions: 1, deletions: 1, changedFiles: 1, labels: [], assignees: [], milestone: null,
  checksLoaded: false,
} as unknown as PrSummary);

describe("refreshPlan", () => {
  it("asks for the lists when nothing is open", () => {
    expect(refreshPlan(null)).toEqual({ list: true, pr: null });
  });
  it("asks for exactly the open pull request, and no list, when one is", () => {
    expect(refreshPlan(1042)).toEqual({ list: false, pr: 1042 });
  });
});

describe("overlayDetail", () => {
  const detail = { ...row(2, "renamed"), state: "MERGED", checks: { total: 3 }, } as unknown as PrDetail;
  it("updates only the row of the pull request that was re-read", () => {
    const rows = [row(1, "one"), row(2, "two"), row(3, "three")];
    const out = overlayDetail(rows, detail);
    expect(out[1].title).toBe("renamed");
    expect(out[1].state).toBe("MERGED");
    expect(out[1].checksLoaded).toBe(true);
    expect(out[0]).toBe(rows[0]);
    expect(out[2]).toBe(rows[2]);
  });
  it("hands back the same array when the row already says the same", () => {
    const once = overlayDetail([row(2, "two")], detail);
    expect(overlayDetail(once, detail)).toBe(once);
  });
  it("hands back the same array when the pull request is not on the board", () => {
    const rows = [row(1, "one")];
    expect(overlayDetail(rows, detail)).toBe(rows);
  });
});

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
describe("the Refresh button", () => {
  const start = src.indexOf("const plan = refreshPlan(selected);");
  const branch = src.slice(start, src.indexOf("return;", start));
  it("does not touch a list or another row's caches on the one-pull-request branch", () => {
    expect(start).toBeGreaterThan(0);
    for (const bad of ["loadList(", "forgetBehind(", "forgetRollups(", "forgetCards(", "setBoardTick"])
      expect(branch).not.toContain(bad);
    expect(branch).toContain("loadDetail(plan.pr, true)");
  });
});
