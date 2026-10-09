/*
 * A conflict the detail learned first reaches the board card at once.
 *
 * A base branch moved under an open pull request. The detail read said
 * "conflicts with the base", and the board card kept its old row for minutes:
 * `mergeable` flips without bumping `updatedAt`, the row patch never carried
 * it, and a list read already in flight came back over the overlay.
 * No network: rows and details are fed by hand.
 */
import { describe, expect, it } from "bun:test";
import type { PrDetail, PrSummary } from "../../shared/types.ts";
import { holdEdits, overlayDetail, rowPatch, type EditLog } from "../src/lib/prRefresh.ts";
import { board, stakeFrom } from "../src/lib/prLanes.ts";

const row = (over: Partial<PrSummary> = {}): PrSummary => ({
  number: 7, title: "ORBIT-1042 thing", author: "ana", state: "OPEN", isDraft: false,
  headRefName: "ORBIT-1042-thing", baseRefName: "main", url: "", updatedAt: "2026-01-01T00:00:00Z",
  reviewDecision: null, additions: 1, deletions: 1, changedFiles: 1, labels: [], assignees: [], milestone: null,
  reviewers: [], checksLoaded: true, mergeable: "MERGEABLE",
  checks: { total: 1, success: 1, failure: 0, pending: 0, state: "SUCCESS" },
  ...over,
} as unknown as PrSummary);
const detail = (over: Partial<PrDetail> = {}): PrDetail => ({ ...row(), ...over } as unknown as PrDetail);

const laneOf = (r: PrSummary) => {
  const lanes = board([r], stakeFrom([r], []));
  for (const [lane, rows] of lanes) if (rows.length) return lane;
  return null;
};

describe("mergeable travels from the detail into the row", () => {
  it("a detail that says CONFLICTING moves the card to the blocked lane", () => {
    const rows = overlayDetail([row()], detail({ mergeable: "CONFLICTING" }));
    expect(rows[0].mergeable).toBe("CONFLICTING");
    expect(laneOf(rows[0])).toBe("blocked");
  });

  it("an UNKNOWN detail never wipes a known answer", () => {
    expect(rowPatch(detail({ mergeable: "UNKNOWN" }))).not.toHaveProperty("mergeable");
    expect(overlayDetail([row({ mergeable: "CONFLICTING" })], detail({ mergeable: "UNKNOWN" }))[0].mergeable).toBe("CONFLICTING");
  });

  it("no change is the same array, so nothing re-renders", () => {
    const rows = [row()];
    expect(overlayDetail(rows, detail())).toBe(rows);
  });
});

describe("an older list read does not undo it", () => {
  it("a list read before the detail keeps the conflict, one read after wins", () => {
    const log: EditLog = new Map([[7, { at: 1_000, patch: rowPatch(detail({ mergeable: "CONFLICTING" })) }]]);
    const older = holdEdits([row()], log, 500, 1_500);
    expect(older[0].mergeable).toBe("CONFLICTING");
    const newer = holdEdits([row()], log, 1_200, 1_500);
    expect(newer[0].mergeable).toBe("MERGEABLE");
  });
});
