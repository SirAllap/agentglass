import { describe, expect, test } from "bun:test";
import type { GitBranch } from "../../shared/types.ts";
import { branchDrift, goneBanner, sectionBranches } from "../src/lib/gitBranchList.ts";

const b = (name: string, extra: Partial<GitBranch> = {}): GitBranch => ({ name, current: false, upstream: null, track: "", date: "1 d ago", subject: "x", ...extra });

describe("sectionBranches", () => {
  const rows = [
    b("main"), b("feat/billing-export"), b("review/pr-1042"), b("spike/pdf"), b("chore/sdk-4.2", { mergedIntoTrunk: true }),
    b("fix/a"), b("fix/b"), b("fix/c"), b("docs/readme", { mergedIntoTrunk: true }), b("lonely"), b("fix/merged-one", { mergedIntoTrunk: true }),
  ];
  const plan = sectionBranches(rows, "main");
  test("the current branch is alone under CURRENT, the next four are RECENT", () => {
    expect(plan.sections.slice(0, 2).map((s) => [s.id, s.size])).toEqual([["current", 1], ["recent", 4]]);
    expect(plan.order[0].name).toBe("main");
  });
  test("older rows fold: families of two or more, merged together, the lone one stays open", () => {
    const by = Object.fromEntries(plan.sections.map((s) => [s.id, s]));
    expect(by["family:fix"]).toMatchObject({ size: 3, startsFolded: true, raw: true, label: "fix/" });
    expect(by.merged).toMatchObject({ size: 2, startsFolded: true });
    expect(by.older).toMatchObject({ size: 1, startsFolded: false });
  });
  test("rows come back in drawn order and none is lost", () => {
    expect(plan.order.length).toBe(rows.length);
    expect(plan.sections.reduce((n, s) => n + s.size, 0)).toBe(rows.length);
  });
});

describe("branchDrift", () => {
  const up = { ahead: 2, behind: 0 };
  test("a branch is measured against the trunk", () => {
    expect(branchDrift(b("feat/x", { aheadTrunk: 4, behindTrunk: 2 }), "origin/main", up)).toEqual({ ahead: 4, behind: 2, vs: "trunk" });
  });
  test("the trunk's own branch shows its upstream, whatever origin/ prefix the trunk carries", () => {
    expect(branchDrift(b("main", { aheadTrunk: 0, behindTrunk: 0 }), "origin/main", up)).toEqual({ ahead: 2, behind: 0, vs: "upstream" });
  });
  test("without trunk numbers the upstream stands in", () => {
    expect(branchDrift(b("feat/x"), "main", up).vs).toBe("upstream");
  });
});

describe("goneBanner", () => {
  test("says nothing for none, and agrees with one", () => {
    expect(goneBanner(0, "main")).toBeNull();
    expect(goneBanner(1, "origin/main")).toEqual({ bold: "1 branch is gone on origin", rest: " and its work is in main." });
    expect(goneBanner(3, "main")?.bold).toBe("3 branches are gone on origin");
  });
});
