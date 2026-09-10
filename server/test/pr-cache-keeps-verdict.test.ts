/*
 * THE CACHED ANSWER OUTLIVES THE ONE THAT FAILED TO ARRIVE.
 *
 * After a while every row settled into the wrong header, and leaving the view
 * and coming back reset them to it again.
 *
 * Every review header on the board read "No review asked for yet", and it
 * survived leaving the view and coming back — which is what said the blank was
 * being CACHED rather than merely rendered. GitHub answers HTTP 200 with
 * `{data, errors}` when part of a query fails, so a row arrives complete apart
 * from the field that timed out; `carryOver` waved a completed second pass
 * straight through, and `saveDiskCache` wrote the blank to disk, where it
 * outlived the restart too.
 */
import { describe, expect, test } from "bun:test";
import { carryOver } from "../src/prs.ts";
import type { PrSummary } from "../../shared/types.ts";

const row = (over: Record<string, unknown> = {}) =>
  ({ number: 7, title: "#7", checksLoaded: true, ...over }) as unknown as PrSummary;
const verdict = { kind: "approved" as const, who: ["reviewer-one"] };

describe("a partial answer never caches a blank", () => {
  test("a completed pass that lost the verdict keeps the cached one", () => {
    const out = carryOver(row({ humanReview: verdict }), row({}));
    expect(out.humanReview).toEqual(verdict);
  });

  test("a real verdict replaces it, and so does a real \"nobody\"", () => {
    const changed = { kind: "changes" as const, who: ["reviewer-two"] };
    expect(carryOver(row({ humanReview: verdict }), row({ humanReview: changed })).humanReview)
      .toEqual(changed);
    /* `null` is GitHub saying nobody reviewed it. An answer wins, always. */
    expect(carryOver(row({ humanReview: verdict }), row({ humanReview: null })).humanReview)
      .toBeNull();
  });

  test("the tracker line and the head commit are held the same way", () => {
    const card = { id: "ORBIT-1042", title: "Rework the sidebar", status: "in review",
      priority: null, url: "https://example.invalid/c" } as PrSummary["card"];
    const out = carryOver(row({ card, headSha: "abc123" }), row({}));
    expect(out.card).toEqual(card);
    expect(out.headSha).toBe("abc123");
  });

  test("with nothing cached there is nothing to hold, and the row passes through", () => {
    expect(carryOver(undefined, row({})).humanReview).toBeUndefined();
  });

  test("and the first-pass carry still works as it did", () => {
    /* The half-loaded row: the whole previous answer stands under it. */
    const old = row({ humanReview: verdict, additions: 40, reviewDecision: "APPROVED" });
    const out = carryOver(old, row({ checksLoaded: false, additions: 0 }));
    expect(out.additions).toBe(40);
    expect(out.reviewDecision).toBe("APPROVED");
    expect(out.humanReview).toEqual(verdict);
  });
});
