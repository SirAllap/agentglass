import { describe, expect, test } from "bun:test";
import { cardView } from "../src/lib/prCardView.ts";
import { cardReviewers } from "../src/lib/cardReviewers.ts";
import type { Filed } from "../src/lib/prLanes.ts";

const p = {
  number: 1042, title: "Retry the relay handshake", author: "mara-k", state: "OPEN" as const, isDraft: false,
  headRefName: "ORBIT-1042-retry-handshake", baseRefName: "main", mergeable: "MERGEABLE" as const,
  reviewDecision: "APPROVED" as const, humanReview: undefined,
  checks: { total: 8, success: 8, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green" as const, failing: [] },
};
const land: Filed = { lane: "land", reason: "x" };
const view = (refreshing?: "reading" | "expired" | null) =>
  cardView({ p, filed: land, reviewers: cardReviewers(undefined), behind: null, tracker: "card", hasTaskProvider: true, refreshing });

// After an Update the card still shows the old green for a moment; a Merge pressed then lands on checks that restarted.
describe("Merge waits while the new checks are read", () => {
  test("offered and live at rest", () => {
    expect(view().primary.id).toBe("merge");
    expect(view().primary.disabled).toBe(false);
  });
  test("held while reading, live again once the read is in or gave up", () => {
    expect(view("reading").primary.disabled).toBe(true);
    expect(view(null).primary.disabled).toBe(false);
    expect(view("expired").primary.disabled).toBe(false);
  });
});
