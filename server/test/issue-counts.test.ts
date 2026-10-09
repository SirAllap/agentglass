/*
 * The numbers on the phone's Mine / Open / All issue filters.
 *
 * GitHub's search counts pull requests and issues together unless told
 * otherwise, so a count without `is:issue` is a number that looks right on a
 * repository with no pull requests and is wrong on every other one. And a
 * missing answer must not become zero: "0 open" on a repository GitHub never
 * answered for is a false statement about its issues.
 */
import { describe, expect, it } from "bun:test";
import { countsFromAnswer, issueCountSearches } from "../src/issues.ts";

describe("the three searches", () => {
  const q = issueCountSearches("acme/orbit");

  it("every one is limited to issues, in this repository", () => {
    for (const s of Object.values(q)) {
      expect(s).toContain("repo:acme/orbit");
      expect(s).toContain("is:issue");
    }
  });

  it("Mine is open and assigned to the caller; All has no state", () => {
    expect(q.mine).toContain("is:open");
    expect(q.mine).toContain("assignee:@me");
    expect(q.open).toContain("is:open");
    expect(q.all).not.toContain("is:open");
  });
});

describe("the answer", () => {
  it("reads the three counts", () => {
    expect(countsFromAnswer({ mine: { issueCount: 2 }, open: { issueCount: 7 }, all: { issueCount: 31 } }))
      .toEqual({ mine: 2, open: 7, all: 31 });
  });

  it("a missing count is no answer, not a zero", () => {
    expect(countsFromAnswer({ mine: { issueCount: 0 }, open: { issueCount: 7 } })).toBeNull();
    expect(countsFromAnswer(undefined)).toBeNull();
  });
});
