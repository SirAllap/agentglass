/*
 * Two ways a board card and its detail disagreed, found by driving both in a
 * browser against a stub GitHub (ORBIT repo, invented data).
 *
 *  - The detail knew a review verdict the card did not: `rowPatch` carried
 *    `reviewDecision` but the card's header is drawn from `humanReview`, so the
 *    card said "No review asked for yet" beside a detail that said Approved.
 *  - GitHub answers UNKNOWN for `mergeable` while it computes. The panel asks
 *    once more after 1.5 s, but as an ordinary read, which the server answers
 *    from its 45 s detail cache: the same UNKNOWN, so the recheck was spent on
 *    nothing and the conflict appeared a minute late.
 */
import { describe, expect, it } from "bun:test";
import type { PrDetail, PrSummary } from "../../shared/types.ts";
import { overlayDetail, rowPatch } from "../src/lib/prRefresh.ts";

const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

const verdict = { kind: "approved", who: "ada", mine: false } as unknown as PrSummary["humanReview"];
const row = { number: 7, title: "thing", state: "OPEN", isDraft: false, updatedAt: "2026-01-01T00:00:00Z", labels: [], assignees: [], reviewers: [], reviewDecision: null, humanReview: undefined, checksLoaded: true } as unknown as PrSummary;
const detail = { ...row, reviewDecision: "APPROVED", humanReview: verdict, mergeable: "MERGEABLE" } as unknown as PrDetail;

describe("the review verdict crosses from the detail to the card", () => {
  it("is in the patch a detail writes into the lists", () => {
    expect((rowPatch(detail) as { humanReview?: unknown }).humanReview).toEqual(verdict);
  });
  it("changes the row the board draws", () => {
    expect(overlayDetail([row], detail)[0]!.humanReview).toEqual(verdict);
  });
  it("does not blank a known verdict when the detail carries none", () => {
    const known = { ...row, humanReview: verdict } as PrSummary;
    expect(overlayDetail([known], { ...detail, humanReview: undefined } as unknown as PrDetail)[0]!.humanReview).toEqual(verdict);
  });
});

describe("the UNKNOWN recheck is a forced read", () => {
  it("asks again with force, past the server's cache", () => {
    const at = panel.indexOf("askedAgain.current = n;");
    expect(at).toBeGreaterThan(0);
    const body = panel.slice(at, panel.indexOf("}, [root, detail?.number, detail?.mergeable]);", at));
    expect(body).toMatch(/loadDetailRef\.current\?\.\(n, true\)/);
  });
});

describe("a reopened pull request is held in the board it left", () => {
  const mine = { ...detail, state: "OPEN", viewerDidAuthor: true } as unknown as PrDetail;
  it("has a row only for the author's own", async () => {
    const { reopenedRow } = await import("../src/lib/prRefresh.ts");
    expect(reopenedRow(mine)!.number).toBe(7);
    expect(reopenedRow(mine)!.state).toBe("OPEN");
    expect(reopenedRow({ ...mine, viewerDidAuthor: false } as unknown as PrDetail)).toBeNull();
  });
  it("puts the row back into a list that lacks it, so the card is there at once", async () => {
    const { reopenedRow, holdReopened } = await import("../src/lib/prRefresh.ts");
    const held = new Map([[7, { at: 1000, row: reopenedRow(mine)! }]]);
    expect(holdReopened([], held, 0, 2000).map((r) => r.number)).toEqual([7]);
  });
  it("does not outrank a read that began after the reopen, or one that has the row, or age", async () => {
    const { reopenedRow, holdReopened } = await import("../src/lib/prRefresh.ts");
    const held = () => new Map([[7, { at: 1000, row: reopenedRow(mine)! }]]);
    expect(holdReopened([], held(), 1500, 2000)).toEqual([]);
    const has = [row];
    expect(holdReopened(has, held(), 0, 2000)).toBe(has);
    expect(holdReopened([], held(), 0, 1000 + 31_000)).toEqual([]);
  });
  it("is what the reopen press and the list reads go through", () => {
    const at = panel.indexOf("if (ok2 && reopen)");
    expect(panel.slice(at, at + 500)).toMatch(/reopenedRef\.current\.set/);
    expect(panel).toMatch(/setBoardMine\(\(cur\) => withReopened\(openLists\(holdEdits/);
  });
});

describe("resolving a thread reaches the card's open-thread count", () => {
  const thread = (id: string, isResolved: boolean) => ({ id, isResolved, comments: [] });
  const d = (ts: unknown[]) => ({ ...detail, threads: ts }) as unknown as PrDetail;
  it("counts the detail's unresolved threads into the row patch", () => {
    expect(rowPatch(d([thread("a", false), thread("b", true), thread("c", false)])).openThreads).toEqual({ open: 2, more: false });
  });
  it("moves the card when the last one is resolved", () => {
    const withOne = { ...row, openThreads: { open: 1, more: false } } as unknown as PrSummary;
    expect(overlayDetail([withOne], d([thread("a", true)]))[0]!.openThreads).toEqual({ open: 0, more: false });
  });
});
