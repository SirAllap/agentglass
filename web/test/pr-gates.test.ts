import { describe, expect, test } from "bun:test";
import { commitMessagePreview, dockVerdict, gateDots, prGates } from "../src/lib/prGates.ts";
import { needsFrom } from "../src/lib/prOverviewBody.ts";
import { overviewRows, reviewShort } from "../src/lib/prOverviewView.ts";
import type { OverviewRow } from "../src/lib/prOverviewView.ts";

const rows = (t: Partial<Record<OverviewRow["key"], OverviewRow["tone"]>> = {}): OverviewRow[] => [
  { key: "checks", tone: t.checks ?? "ok", label: "Checks", text: "12 of 12 passing", short: "12 of 12 passed" },
  { key: "review", tone: t.review ?? "ok", label: "Review", text: "mia approved", short: "1 of 1 approved" },
  { key: "conflicts", tone: t.conflicts ?? "ok", label: "Conflicts", text: "No conflicts with main", short: "None" },
  { key: "branch", tone: t.branch ?? "ok", label: "Branch", text: "Up to date with main", short: "Up to date" },
];
const ok = { kind: "ok" as const, text: "Ready to land" };

describe("prGates", () => {
  test("four gates in a fixed order, each a shortcut to its tab", () => {
    const g = prGates(rows(), "OPEN");
    expect(g.map((x) => x.label)).toEqual(["Checks", "Reviews", "Conflicts", "Branch"]);
    expect(g.map((x) => x.tab)).toEqual(["checks", "conversation", "files", "commits"]);
  });
  test("a merged pull request keeps its words and loses its colour", () => {
    expect(prGates(rows({ checks: "bad" }), "MERGED").every((g) => g.tone === "idle")).toBe(true);
  });
  test("a missing row says so instead of inventing a state", () => {
    expect(prGates([], "OPEN")[0]).toMatchObject({ tone: "idle", value: "Not read yet" });
  });
  test("the folded header gets four dots, each with its words", () => {
    const d = gateDots(prGates(rows({ branch: "warn" }), "OPEN"));
    expect(d).toHaveLength(4);
    expect(d[3]).toMatchObject({ tone: "warn", label: "Branch: Up to date" });
  });
});

describe("dockVerdict", () => {
  test("all green is ready", () => {
    expect(dockVerdict({ state: "OPEN", isDraft: false, reason: ok, gates: prGates(rows(), "OPEN") })).toMatchObject({ tone: "ok", label: "Ready to merge", blockers: [] });
  });
  test("blockers come worst first and count in the label", () => {
    const c = dockVerdict({ state: "OPEN", isDraft: false, reason: { kind: "blocked", text: "A check is failing" }, gates: prGates(rows({ branch: "warn", checks: "bad" }), "OPEN") });
    expect(c.tone).toBe("bad");
    expect(c.label).toBe("2 things in the way");
    expect(c.blockers.map((b) => b.key)).toEqual(["checks", "branch"]);
  });
  test("one thing is singular, and a warning alone is a warning", () => {
    const c = dockVerdict({ state: "OPEN", isDraft: false, reason: { kind: "blocked", text: "x" }, gates: prGates(rows({ review: "warn" }), "OPEN") });
    expect(c).toMatchObject({ tone: "warn", label: "1 thing in the way" });
  });
  test("draft, merged and closed say their state, not a verdict", () => {
    const g = prGates(rows(), "OPEN");
    expect(dockVerdict({ state: "OPEN", isDraft: true, reason: ok, gates: g }).label).toBe("Draft");
    expect(dockVerdict({ state: "MERGED", isDraft: false, reason: { kind: "closed", text: "Already merged" }, gates: g })).toMatchObject({ tone: "merged", label: "Merged" });
    expect(dockVerdict({ state: "CLOSED", isDraft: false, reason: { kind: "closed", text: "This pull request is closed" }, gates: g }).label).toBe("Closed");
  });
  test("blocked with every gate green still says it is not ready", () => {
    expect(dockVerdict({ state: "OPEN", isDraft: false, reason: { kind: "blocked", text: "Merge queue" }, gates: prGates(rows(), "OPEN") }).label).toBe("Not ready");
  });
});

describe("commitMessagePreview", () => {
  const i = { title: "Add thing", number: 1042, head: "orbit/add-thing", base: "main" };
  test("squash uses the title and number, merge the GitHub default, rebase writes none", () => {
    expect(commitMessagePreview("squash", i)).toBe("Add thing (#1042)");
    expect(commitMessagePreview("merge", i)).toBe("Merge pull request #1042 from orbit/add-thing");
    expect(commitMessagePreview("rebase", i)).toContain("No new message");
  });
});

describe("gate tiles say a verdict, not a sentence", () => {
  test("reviews", () => {
    expect(reviewShort([])).toBe("Nobody asked");
    expect(reviewShort([{ state: "awaiting" }, { state: "commented" }])).toBe("Waiting on 2");
    expect(reviewShort([{ state: "approved" }, { state: "approved" }])).toBe("2 of 2 approved");
    expect(reviewShort([{ state: "approved" }, { state: "changes" }])).toBe("Changes requested");
  });
  test("checks and the tile value", () => {
    const f = { checks: { success: 14, failure: 0, pending: 0, skipped: 0, total: 14 }, reviewers: [], conflicted: false, head: "a", base: "main", behind: null };
    expect(prGates(overviewRows(f), "OPEN")[0]!.value).toBe("14 of 14 passed");
    expect(prGates(overviewRows({ ...f, checks: { ...f.checks, success: 12, failure: 2 } }), "OPEN")[0]!.value).toBe("2 failed");
    expect(prGates(overviewRows({ ...f, checks: { success: 0, failure: 0, pending: 0, skipped: 0, total: 0 } }), "OPEN")[0]!.value).toBe("None reported");
  });
});

describe("dock chip count is the Overview's list", () => {
  test("needs decide the count and the sheet rows", () => {
    const needs = needsFrom([], { canFixConflicts: false, stackBase: 479 });
    const c = dockVerdict({ state: "OPEN", isDraft: false, reason: { kind: "blocked", text: "x" }, gates: prGates(rows(), "OPEN"), needs });
    expect(c.label).toBe("1 thing in the way");
    expect(c.blockers).toHaveLength(needs.length);
  });
});
