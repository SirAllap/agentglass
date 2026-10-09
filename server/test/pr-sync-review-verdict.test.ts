/*
 * The review verdict is part of the one datum a card and a detail share.
 *
 * Driven end to end against a stub GitHub: a review landed on a pull request
 * and the board card said "Approved by ada" while the detail's Overview kept
 * saying nothing (and the other way round), because the projection between a
 * list row and a detail carried `reviewDecision` but not `humanReview`, the
 * field both screens actually draw the header from.
 */
import { describe, expect, test } from "bun:test";
import { projectDetailOnRow, projectRowOnDetail } from "../src/prs.ts";
import type { PrDetail, PrSummary } from "../../shared/types.ts";

const approved = { kind: "approved", who: "ada", mine: false } as unknown as PrSummary["humanReview"];
const row = (over: Record<string, unknown> = {}) =>
  ({ number: 7, title: "ORBIT-1042 thing", state: "OPEN", isDraft: false, updatedAt: "2026-01-01T00:00:00Z",
    mergeable: "MERGEABLE", labels: [], assignees: [], reviewers: [], reviewDecision: null, ...over }) as unknown as PrSummary;
const detail = (over: Record<string, unknown> = {}) => ({ ...row(), ...over }) as unknown as PrDetail;

describe("humanReview crosses between the list row and the detail", () => {
  test("a detail that learned the verdict first hands it to the row", () => {
    const out = projectDetailOnRow(row(), detail({ reviewDecision: "APPROVED", humanReview: approved }));
    expect(out.humanReview).toEqual(approved);
  });
  test("a newer row that learned the verdict first hands it to the detail", () => {
    const out = projectRowOnDetail(detail(), row({ updatedAt: "2026-01-03T00:00:00Z", reviewDecision: "APPROVED", humanReview: approved }));
    expect(out.humanReview).toEqual(approved);
  });
});

describe("a newer list row makes the cached detail stale", () => {
  test("its shared fields are brought over and the next open re-reads (threads and comments are not on a row)", async () => {
    const { detailAfterRow } = await import("../src/prs.ts");
    const hit = { at: 5_000, detail: detail() };
    const out = detailAfterRow(hit, row({ updatedAt: "2026-01-03T00:00:00Z", title: "renamed" }));
    expect(out.detail.title).toBe("renamed");
    expect(out.at).toBe(0);
  });
  test("a row that is not newer changes nothing", async () => {
    const { detailAfterRow } = await import("../src/prs.ts");
    const hit = { at: 5_000, detail: detail() };
    expect(detailAfterRow(hit, row())).toBe(hit);
  });
});
