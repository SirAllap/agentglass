/*
 * The Issues screen's own decisions: what a search keeps, and the verdict a
 * linked pull request carries. The fixtures are the shape of the real rows.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IssuePr, IssueRow, PrSummary } from "../../shared/types.ts";
import { issueMatches, prVerdict } from "../src/model/issueList.ts";

const issue = (over: Partial<IssueRow> = {}): IssueRow => ({
  number: 88, title: "Sync drops batches on upstream 503", state: "OPEN", author: "bob",
  labels: [{ name: "bug", color: "d73a4a" }], assignees: ["ada"], comments: 1,
  updatedAt: "2026-09-30T10:00:00Z", url: "https://github.com/acme/orbit/issues/88", ...over,
});

describe("issue search", () => {
  test("title, number, label, author and assignee all find it", () => {
    for (const q of ["batches", "#88", "88", "bug", "bob", "ada", "BATCHES 503"]) {
      expect(issueMatches(issue(), q), q).toBe(true);
    }
  });
  test("every word has to be there, and empty keeps everything", () => {
    expect(issueMatches(issue(), "batches nothing")).toBe(false);
    expect(issueMatches(issue(), "#89")).toBe(false);
    expect(issueMatches(issue(), "   ")).toBe(true);
  });
});

describe("linked pull request verdict", () => {
  const pr = (over: Partial<IssuePr> = {}): IssuePr => ({
    number: 101, title: "Retry on 503", state: "OPEN", url: "https://github.com/acme/orbit/pull/101",
    draft: false, linked: true, ...over,
  });
  const summary = {
    number: 101, isDraft: false, reviewDecision: "CHANGES_REQUESTED",
    humanReview: { kind: "changes", who: ["bob"] }, checks: { total: 3, failure: 0, pending: 0 },
  } as unknown as PrSummary;

  test("an open pull request says what its card says", () => {
    expect(prVerdict(pr(), [summary])).toMatchObject({ label: "Changes requested by bob", tone: "bad" });
  });
  test("one the list does not have, or one that is finished, says nothing extra", () => {
    expect(prVerdict(pr(), [])).toBeNull();
    expect(prVerdict(pr(), null)).toBeNull();
    expect(prVerdict(pr({ state: "MERGED" }), [summary])).toBeNull();
  });
});

describe("wiring", () => {
  const read = (p: string): string => readFileSync(join(import.meta.dir, "..", p), "utf8");
  test("the list searches and the detail shows the verdict", () => {
    expect(read("app/(tabs)/issues.tsx")).toContain("issueMatches(");
    expect(read("app/issue/[number].tsx")).toContain("prVerdict(");
  });
  test("the detail's action bar is 52 tall", () => {
    expect(read("app/issue/[number].tsx")).toMatch(/const BAR_BTN = \{[^}]*minHeight: 52/);
  });
});
