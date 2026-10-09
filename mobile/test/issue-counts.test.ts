/*
 * The Issues tab drew "Mine / Open / All" with no numbers, so a repository
 * with nothing assigned to you looked the same as one with forty issues until
 * a tab was opened. Each filter carries its count now; this pins the sum
 * across repositories and that the screen really asks and really draws it.
 */
import { describe, expect, test } from "bun:test";
import { sumIssueCounts } from "../src/model/issueCounts.ts";
import type { IssueViewCounts } from "../../shared/types.ts";

const counts = (over: Partial<IssueViewCounts>): IssueViewCounts => ({ mine: 0, open: 0, all: 0, ...over });

describe("sumIssueCounts", () => {
  test("adds one repository's counts to another's", () => {
    expect(sumIssueCounts([counts({ mine: 1, open: 4, all: 9 }), counts({ mine: 2, open: 1, all: 3 })]))
      .toEqual({ mine: 3, open: 5, all: 12 });
  });

  test("nobody answering is null, not a row of zeros", () => {
    expect(sumIssueCounts([])).toBeNull();
  });
});

const src = (await Bun.file(new URL("../app/(tabs)/issues.tsx", import.meta.url)).text())
  .split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");

describe("the Issues screen", () => {
  test("asks the server for the counts", () => {
    expect(src).toContain("/issues/counts?root=");
  });

  test("hands each filter its own count", () => {
    expect(src).toContain("count: counts?.[f.id]");
  });

  test("a pull-to-refresh asks for the counts again", () => {
    const at = src.indexOf("const onRefresh");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, src.indexOf("}, [", at))).toContain("loadCounts()");
  });
});
