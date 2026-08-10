/*
 * A pull request bigger than one page of file names.
 *
 * Reported from the app on a real one: 275 files changed, and the panel showed
 * 100 with a line saying the other 175 were on github.com. That is exactly the
 * review somebody opens this panel for — a tree and a filter, not a browser tab
 * — so the list is paged now.
 *
 * `restOfFiles` walks a cursor through `gh`, which is a subprocess and a
 * network, so what is asserted here is the contract around it: that the first
 * page asks for the cursor at all, that the walk is bounded, and that the count
 * of what is still missing is still told. The walk itself is one loop over that
 * cursor and is exercised the moment anybody opens a big pull request.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/prs.ts", import.meta.url)).text();

describe("the file list of a big pull request", () => {
  it("asks for the cursor on the first page, or there is nothing to page with", () => {
    expect(src).toContain("files(first:100){pageInfo{hasNextPage endCursor} nodes{");
  });

  it("walks the rest with the same fields, so a later page is not a poorer row", () => {
    // A second query listing fewer fields would give files past the hundredth a
    // missing "viewed" tick and no line counts — worse than not listing them.
    const first = src.match(/files\(first:100\)\{pageInfo[^}]*\} nodes\{([^}]*)\}/)?.[1]?.trim();
    const more = src.match(/files\(first:100,after:\$after\)\{pageInfo[^}]*\} nodes\{([^}]*)\}/)?.[1]?.trim();
    expect(first).toBeTruthy();
    expect(more).toBe(first!);
  });

  it("is bounded, because the round trips are sequential", () => {
    // Eight pages, 900 files. Past that the branch is a vendor drop and forty
    // sequential requests would hold the detail open on a question nobody asked.
    expect(src).toContain("const FILE_PAGES_MAX = 8;");
    expect(src).toContain("page < FILE_PAGES_MAX && cursor");
  });

  it("treats a failed page as the end of the list rather than an error", () => {
    // What is already in hand beats none, and the count below says the rest is
    // missing either way.
    expect(src).toContain("if (!conn?.nodes?.length) break;");
  });

  it("still says how many it never got", () => {
    expect(src).toContain("files: Math.max(0, (p.changedFiles ?? 0) - files.length) || undefined");
  });
});
