/*
 * THE LIST ROW AND THE DETAIL ARE ONE DATUM.
 *
 * A base branch moved under an open pull request: the detail read said it
 * conflicts, the board's row kept saying nothing until the queue changed some
 * other way (`mergeable` bumps neither `updatedAt` nor the rollup). And GitHub
 * answers UNKNOWN while it computes, which the list held for a whole poll.
 * Pure functions and an injected asker: no gh, no clock.
 */
import { describe, expect, test } from "bun:test";
import { projectDetailOnRow, projectRowOnDetail, recheckMergeable } from "../src/prs.ts";
import type { PrDetail, PrSummary } from "../../shared/types.ts";

const row = (over: Record<string, unknown> = {}) =>
  ({ number: 7, title: "ORBIT-1042 thing", state: "OPEN", isDraft: false, updatedAt: "2026-01-01T00:00:00Z",
    mergeable: "MERGEABLE", labels: [], assignees: [], reviewers: [], reviewDecision: null, ...over }) as unknown as PrSummary;
const detail = (over: Record<string, unknown> = {}) => ({ ...row(), ...over }) as unknown as PrDetail;

describe("a detail read is written into the list row", () => {
  test("a conflict the detail learned reaches the row", () => {
    expect(projectDetailOnRow(row(), detail({ mergeable: "CONFLICTING" })).mergeable).toBe("CONFLICTING");
  });
  test("so do the other shared fields when the detail is as new", () => {
    const out = projectDetailOnRow(row(), detail({ title: "renamed", reviewDecision: "APPROVED", labels: [{ name: "x", color: "fff" }] }));
    expect([out.title, out.reviewDecision, out.labels.length]).toEqual(["renamed", "APPROVED", 1]);
  });
  test("an older detail changes nothing", () => {
    const r = row({ updatedAt: "2026-01-02T00:00:00Z" });
    expect(projectDetailOnRow(r, detail({ mergeable: "CONFLICTING" }))).toBe(r);
  });
  test("UNKNOWN never replaces a known answer, and no change is the same object", () => {
    const r = row({ mergeable: "CONFLICTING" });
    expect(projectDetailOnRow(r, detail({ mergeable: "UNKNOWN" }))).toBe(r);
  });
});

describe("a newer list row is written into the detail", () => {
  test("a newer updatedAt brings the shared fields", () => {
    const out = projectRowOnDetail(detail(), row({ updatedAt: "2026-01-03T00:00:00Z", title: "renamed", mergeable: "CONFLICTING" }));
    expect([out.title, out.mergeable]).toEqual(["renamed", "CONFLICTING"]);
  });
  test("an older row leaves the detail alone, except to answer its UNKNOWN", () => {
    const d = detail();
    expect(projectRowOnDetail(d, row({ title: "old", updatedAt: "2025-01-01T00:00:00Z" }))).toBe(d);
    expect(projectRowOnDetail(detail({ mergeable: "UNKNOWN" }), row({ mergeable: "CONFLICTING" })).mergeable).toBe("CONFLICTING");
  });
});

describe("UNKNOWN is re-asked, bounded", () => {
  const run = async (answers: Array<Record<number, string>>, numbers = [7, 8]) => {
    const asked: number[][] = [];
    const applied: Array<[number, string]> = [];
    const waits: number[] = [];
    let i = 0;
    const n = await recheckMergeable(numbers,
      async (ns) => { asked.push(ns); return new Map(Object.entries(answers[i++] ?? {}).map(([k, v]) => [Number(k), v])); },
      (k, m) => applied.push([k, m]), async (ms) => { waits.push(ms); });
    return { asked, applied, waits, n };
  };
  test("only the still-UNKNOWN ones are re-asked, and it stops when they resolve", async () => {
    const r = await run([{ 7: "CONFLICTING", 8: "UNKNOWN" }, { 8: "MERGEABLE" }]);
    expect(r.asked).toEqual([[7, 8], [8]]);
    expect(r.applied).toEqual([[7, "CONFLICTING"], [8, "MERGEABLE"]]);
  });
  test("three asks at most when GitHub never answers", async () => {
    const r = await run([{}, {}, {}, {}]);
    expect(r.n).toBe(3);
    expect(r.waits).toEqual([25_000, 30_000, 40_000]);
  });
  test("no request at all when nothing is UNKNOWN", async () => {
    const r = await run([], []);
    expect([r.n, r.asked.length]).toEqual([0, 0]);
  });
});
