/*
 * Every list on a pull request is a page, and the panel used to take the first
 * one as the whole answer.
 *
 * Reported twice, an hour apart, on real branches: 275 files listed as 100, and
 * "Showing the most recent 100 commits" on one with more. Threads, comments,
 * the timeline and the check contexts all had the same cap and nobody had hit
 * them yet.
 *
 * The walk itself is `gh`, a subprocess and a network, so what is pinned here
 * is the contract around it: that the first page asks for a cursor, that later
 * pages ask for exactly the same fields as the first, that the walk is bounded,
 * and that what is still missing is still counted.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/prs.ts", import.meta.url)).text();

/** Every connection the detail query pages through. */
const CONNS = ["reviews", "comments", "commits", "files", "reviewThreads", "timelineItems"];

describe("the lists a pull request is made of", () => {
  it("asks every one of them for a cursor, or there is nothing to page with", () => {
    for (const key of CONNS) {
      expect(src).toContain(`{ key: "${key}"`);
    }
    // pageInfo on the first page of each, in the query itself.
    // From the query onwards — another query earlier in the file ends with the
    // same three braces, so `indexOf` alone slices backwards and finds nothing.
    const from = src.indexOf("const DETAIL_QUERY");
    const q = src.slice(from, src.indexOf("} } }`;", from));
    for (const key of CONNS) {
      const i = q.indexOf(`\n    ${key}(`);
      expect(i, `no ${key} line in the detail query`).toBeGreaterThan(-1);
      expect(q.slice(i, q.indexOf("\n", i + 1))).toContain("pageInfo{hasNextPage endCursor hasPreviousPage startCursor}");
    }
  });

  it("asks later pages for the same fields, by construction", () => {
    /* The whole reason the selections are constants: a second copy of a field
       list is a second field list that drifts, and a row from page two missing
       a field renders and is quietly wrong. The follow-up query interpolates
       `conn.sel`, which IS the constant the first page used. */
    for (const name of ["SEL_REVIEWS", "SEL_COMMENTS", "SEL_COMMITS", "SEL_FILES", "SEL_THREADS", "SEL_TIMELINE"]) {
      expect(src).toContain(`const ${name} = \``);
    }
    expect(src).toContain("${conn.key}(${conn.arg}, ${cursorArg}:$cursor){pageInfo{hasNextPage endCursor hasPreviousPage startCursor} ${conn.sel}}");
  });

  it("walks the `last:` ones backwards, so a cap keeps the recent end", () => {
    // Commits and the timeline are asked for newest-first. Paging forward from
    // there would spend the budget on the oldest hundred, which is the half
    // nobody opened the pull request to read.
    expect(src).toContain('{ key: "commits", arg: "last:100", dir: "back"');
    expect(src).toContain('const cursorArg = conn.dir === "back" ? "before" : "after";');
    // …and puts those pages in front, because everything downstream assumes one
    // list in the order it happened.
    expect(src).toContain('if (conn.dir === "back") out.unshift(...got.nodes);');
  });

  it("is bounded, because the round trips are sequential", () => {
    expect(src).toContain("page < conn.pages && cursor");
    for (const key of CONNS) {
      const i = src.indexOf(`{ key: "${key}"`);
      expect(i, `no CONNECTIONS entry for ${key}`).toBeGreaterThan(-1);
      // The entry ends at the line's end — `timelineItems` carries a template
      // literal with braces in it, so brace-matching is the wrong tool here.
      expect(src.slice(i, src.indexOf("\n", i))).toMatch(/pages: \d+/);
    }
  });

  it("treats a failed page as the end of the list rather than an error", () => {
    // What is already in hand beats none, and the counts below say the rest is
    // missing either way.
    expect(src).toContain("if (!got?.nodes?.length) break;");
  });

  it("pages across connections at once and within one in order", () => {
    // A cursor is only known once the page before it has answered; two
    // different lists have nothing to say to each other.
    expect(src).toContain("await Promise.all([fillChecks(p, repo, number), ...CONNECTIONS.map(");
  });

  it("still says what it never got, and means the cap rather than a page size", () => {
    expect(src).toContain("files: Math.max(0, (p.changedFiles ?? 0) - files.length) || undefined");
    expect(src).toContain("commits: p.commits?.pageInfo?.capped ? (p.commits?.nodes || []).length : undefined");
  });
});
