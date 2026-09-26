/*
 * The discussion under an issue, read out of `gh issue view --json comments`.
 *
 * The list view collapses `comments` to a count, and the detail did the same,
 * so the one thing a phone could say about a six-comment issue was "Comments 6".
 * The array was already in the answer; what was missing is a rule for reading
 * it that survives a deleted account, a comment with no body and a long thread.
 */
import { describe, expect, it } from "bun:test";
import { threadOf } from "../src/issues.ts";

const c = (over: Record<string, unknown> = {}) => ({
  author: { login: "ada" }, body: "looks like the cache", createdAt: "2026-09-01T10:00:00Z",
  url: "https://github.com/acme/orbit/issues/12#issuecomment-1", ...over,
});

describe("an issue's thread", () => {
  it("keeps who said what, when, and where it lives", () => {
    expect(threadOf([c()])).toEqual([{
      author: "ada", body: "looks like the cache", createdAt: "2026-09-01T10:00:00Z",
      url: "https://github.com/acme/orbit/issues/12#issuecomment-1",
    }]);
  });

  it("survives a deleted account and a missing body", () => {
    const out = threadOf([c({ author: null, body: undefined })]);
    expect(out[0]!.author).toBe("ghost");
    expect(out[0]!.body).toBe("");
  });

  it("is oldest first and cut to the newest 50 of a long thread", () => {
    const many = Array.from({ length: 60 }, (_, i) => c({ body: `n${i}` }));
    const out = threadOf(many);
    expect(out).toHaveLength(50);
    expect(out[0]!.body).toBe("n10");
    expect(out[49]!.body).toBe("n59");
  });

  it("cuts a very long body", () => {
    expect(threadOf([c({ body: "x".repeat(9000) })])[0]!.body).toHaveLength(4000);
  });

  it("says nothing when there is no array", () => {
    expect(threadOf(undefined)).toEqual([]);
    expect(threadOf(3)).toEqual([]);
  });
});
