import { describe, expect, it } from "bun:test";

/*
 * The pickers show everything the repository has, not the first hundred.
 *
 * Reported on a real repository: `review:caveman` was on the pull request in
 * GitHub and missing from the label picker here. It is the 106th label of 153
 * alphabetically, and the fetch asked for `per_page=100` with no pagination —
 * so the answer was not "no such label", it was "we stopped reading".
 *
 * Asserted on the source because the alternative is a live GitHub call in the
 * suite. What matters is which endpoints pay for pagination and which do not:
 * a label list is a set somebody expects to see whole, and 894 branches is nine
 * round trips for a dropdown nobody scrolls to the end of.
 */
const src = await Bun.file(new URL("../src/prs.ts", import.meta.url)).text();

const facetBlock = (() => {
  const at = src.indexOf("const [contribs, assignees, labels, milestones, branches]");
  return src.slice(at, src.indexOf("]);", at));
})();

describe("the facet lists", () => {
  it("reads every page of the labels", () => {
    expect(facetBlock).toContain("ghJsonAll<any>(`repos/${r}/labels?per_page=100`");
    expect(facetBlock).not.toContain('ghJson<any[]>(["api", `repos/${r}/labels');
  });

  it("keeps the expensive ones capped, on purpose", () => {
    // Branches and people are lists you filter, not sets you check off.
    expect(facetBlock).toContain('ghJson<any[]>(["api", `repos/${r}/branches?per_page=100`]),');
    expect(facetBlock).toContain('ghJson<any[]>(["api", `repos/${r}/assignees?per_page=100`]),');
  });

  it("slurps, because a bare --paginate is not JSON", () => {
    /* Two pages of an array arrive as `[…][…]` without it, which parses as
       nothing and would have turned a truncated list into an empty one. */
    const at = src.indexOf("async function ghJsonAll");
    const fn = src.slice(at, at + 700);
    expect(fn).toContain('"--paginate", "--slurp"');
    expect(fn).toContain(".flat()");
  });
});
