/*
 * The merge sheet's list of what is in the way, one GitHub fact per row.
 *
 * The sheet used to carry one sentence, which names whichever problem comes
 * first: a pull request that was red, behind and waiting on a reviewer read as
 * red only, and the other two were found after the checks were fixed.
 */
import { describe, expect, test } from "bun:test";
import type { PrCheckRollup } from "../../shared/types.ts";
import { changesRequestedWarning, mergeObstacles, type MergeFacts } from "../src/model/mergeObstacles.ts";

const rollup = (over: Partial<PrCheckRollup>): PrCheckRollup => ({
  total: 16, success: 16, failure: 0, skipped: 0, pending: 0,
  allDone: true, verdict: "green", failing: [], ...over,
});
const failed = (name: string) => ({ name, workflow: "CI", state: "failure" as const, done: true });

const facts = (over: Partial<MergeFacts>): MergeFacts => ({
  mergeState: "CLEAN", checks: rollup({}), reviewDecision: "APPROVED",
  isDraft: false, baseRefName: "main", mergeable: "MERGEABLE", ...over,
});

describe("mergeObstacles", () => {
  test("a clean, approved, green pull request has nothing in the way", () => {
    expect(mergeObstacles(facts({}))).toEqual([]);
  });

  test("red, behind and unreviewed at once are three rows, not the first one", () => {
    const rows = mergeObstacles(facts({
      mergeState: "BEHIND",
      reviewDecision: "REVIEW_REQUIRED",
      checks: rollup({ success: 14, failure: 2, verdict: "red", failing: [failed("test (ubuntu-latest)"), failed("lint")] }),
    }));
    expect(rows.map((r) => r.title)).toEqual([
      "Behind main",
      "test (ubuntu-latest) failed",
      "lint failed",
      "Needs an approval",
    ]);
    expect(rows.filter((r) => r.opens === "checks").length).toBe(2);
  });

  test("past three failures it counts, and trusts the count over a capped list", () => {
    const rows = mergeObstacles(facts({
      checks: rollup({
        failure: 7, verdict: "red",
        failing: [failed("a"), failed("b"), failed("c"), failed("d")],
      }),
    }));
    expect(rows.map((r) => r.title)).toEqual(["a failed", "b failed", "c failed", "4 more checks failed"]);
  });

  test("a conflict is named once whether the state or the flag says it", () => {
    expect(mergeObstacles(facts({ mergeState: "DIRTY", mergeable: "CONFLICTING" })).map((r) => r.title))
      .toEqual(["Conflicts with main"]);
    expect(mergeObstacles(facts({ mergeState: "UNKNOWN", mergeable: "CONFLICTING" })).map((r) => r.title))
      .toEqual(["Conflicts with main"]);
  });

  test("running is not failing, and says so", () => {
    const rows = mergeObstacles(facts({ mergeState: "UNSTABLE", checks: rollup({ success: 14, pending: 2, verdict: null, allDone: false }) }));
    expect(rows).toEqual([{
      title: "2 checks still running", sub: "Nothing has failed in them yet", opens: "checks", tone: "warn",
    }]);
  });

  test("a draft and requested changes each get their own row", () => {
    const rows = mergeObstacles(facts({ isDraft: true, mergeState: "DRAFT", reviewDecision: "CHANGES_REQUESTED" }));
    expect(rows.map((r) => r.title)).toEqual(["It is a draft", "Changes were requested"]);
  });
});

/*
 * The merge sheet's own second question: `mergeVerdict` (mergeReason.ts) says
 * "Ready to merge" once GitHub itself will take it, which is true of a
 * CHANGES_REQUESTED pull request whenever branch protection does not require
 * a review — the sheet went on to draw the header green and the button green
 * under it, naming neither the review nor the threads still open on it.
 */
describe("changesRequestedWarning", () => {
  test("null when nobody asked for changes", () => {
    expect(changesRequestedWarning({ reviewDecision: "APPROVED" })).toBeNull();
    expect(changesRequestedWarning({ reviewDecision: "REVIEW_REQUIRED" })).toBeNull();
    expect(changesRequestedWarning({ reviewDecision: null })).toBeNull();
  });

  test("names the reviewer and the open threads when both are known", () => {
    const warning = changesRequestedWarning({
      reviewDecision: "CHANGES_REQUESTED",
      humanReview: { who: ["orbit-reviewer"] },
      openThreads: { open: 3, more: false },
    });
    expect(warning?.note).toBe(
      "Changes were requested (by orbit-reviewer) · 3 open threads — merging lands it over that review.",
    );
    expect(warning?.buttonTone).toBe("plain");
  });

  test("says one thread, not '1 threads', and drops the reviewer when unknown", () => {
    const warning = changesRequestedWarning({
      reviewDecision: "CHANGES_REQUESTED",
      openThreads: { open: 1, more: false },
    });
    expect(warning?.note).toBe("Changes were requested · 1 open thread — merging lands it over that review.");
  });

  test("no thread count at all when none is open, or none was asked for", () => {
    const warning = changesRequestedWarning({
      reviewDecision: "CHANGES_REQUESTED",
      humanReview: { who: ["orbit-reviewer"] },
      openThreads: { open: 0, more: false },
    });
    expect(warning?.note).toBe("Changes were requested (by orbit-reviewer) — merging lands it over that review.");
  });
});
