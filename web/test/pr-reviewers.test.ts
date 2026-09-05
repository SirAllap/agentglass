/*
 * "On GH they show up as reviewers… but in agentglass as participants, with no
 * state or anything."
 *
 * Two screens side by side: GitHub listing three reviewers with a verdict each
 * — one asking for changes, two approving — and this panel saying "No
 * reviewers" over a row of anonymous participant faces.
 *
 * The panel was printing GitHub's OUTSTANDING request list, which on a pull
 * request where everybody has answered is empty. GitHub's own sidebar is the
 * union: everybody who reviewed, with their latest verdict, plus everybody
 * still being waited on.
 */
import { describe, expect, test } from "bun:test";
import { reviewerRoster, blockingReviewers } from "../src/lib/prReviewers.ts";
import * as R from "../src/lib/prReviewers.ts";

const review = (author: string, state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING", at: string, isBot = false) =>
  ({ author, state, submittedAt: at, isBot });

describe("who is on the list", () => {
  test("everybody who reviewed, even with nothing outstanding", () => {
    // The reported shape exactly: no requests left, three verdicts.
    const rows = reviewerRoster({
      reviewers: [],
      reviews: [
        review("ada", "CHANGES_REQUESTED", "2026-08-19T10:00:00Z"),
        review("grace", "APPROVED", "2026-08-19T11:00:00Z"),
        review("claude[bot]", "APPROVED", "2026-08-19T12:00:00Z", true),
      ],
    });
    expect(rows.map((r) => `${r.login}:${r.state}`)).toEqual([
      "ada:changes", "claude[bot]:approved", "grace:approved",
    ]);
  });

  test("and everybody still being waited on", () => {
    const rows = reviewerRoster({ reviewers: [{ login: "linus" }], reviews: [] });
    expect(rows).toEqual([{ login: "linus", state: "awaiting", isTeam: undefined }]);
  });

  test("a team is on the list without a verdict", () => {
    const rows = reviewerRoster({ reviewers: [{ login: "platform", isTeam: true }], reviews: [] });
    expect(rows[0]).toMatchObject({ login: "platform", state: "awaiting", isTeam: true });
  });
});

describe("what their state is", () => {
  test("the latest verdict wins, not the latest event", () => {
    /* The case this exists for: somebody approves and then answers a thread.
       Their approval still stands, and a sidebar that says "commented" about a
       green tick is worse than one that says nothing. */
    const rows = reviewerRoster({
      reviews: [
        review("ada", "APPROVED", "2026-08-19T10:00:00Z"),
        review("ada", "COMMENTED", "2026-08-19T14:00:00Z"),
      ],
    });
    expect(rows[0]).toMatchObject({ state: "approved", at: "2026-08-19T10:00:00Z" });
  });

  test("but a later verdict does replace an earlier one", () => {
    const rows = reviewerRoster({
      reviews: [
        review("ada", "CHANGES_REQUESTED", "2026-08-19T10:00:00Z"),
        review("ada", "APPROVED", "2026-08-20T09:00:00Z"),
      ],
    });
    expect(rows[0]).toMatchObject({ state: "approved" });
  });

  test("somebody who only ever commented says so", () => {
    const rows = reviewerRoster({ reviews: [review("ada", "COMMENTED", "2026-08-19T10:00:00Z")] });
    expect(rows[0]).toMatchObject({ state: "commented" });
  });

  test("a draft review is nobody's verdict", () => {
    // PENDING is a review being written. GitHub does not show it either.
    expect(reviewerRoster({ reviews: [review("ada", "PENDING", "2026-08-19T10:00:00Z")] })).toEqual([]);
  });

  test("asked again after answering is marked", () => {
    // GitHub's ↻: they have a verdict AND an outstanding request.
    const rows = reviewerRoster({
      reviewers: [{ login: "ada" }],
      reviews: [review("ada", "APPROVED", "2026-08-19T10:00:00Z")],
    });
    expect(rows[0]).toMatchObject({ state: "approved", again: true });
    // …and they are not listed twice.
    expect(rows).toHaveLength(1);
  });
});

describe("the order", () => {
  test("what blocks first, then what you are waiting on, then what is done", () => {
    /* Not GitHub's request order, which on a pull request that has been round
       three times says nothing about what to do next. */
    const rows = reviewerRoster({
      reviewers: [{ login: "linus" }],
      reviews: [
        review("grace", "APPROVED", "2026-08-19T11:00:00Z"),
        review("ada", "CHANGES_REQUESTED", "2026-08-19T10:00:00Z"),
        review("ken", "COMMENTED", "2026-08-19T12:00:00Z"),
      ],
    });
    expect(rows.map((r) => r.login)).toEqual(["ada", "linus", "grace", "ken"]);
  });
});

describe("naming who blocks the merge", () => {
  test("the sentence can say whose thread to answer", () => {
    const rows = reviewerRoster({
      reviews: [review("ada", "CHANGES_REQUESTED", "2026-08-19T10:00:00Z"), review("grace", "APPROVED", "2026-08-19T11:00:00Z")],
    });
    expect(blockingReviewers(rows)).toEqual(["ada"]);
  });
});

/*
 * WHAT THE REVIEWERS DECIDED, as one sentence.
 *
 * Reported looking at a pull request that had been approved sixteen hours
 * earlier: "has this PR been approved for me... because in the overview it looks
 * like it hasn't". It had. The approval was in the conversation, and the Overview drew a
 * red "Merging is blocked" over a list of everything standing in the way — a
 * failing check and five open threads — with no line anywhere saying a reviewer
 * had said yes.
 *
 * That is the box doing only half its job. Blocked and approved are different
 * facts about the same pull request and both are true at once: the reviewer
 * decided, and CI has not caught up. Drawing only the second answers "can I
 * merge" and silently drops "has anybody looked", which is the question a
 * person asks first and the one only a human can answer.
 *
 * A BOT'S APPROVAL IS NOT A REVIEW, and this is where that has to be enforced
 * rather than assumed. `claude` sits in the reviewer list with the same tick as
 * a person, and the rule for this repository is explicit: an auto-review is a
 * gate before the human one, never a substitute. A summary that counted it
 * would report a pull request as approved when nobody has read it.
 */
describe("the verdict, as a sentence", () => {
  const row = (login: string, state: R.ReviewerState, isBot = false): R.ReviewerRow =>
    ({ login, state, isBot, at: "2026-09-02T10:00:00Z" });

  test("names who approved", () => {
    const v = R.reviewVerdict([row("okoro", "approved")]);
    expect(v.kind).toBe("approved");
    expect(v.who).toEqual(["okoro"]);
  });

  test("changes requested outranks an approval, because it blocks", () => {
    // Two humans disagreeing is not "approved with a caveat": somebody is
    // waiting on an answer, and that is the state of the pull request.
    const v = R.reviewVerdict([row("okoro", "approved"), row("otra", "changes")]);
    expect(v.kind).toBe("changes");
    expect(v.who).toEqual(["otra"]);
  });

  test("changes requested, and asked again, says both — still blocked, but not still yours to start", () => {
    // Their review still stands and still blocks, exactly as GitHub shows it.
    // `askedAgain` is the OTHER half of that same screen: a follow-up round
    // has already been asked for.
    const v = R.reviewVerdict([{ login: "okoro", state: "changes", again: true, at: "2026-09-02T10:00:00Z" }]);
    expect(v.kind).toBe("changes");
    expect(v.askedAgain).toBe(true);
    expect(R.verdictLine(v)).toBe("Changes requested by okoro — asked to look again");
  });

  test("not asked again when nothing overlaps", () => {
    const v = R.reviewVerdict([row("okoro", "changes")]);
    expect(v.askedAgain).toBeFalsy();
    expect(R.verdictLine(v)).toBe("Changes requested by okoro");
  });

  test("a bot's approval is not an approval", () => {
    /* The house rule, enforced here rather than trusted: an auto-review is a
       gate BEFORE the human one. Counting it would report a pull request as
       reviewed when nobody has read it. */
    const v = R.reviewVerdict([row("claude", "approved", true)]);
    expect(v.kind).not.toBe("approved");
    expect(v.who).toEqual([]);
  });

  test("but a bot's approval alongside a human's does not hide the human", () => {
    const v = R.reviewVerdict([row("claude", "approved", true), row("okoro", "approved")]);
    expect(v.kind).toBe("approved");
    expect(v.who).toEqual(["okoro"]);
  });

  test("somebody who only commented has not decided", () => {
    // A comment is not a verdict, and drawing it as one would be the same
    // mistake in the other direction.
    expect(R.reviewVerdict([row("okoro", "commented")]).kind).toBe("commented");
  });

  test("nobody asked and nobody looked is `none`, not a quiet approval", () => {
    expect(R.reviewVerdict([]).kind).toBe("none");
  });

  test("asked and still waiting says so", () => {
    expect(R.reviewVerdict([row("okoro", "awaiting")]).kind).toBe("awaiting");
  });

  test("a dismissed review does not count as a decision", () => {
    expect(R.reviewVerdict([row("okoro", "dismissed")]).kind).toBe("none");
  });

  test("counts every approver, and names the first two", () => {
    const v = R.reviewVerdict([row("a", "approved"), row("b", "approved"), row("c", "approved")]);
    expect(v.who).toHaveLength(3);
    expect(R.verdictLine(v)).toBe("Approved by a and b +1");
  });

  test("the line says the decision in the words a person would use", () => {
    expect(R.verdictLine(R.reviewVerdict([row("okoro", "approved")]))).toBe("Approved by okoro");
    expect(R.verdictLine(R.reviewVerdict([row("okoro", "changes")]))).toBe("Changes requested by okoro");
    expect(R.verdictLine(R.reviewVerdict([row("okoro", "commented")]))).toBe("okoro commented without a verdict");
    expect(R.verdictLine(R.reviewVerdict([row("okoro", "awaiting")]))).toBe("Waiting on okoro");
    expect(R.verdictLine(R.reviewVerdict([]))).toBe("No review yet");
  });
});

/*
 * THE TWO SCREENS MUST NOT DISAGREE.
 *
 * The board's card said "Waiting on bjorn"; the pull request's own
 * Overview said "Reviewed, no verdict by the author" — about the same pull
 * request, at the same moment. Both were defensible: the card reads
 * `humanReview`, computed on the server, and the Overview built its own answer
 * from the reviewer roster in the browser.
 *
 * Two sources, two answers, and the app becomes the thing you cannot trust.
 * "it makes no sense" is exactly right.
 *
 * `humanReview` is the one that stays, because it knows what the browser
 * cannot: which login is the AUTHOR (their own comments are not a review) and
 * who is still outstanding (GitHub drops a request the moment it is answered).
 * The roster survives only as the fallback for a detail fetched before the
 * field existed.
 */
import { readFileSync as readSrc } from "node:fs";
describe("the Overview and the board agree", () => {
  const panel = readSrc(new URL("../src/components/PrPanel.tsx", import.meta.url), "utf8");

  test("the Overview's band reads `humanReview`, the same field the card does", () => {
    expect(panel).toContain("p2Verdict(d.humanReview");
  });

  test("and no longer builds its own verdict from the roster alone", () => {
    /* The exact line that made the two disagree. The roster is still used —
       as the fallback inside `p2Verdict` — but never as the primary answer. */
    expect(panel).not.toContain("const v = reviewVerdict(reviewerRoster(d));");
  });

  test("all four states get the band, not just approved", () => {
    /* "Changes requested" was a grey line with a cross while an approval was a
       coloured band. Same kind of fact — a person decided — drawn as neither. */
    const fn = panel.slice(panel.indexOf("function p2Verdict("), panel.indexOf("function ReviewChip("));
    for (const kind of ["approved", "changes", "awaiting"]) {
      expect(fn, `${kind} has no band`).toContain(`v.kind === "${kind}"`);
    }
    expect(fn, "and the fourth is the fallthrough").toContain("Reviewed, no verdict");
  });
});
