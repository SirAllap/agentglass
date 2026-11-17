import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { projectCols, worktreeLabel } from "../src/lib/projectsCols.ts";

describe("projectCols", () => {
  test("wide list keeps every column", () => {
    const c = projectCols(1000);
    expect(c.branchCol && c.touched && c.sync).toBe(true);
    expect(c.template.split(" ")).toHaveLength(9);
  });
  test("800 device px at 200 % zoom (400 css px) folds branch and drops the rest", () => {
    const c = projectCols(400);
    expect(c.branchCol).toBe(false);
    expect(c.touched).toBe(false);
    expect(c.template).not.toContain("150px");
  });
  test("mid width folds only the branch", () => {
    const c = projectCols(650);
    expect(c.branchCol).toBe(false);
    expect(c.touched).toBe(true);
  });
  test("template track count matches the visible cells", () => {
    for (const w of [300, 400, 500, 600, 800, 1200]) {
      const c = projectCols(w);
      expect(c.template.split(" ").length).toBe(6 + +c.branchCol + +c.sync + +c.touched);
    }
  });
});

describe("folded branch chip layout (source)", () => {
  const src = readFileSync(new URL("../src/components/projects/Rows.tsx", import.meta.url), "utf8");
  test("name shrinks with ellipsis, chip never shrinks", () => {
    expect(src).toContain('nm.head ? "whitespace-nowrap" : "truncate"');
    expect(src).toContain('{ flex: "0 1 auto", minWidth: 0 }');
    expect(src).toContain('style={{ flex: "0 1 auto" }} data-tip={r.name}');
    expect(src).toMatch(/title=\{r\.branch\} style=\{\{ flex: "0 0 auto", maxWidth: "45%"/);
  });
});

describe("worktreeLabel", () => {
  test("folded cell shortens to N wt, wide cell keeps the words", () => {
    expect(worktreeLabel(3, true)).toBe("3 wt");
    expect(worktreeLabel(1, false)).toBe("1 worktree");
    expect(worktreeLabel(3, false)).toBe("3 worktrees");
  });
});
