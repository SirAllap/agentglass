import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { starredAt } from "../src/lib/jiraTree.ts";

const rail = readFileSync(join(import.meta.dir, "../src/components/jira/JiraFoldedRail.tsx"), "utf8");

describe("g 1-9 while the sidebar is folded to the rail", () => {
  test("the rail listens on the window through the same step as the tree (its behaviour: jira-review-fixes.test.ts)", () => {
    expect(rail).toContain('window.addEventListener("keydown", h, true)');
    expect(rail).toContain("gotoStep(e, goto.current.at, Date.now(), jiraViewActiveNow())");
  });
  test("the digit picks the Nth starred view, 1-based", () => {
    const views = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(starredAt(views, "2")?.id).toBe("b");
    expect(starredAt(views, "0")).toBeNull();
    expect(starredAt(views, "9")).toBeNull();
  });
});
