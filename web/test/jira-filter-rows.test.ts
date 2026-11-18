import { describe, expect, test } from "bun:test";
import { facetRows } from "../src/components/jira/list/headerModel.ts";

const people = ["Ada Orbit", "Ben Acme", "Cy Orbit", "Di Acme", "Ed Orbit", "Flo Acme", "Gus Orbit", "Hal Acme"].map((label, i) => ({ label, on: i === 7 }));

describe("which rows a Filters section draws", () => {
  test("collapsed: the first six, plus a pick further down, and says how many are left out", () => {
    const r = facetRows(people, "", false);
    expect(r.rows.map((x) => x.label)).toEqual(["Ada Orbit", "Ben Acme", "Cy Orbit", "Di Acme", "Ed Orbit", "Flo Acme", "Hal Acme"]);
    expect(r.more).toBe(1);
  });
  test("opened: everyone, nothing left out", () => {
    expect(facetRows(people, "", true)).toEqual({ rows: people, more: 0 });
  });
  test("a search matches anywhere in the label, ignores case, and drops non-matches even when picked", () => {
    const r = facetRows(people, "  ACME ", false);
    expect(r.rows.map((x) => x.label)).toEqual(["Ben Acme", "Di Acme", "Flo Acme", "Hal Acme"]);
    expect(facetRows(people, "orbit", false).rows.some((x) => x.on)).toBe(false);
    expect(facetRows(people, "zzz", false)).toEqual({ rows: [], more: 0 });
  });
  test("a short section is never collapsed", () => {
    expect(facetRows(people.slice(0, 6), "", false).more).toBe(0);
  });
});
