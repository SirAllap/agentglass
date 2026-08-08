/*
 * Typing a word in the pull-request filter must find it, and now.
 *
 * Reported against a real list: ninety-three pull requests across four pages,
 * typing "migration" and getting nothing — while a row plainly containing the
 * word sat two pages away. Two separate faults produced that, and this file is
 * about the first.
 *
 * The panel computed its rows with `sortRows`, which is sort-only by its own
 * doc comment, so the box labelled "Filter these" filtered nothing at all. The
 * only thing that ever narrowed the list was pressing Enter, which asks GitHub
 * and takes a round trip.
 *
 * `applyFilters` — the same predicate the facet menus already counted with —
 * was sitting in the same module, unused by the list.
 */
import { describe, expect, test } from "bun:test";
import { applyFilters, sortRows, parseQuery } from "../src/lib/prFilter.ts";
import type { PrSummary } from "../../shared/types.ts";

const pr = (number: number, title: string, author = "someone"): PrSummary => ({
  number, title, author, url: "", branch: "", base: "main",
  draft: false, updatedAt: new Date(number * 1000).toISOString(),
  labels: [], reviews: [], checks: "none", additions: 0, deletions: 0,
} as unknown as PrSummary);

const ROWS = [
  pr(1, "ORBIT-1188 — Guest checkout email sequence events migration"),
  pr(2, "Multiple Attempts Required For Status Change on Fulfilment Sync Worker"),
  pr(3, "Send email notification to Sellers when a refund retry loop is detected (DB migration only)"),
  pr(4, "Cart preview is sometimes unavailable on step 2 of the checkout"),
];

describe("the filter box filters", () => {
  test("free text narrows the list to the rows that contain it", () => {
    const out = applyFilters(ROWS, parseQuery("migration"));
    expect(out.map((p) => p.number).sort()).toEqual([1, 3]);
  });

  test("and it is case-insensitive, because nobody types the case", () => {
    expect(applyFilters(ROWS, parseQuery("MIGRATION")).length).toBe(2);
  });

  test("sortRows is NOT a filter, which is what shipped", () => {
    // The guard for the actual defect. If somebody swaps the panel back to
    // sorting, this says what that costs rather than leaving it to be noticed
    // on a list of ninety-three.
    expect(sortRows(ROWS, parseQuery("migration")).length).toBe(ROWS.length);
  });

  test("no text means no narrowing", () => {
    expect(applyFilters(ROWS, parseQuery("")).length).toBe(ROWS.length);
  });

  test("a word that matches nothing gives nothing, not everything", () => {
    expect(applyFilters(ROWS, parseQuery("zzzznotathing")).length).toBe(0);
  });
});
