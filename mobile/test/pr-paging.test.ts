import { describe, expect, test } from "bun:test";
import { mergeFresh, mergeFreshGroup, nextPageCount } from "../src/model/prPaging.ts";
import { keepLoadedChecks } from "../../shared/prMerge.ts";

const pr = (number: number, title = `pr ${number}`) => ({ number, title });
const group = (nums: number[], over: Record<string, unknown> = {}) =>
  ({ root: "/w/orbit", items: nums.map((n) => pr(n)), hasNext: true, cursor: "p1", ...over } as {
    root: string; items: { number: number; title: string }[]; hasNext: boolean; cursor: string | null; total?: number;
  });

const groupOf = <T extends { number: number }>(items: T[], over: Record<string, unknown> = {}) =>
  ({ root: "/w/orbit", items, hasNext: true, cursor: "p1", ...over });

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

/*
 * The list arrives in two passes: rows first, the check rollups and the diff
 * stats seconds behind. A refresh starts at the fast pass again, so without the
 * carry the card blanked to `checksLoaded: false` and `+0 −0` on every poll —
 * which the desktop does not do, because it keeps the last complete pass.
 */
describe("a refresh does not un-know the second pass", () => {
  const green = { total: 3, success: 3, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] as string[] };
  type Row = {
    number: number; title: string; checksLoaded: boolean; additions: number; deletions: number;
    reviewDecision?: string | null; humanReview?: { kind: string; who: string[] } | null;
    checks: typeof green;
  };
  const loaded = (n: number): Row => ({
    number: n, title: `pr ${n}`, checks: green, checksLoaded: true, additions: 12, deletions: 3,
    reviewDecision: "APPROVED", humanReview: { kind: "approved", who: ["cy"] },
  });
  const fast = (n: number): Row => ({
    number: n, title: `pr ${n}`, checksLoaded: false,
    checks: { total: 0, success: 0, failure: 0, skipped: 0, pending: 0, allDone: false, verdict: null, failing: [] } as unknown as typeof green,
    additions: 0, deletions: 0,
  });

  test("a first pass after a loaded answer keeps checks, size, review and merge state", () => {
    const got = mergeFreshGroup(groupOf([loaded(1)]), groupOf([fast(1)]));
    expect(got.items[0]).toMatchObject({
      checksLoaded: true, additions: 12, deletions: 3, reviewDecision: "APPROVED",
      humanReview: { kind: "approved" }, checks: { verdict: "green" },
    });
  });

  test("a real second pass replaces what was carried, empty answers included", () => {
    const answered = { ...loaded(1), additions: 0, deletions: 0, humanReview: null, reviewDecision: null };
    const got = mergeFreshGroup(groupOf([loaded(1)]), groupOf([answered]));
    expect(got.items[0]).toMatchObject({ checksLoaded: true, additions: 0, humanReview: null, reviewDecision: null });
  });
});

/*
 * The board is the screen the two-pass merge was written for, and it was the
 * one place that did not use it: a pull to refresh replaced all three lists
 * with the fast pass, so every card read checks "…", review "reading…" and
 * branch "checking" until the second pass came back. The list kept its carry;
 * the board did not.
 */
describe("the board keeps the second pass", () => {
  type Row = { number: number; checksLoaded?: boolean; additions: number; reviewDecision?: string | null; humanReview?: { kind: string } | null };
  const loaded = (n: number): Row => ({ number: n, checksLoaded: true, additions: 12, reviewDecision: "APPROVED", humanReview: { kind: "approved" } });
  const fast = (n: number): Row => ({ number: n, checksLoaded: false, additions: 0 });

  test("all three lists a board is filed from carry what the second pass filled", () => {
    const was = { mine: [loaded(1)], review: [loaded(2)], all: [loaded(3)] };
    const next = { mine: [fast(1)], review: [fast(2)], all: [fast(3)] };
    const merged = {
      mine: keepLoadedChecks(was.mine, next.mine),
      review: keepLoadedChecks(was.review, next.review),
      all: keepLoadedChecks(was.all, next.all),
    };
    for (const rows of Object.values(merged)) {
      expect(rows[0]).toMatchObject({ checksLoaded: true, additions: 12, reviewDecision: "APPROVED", humanReview: { kind: "approved" } });
    }
  });

  test("the screen merges into what it already had, and re-reads after a fast answer", async () => {
    const src = await Bun.file(new URL("../app/(tabs)/prs.tsx", import.meta.url)).text();
    expect(src).toContain("setBoardData((was) => ({");
    expect(src).toContain("keepLoadedChecks(was?.mine ?? [], rowsOf(askedMine))");
    expect(src).toContain("keepLoadedChecks(was?.review ?? [], rowsOf(askedReview))");
    // The list re-reads 2.5 s after a fast pass; the board had no re-read at
    // all, so a board read that landed first-pass stayed first-pass until the
    // next tick or another pull.
    const reread = src.slice(src.indexOf("if (!boardReading) return;"));
    expect(reread.slice(0, 160)).toContain("loadBoard(true)");
  });
});
