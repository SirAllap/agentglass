import { describe, expect, test } from "bun:test";
import { mergeFresh, mergeFreshGroup, nextPageCount } from "../src/model/prPaging.ts";

const pr = (number: number, title = `pr ${number}`) => ({ number, title });
const group = (nums: number[], over: Record<string, unknown> = {}) =>
  ({ root: "/w/orbit", items: nums.map((n) => pr(n)), hasNext: true, cursor: "p1", ...over } as {
    root: string; items: { number: number; title: string }[]; hasNext: boolean; cursor: string | null; total?: number;
  });

describe("a refresh with pages already loaded", () => {
  test("keeps the rows of later pages, fresh data wins, order kept", () => {
    const was = group([5, 4, 3, 2, 1], { cursor: "p2" });
    const fresh = group([5, 4], { cursor: "p1" });
    fresh.items[0] = pr(5, "retitled");
    const got = mergeFreshGroup(was, fresh);
    expect(got.items.map((p) => p.number)).toEqual([5, 4, 3, 2, 1]);
    expect(got.items[0]!.title).toBe("retitled");
    // The next page is still the one after what is on screen.
    expect(got.cursor).toBe("p2");
  });

  test("a new pull request lands on top; one that left page one is dropped", () => {
    const was = group([5, 4, 3, 2, 1], { cursor: "p2" });
    const got = mergeFreshGroup(was, group([6, 5], { cursor: "p1" }));
    expect(got.items.map((p) => p.number)).toEqual([6, 5, 3, 2, 1]);
  });

  test("with only page one loaded it is exactly the fresh page", () => {
    const was = group([5, 4, 3]);
    const fresh = group([6, 5, 4]);
    expect(mergeFreshGroup(was, fresh)).toBe(fresh);
  });

  test("a first page that did not know about a second learns it from the refresh", () => {
    // The server answers a cold list at once, before GitHub has said how many
    // there are: hasNext false, no cursor. The read that follows knows. Keeping
    // the first answer's paging hid "Load more" for good on a 22-row list.
    const was = group([5, 4, 3], { hasNext: false, cursor: null });
    const fresh = group([5, 4, 3], { hasNext: true, cursor: "p1", total: 22 });
    const got = mergeFreshGroup(was, fresh);
    expect(got.hasNext).toBe(true);
    expect(got.cursor).toBe("p1");
    expect(got.total).toBe(22);
  });

  test("a cold refresh does not erase the paging that was known", () => {
    const was = group([5, 4, 3], { hasNext: true, cursor: "p1", total: 22 });
    const fresh = group([5, 4, 3], { hasNext: false, cursor: null, total: undefined });
    const got = mergeFreshGroup(was, fresh);
    expect(got.hasNext).toBe(true);
    expect(got.cursor).toBe("p1");
    expect(got.total).toBe(22);
  });

  test("a last page already loaded stays the last page across a refresh", () => {
    const was = group([5, 4, 3, 2, 1], { hasNext: false, cursor: null });
    const got = mergeFreshGroup(was, group([5, 4], { cursor: "p1" }));
    expect(got.items.map((p) => p.number)).toEqual([5, 4, 3, 2, 1]);
    expect(got.hasNext).toBe(false);
    expect(got.cursor).toBeNull();
  });

  test("a repository not loaded before is the fresh one", () => {
    const a = group([1]), b = { ...group([2]), root: "/w/other" };
    expect(mergeFresh([a], [a, b])[1]).toBe(b);
    expect(mergeFresh(null, [a])[0]).toBe(a);
  });
});

describe("the PR tab", () => {
  test("a refresh merges into the loaded pages, and a failed page is said, not swallowed", async () => {
    const src = await Bun.file(new URL("../app/(tabs)/prs.tsx", import.meta.url)).text();
    expect(src).toContain("setGroups((was) => mergeFresh<PrSummary, PrGroup>(was,");
    const more = src.slice(src.indexOf("const loadMore = useCallback("), src.indexOf("const loadFresh"));
    expect(more).toContain("failure ??=");
    expect(more).not.toMatch(/\.ok\) return g;/);
  });
});

describe("the label of the next page", () => {
  test("says what is left when the server gave a total, a page otherwise", () => {
    expect(nextPageCount([group([1, 2], { total: 22 })], 20)).toBe(20);
    expect(nextPageCount([group(Array.from({ length: 20 }, (_, i) => i), { total: 22 })], 20)).toBe(2);
    expect(nextPageCount([group([1, 2, 3])], 20)).toBe(20);
  });

  test("counts only the repositories that have a next page", () => {
    const a = group(Array.from({ length: 20 }, (_, i) => i), { total: 23 });
    const b = { ...group([1], { hasNext: false, cursor: null, total: 1 }), root: "/w/other" };
    expect(nextPageCount([a, b], 20)).toBe(3);
  });
});
