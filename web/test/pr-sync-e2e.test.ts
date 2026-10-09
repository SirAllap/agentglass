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
  const held = async (at = 1000) => {
    const { reopenedRow } = await import("../src/lib/prRefresh.ts");
    return new Map([["/r#7", { n: 7, root: "/r", at, t: Date.now(), row: reopenedRow(mine)! }]]);
  };
  it("has a row only for the author's own", async () => {
    const { reopenedRow } = await import("../src/lib/prRefresh.ts");
    expect(reopenedRow(mine)!.number).toBe(7);
    expect(reopenedRow(mine)!.state).toBe("OPEN");
    expect(reopenedRow({ ...mine, viewerDidAuthor: false } as unknown as PrDetail)).toBeNull();
  });
  it("puts the row back into a list that lacks it, so the card is there at once", async () => {
    const { holdReopened } = await import("../src/lib/prRefresh.ts");
    expect((await import("../src/lib/prRefresh.ts")).holdReopened([], await held(), 0, "/r").map((r) => r.number)).toEqual([7]);
    expect(holdReopened([], await held(), undefined, "/r").map((r) => r.number)).toEqual([7]);
  });
  it("compares SERVER stamps: a read that started before the write's stamp does not outrank it", async () => {
    const { holdReopened } = await import("../src/lib/prRefresh.ts");
    expect(holdReopened([], await held(1000), 999, "/r").map((r) => r.number)).toEqual([7]);
    expect(holdReopened([], await held(1000), 1000, "/r")).toEqual([]);
    expect(holdReopened([], await held(1000), 5000, "/r")).toEqual([]);
  });
  it("is not moved by the browser's own clock", async () => {
    const { holdReopened } = await import("../src/lib/prRefresh.ts");
    // a stamp far in the browser's past or future decides only by the server pair; the browser clock only ages a row out
    expect(holdReopened([], await held(4_000_000_000_000), 3_999_999_999_999, "/r").length).toBe(1);
    expect(holdReopened([], await held(1), 2, "/r").length).toBe(0);
    expect(holdReopened([], await held(1000), 999, "/r", Date.now() + 86_400_000).length).toBe(0); // aged out, nothing else
  });
  it("does not outrank a list that has the row, and is per repository", async () => {
    const { holdReopened } = await import("../src/lib/prRefresh.ts");
    const has = [row];
    expect(holdReopened(has, await held(), 0, "/r")).toBe(has);
    expect(holdReopened([], await held(), 0, "/other")).toEqual([]);
  });
  it("is what the reopen press and the list reads go through, and a close forgets it", () => {
    const at = panel.indexOf("if (ok2 && reopen)");
    expect(panel.slice(at, at + 700)).toMatch(/reopenedRef\.current\.set/);
    expect(panel).toMatch(/setBoardMine\(\(cur\) => withReopened\(openLists\(holdEdits[^\n]*r\.startedAt/);
    expect(panel).toMatch(/reopenedRef\.current\.delete\(/);
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
