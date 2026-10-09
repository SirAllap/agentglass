/*
 * A BOT'S APPROVAL IS NOT AN APPROVAL.
 *
 * `reviewDecision` is GitHub's own answer and counts every reviewer with write
 * access. The auto-review bot has it, so a pull request nobody had read came
 * back `APPROVED` — and the board drew a green tick on a card whose only human
 * had commented. Reported the moment it shipped: "this one is approved by
 * claude... by a bot... that doesn't count".
 *
 * It was also the app disagreeing with itself. The pull request's own Overview
 * already excluded bots and said "Reviewed, no verdict" about that same pull
 * request on the same screen — two surfaces, one truth, two answers.
 *
 * Computed from the reviews the list query already fetches, so it costs no
 * request. `reviewDecision` stays untouched beside it: some callers do want
 * "can this merge", which is what GitHub's field means.
 */
import { describe, expect, test } from "bun:test";
import { humanVerdict } from "../src/prs.ts";

const r = (login: string, state: string, at = "2026-09-01T10:00:00Z", url = "") =>
  ({ author: { login }, state, submittedAt: at, url });

describe("the verdict of the people", () => {
  test("a bot approving is not a verdict", () => {
    expect(humanVerdict([r("claude", "APPROVED")])).toBeNull();
  });

  test("a bot approving beside a human commenting is `commented`", () => {
    // The exact shape that shipped wrong: GitHub says APPROVED, a person did
    // not approve anything.
    expect(humanVerdict([r("claude", "APPROVED"), r("bjorn", "COMMENTED")])?.kind).toBe("commented");
  });

  test("a human approving is", () => {
    expect(humanVerdict([r("claude", "APPROVED"), r("okoro", "APPROVED")])?.kind).toBe("approved");
  });

  test("changes requested outranks an approval by somebody else", () => {
    expect(humanVerdict([r("a", "APPROVED"), r("b", "CHANGES_REQUESTED")])?.kind).toBe("changes");
  });

  test("but a person's LAST verdict is the one that counts", () => {
    /* The shape of a long review: the reviewer asked for changes on the
       25th and approved on the 2nd. Reading every review equally would report
       it as blocked eight days after it was unblocked. */
    expect(humanVerdict([
      r("okoro", "CHANGES_REQUESTED", "2026-08-25T12:00:00Z"),
      r("okoro", "APPROVED", "2026-09-02T15:00:00Z"),
    ])?.kind).toBe("approved");
  });

  test("a comment afterwards does not undo a verdict", () => {
    // Reviewers comment on their own threads constantly; treating that as
    // withdrawing the approval would make every conversation look like a block.
    expect(humanVerdict([r("a", "APPROVED"), r("a", "COMMENTED")])?.kind).toBe("approved");
  });

  test("a dismissed review takes the verdict back", () => {
    expect(humanVerdict([r("a", "APPROVED"), r("a", "DISMISSED")])?.kind).toBe("commented");
  });

  test("nobody at all is null, not a quiet approval", () => {
    expect(humanVerdict([])).toBeNull();
    expect(humanVerdict(undefined)).toBeNull();
  });

  test("and a bot is recognised by the app's own list, not by a guess here", () => {
    /* If `isBotLogin` stops matching the review bot, every assertion above
       still passes while the product is wrong again — so the coupling is
       asserted rather than assumed. */
    expect(humanVerdict([r("github-actions", "APPROVED")])).toBeNull();
    expect(humanVerdict([r("dependabot", "APPROVED")])).toBeNull();
  });
});

/*
 * WHAT THE ROW NEEDS BESIDES THE WORD.
 *
 * The verdict alone answers "was it reviewed". A card also has to answer "by
 * whom", "when", "is it still about this code" and "was it me" — and every one
 * of those is in the same reviews the list already fetches.
 */
describe("what travels with the verdict", () => {
  test("names everybody who landed on it, newest first for the stamp", () => {
    const v = humanVerdict([
      r("a", "APPROVED", "2026-09-01T09:00:00Z", "u/a"),
      r("b", "APPROVED", "2026-09-02T09:00:00Z", "u/b"),
    ], { author: "maintainer" });
    expect(v?.who).toEqual(["a", "b"]);
    expect(v?.at).toBe("2026-09-02T09:00:00Z");
    expect(v?.url, "the newest one's message, which is the one to land on").toBe("u/b");
  });

  test("STALE when commits landed after the verdict", () => {
    /* The dangerous one: the row says approved, the reviewer approved something
       else. GitHub says so on the PR's own page; the board did not. */
    const v = humanVerdict([r("a", "APPROVED", "2026-09-01T09:00:00Z")],
      { author: "maintainer", headAt: "2026-09-02T10:00:00Z" });
    expect(v?.stale).toBe(true);
  });

  test("and not stale when the head is older than the review", () => {
    const v = humanVerdict([r("a", "APPROVED", "2026-09-03T09:00:00Z")],
      { author: "maintainer", headAt: "2026-09-02T10:00:00Z" });
    expect(v?.stale).toBe(false);
  });

  test("knows when the verdict is the reader's own", () => {
    // "You approved" rather than your own name in the third person.
    const v = humanVerdict([r("okoro", "APPROVED")], { author: "maintainer", viewer: "okoro" });
    expect(v?.mine).toBe(true);
  });

  test("counts the people on the other side", () => {
    /* One approval and one rejection is not "changes requested" alone — the
       approval is half the story and used to vanish. */
    const v = humanVerdict([r("a", "APPROVED"), r("b", "CHANGES_REQUESTED")], { author: "maintainer" });
    expect(v?.kind).toBe("changes");
    expect(v?.others).toBe(1);
  });

  test("waiting names who is being waited on, and whether it is you", () => {
    const v = humanVerdict([r("maintainer", "COMMENTED")],
      { author: "maintainer", pending: ["bjorn"], viewer: "bjorn" });
    expect(v?.kind).toBe("awaiting");
    expect(v?.who).toEqual(["bjorn"]);
    expect(v?.mine, "your own column should say `Waiting on you`").toBe(true);
  });

  /*
   * ASKED AGAIN, AFTER CHANGES REQUESTED — GitHub's ↻.
   *
   * Their review still stands and still blocks the merge, which is why
   * `changes` still wins the kind. But applying it and pressing "Re-request
   * review" puts the same login back in `reviewRequests` — `pending` here —
   * and that overlap is the other half of GitHub's own screen: a follow-up
   * round has already been asked for.
   */
  test("changes requested, and the same reviewer is back in the pending list", () => {
    const v = humanVerdict([r("okoro", "CHANGES_REQUESTED")],
      { author: "maintainer", pending: ["okoro"] });
    expect(v?.kind).toBe("changes");
    expect(v?.askedAgain).toBe(true);
    /* EVERY changes-requester is re-asked here (there is only one) — nobody
       is still the one holding up the merge, so `cleared` says the merge box
       should draw it amber, like a fresh request, not the still-standing
       red. */
    expect(v?.cleared).toBe(true);
  });

  test("not cleared while one of several changes-requesters has not been re-asked", () => {
    const v = humanVerdict([r("okoro", "CHANGES_REQUESTED"), r("orbit-dev", "CHANGES_REQUESTED")],
      { author: "maintainer", pending: ["okoro"] });
    expect(v?.kind).toBe("changes");
    // okoro was re-asked but orbit-dev was not — orbit-dev's thread is still
    // the one to answer, so the merge stays red, and both are still named.
    expect(v?.cleared).toBeFalsy();
    expect(v?.who).toEqual(["okoro", "orbit-dev"]);
  });

  test("not asked again when nobody has re-requested them", () => {
    const v = humanVerdict([r("okoro", "CHANGES_REQUESTED")], { author: "maintainer" });
    expect(v?.askedAgain).toBe(false);
  });

  test("not asked again when the pending name is someone else entirely", () => {
    // A second reviewer added to the round must not read as okoro
    // having been re-asked — that is a different fact.
    const v = humanVerdict([r("okoro", "CHANGES_REQUESTED")],
      { author: "maintainer", pending: ["bjorn"] });
    expect(v?.askedAgain).toBe(false);
  });

  /*
   * THE STALE-APPROVAL PATH READS THE SAME `pending` LIST.
   *
   * `askedAgain` is computed once, inside the same helper both an approval
   * and a changes-requested verdict go through — it does not need a second
   * definition. A stale approval that has been re-requested still says
   * `stale: true` (the approval genuinely does not cover the code any more)
   * but now also carries `askedAgain: true`, so a reader can tell the ball
   * moved back to the reviewer rather than sitting with the author.
   */
  test("a stale approval, re-requested, is askedAgain the same way changes-requested is", () => {
    const v = humanVerdict([r("okoro", "APPROVED", "2026-09-01T09:00:00Z")],
      { author: "maintainer", headAt: "2026-09-02T10:00:00Z", pending: ["okoro"] });
    expect(v?.kind).toBe("approved");
    expect(v?.stale).toBe(true);
    expect(v?.askedAgain).toBe(true);
  });

  test("a stale approval with nobody re-requested is not askedAgain", () => {
    const v = humanVerdict([r("okoro", "APPROVED", "2026-09-01T09:00:00Z")],
      { author: "maintainer", headAt: "2026-09-02T10:00:00Z" });
    expect(v?.stale).toBe(true);
    expect(v?.askedAgain).toBe(false);
  });
});

describe("open line threads, from the same node as the verdict", () => {
  test("counts the unresolved ones, says when the hundred ran out, and is absent when the field is", async () => {
    const { unresolvedThreads } = await import("../src/prs.ts");
    expect(unresolvedThreads({ reviewThreads: { totalCount: 3, nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }] } })).toEqual({ open: 2, more: false });
    expect(unresolvedThreads({ reviewThreads: { totalCount: 140, nodes: Array.from({ length: 100 }, (_, i) => ({ isResolved: i % 2 === 0 })) } })).toEqual({ open: 50, more: true });
    expect(unresolvedThreads({ reviewThreads: { totalCount: 0, nodes: [] } })).toEqual({ open: 0, more: false });
    expect(unresolvedThreads({})).toBeUndefined();
    expect(unresolvedThreads(null)).toBeUndefined();
  });
  test("the list query asks for it beside the reviews, bounded, with one boolean per thread", async () => {
    const src = await Bun.file(new URL("../src/prs.ts", import.meta.url)).text();
    const talk = src.slice(src.indexOf("const SEL_TALK = `"), src.indexOf("`;", src.indexOf("const SEL_TALK = `")));
    expect(talk).toContain("reviewThreads(first:100){totalCount nodes{isResolved}}");
    expect(src).toContain("openThreads: unresolvedThreads(n),");
  });
});

/*
 * `people`: everyone asked or heard from, one entry each. The winning group's
 * `who` leaves out the person who was asked and never answered, so a pull
 * request with one reviewer back on the hook and another never heard from
 * named only the first. Fixtures are invented logins.
 */
describe("people: every reviewer, one entry each", () => {
  const people = (nodes: unknown, o: Parameters<typeof humanVerdict>[1] = {}) => humanVerdict(nodes, { author: "maintainer", ...o })?.people;

  test("one asked, nobody answered", () => {
    expect(people([], { pending: ["mkovac"] })).toEqual([{ login: "mkovac", state: "await" }]);
  });

  test("the owner's case: changes requested then re-asked, plus one never answered", () => {
    const v = humanVerdict([r("tlindqvist", "CHANGES_REQUESTED")], { author: "maintainer", pending: ["tlindqvist", "rnakamura"] });
    expect(v?.kind).toBe("changes");
    expect(v?.cleared).toBe(true);
    // `who` still names only the winning group; `people` has the other one.
    expect(v?.who).toEqual(["tlindqvist"]);
    expect(v?.people).toEqual([{ login: "tlindqvist", state: "again" }, { login: "rnakamura", state: "await" }]);
  });

  test("a reviewer who approved and was asked again is `again`, not `approved`", () => {
    expect(people([r("okoro", "APPROVED")], { pending: ["okoro"] })).toEqual([{ login: "okoro", state: "again" }]);
  });

  test("changes, approved and not answered together", () => {
    const p = people([r("tlindqvist", "CHANGES_REQUESTED"), r("ofarah", "APPROVED")], { pending: ["rnakamura"] });
    expect(p).toEqual([
      { login: "rnakamura", state: "await" },
      { login: "tlindqvist", state: "changes" },
      { login: "ofarah", state: "approved" },
    ]);
  });

  test("five asked, each once, in the order GitHub lists them", () => {
    const five = ["a1", "b2", "c3", "d4", "e5"];
    expect(people([], { pending: five })?.map((x) => x.login)).toEqual(five);
    expect(people([], { pending: five })?.every((x) => x.state === "await")).toBe(true);
  });

  test("bots and the author are never a face, asked or not", () => {
    expect(people([r("claude", "APPROVED"), r("maintainer", "APPROVED")], { pending: ["copilot[bot]", "maintainer", "okoro"] }))
      .toEqual([{ login: "okoro", state: "await" }]);
  });

  test("a dismissed verdict is not a standing one: asked again it is `await`", () => {
    expect(people([r("okoro", "CHANGES_REQUESTED", "2026-09-01T10:00:00Z"), r("okoro", "DISMISSED", "2026-09-02T10:00:00Z")], { pending: ["okoro"] }))
      .toEqual([{ login: "okoro", state: "await" }]);
  });

  test("a team is flagged and is only ever waited on", () => {
    expect(people([], { pending: ["platform", "okoro"], teams: ["platform"] }))
      .toEqual([{ login: "platform", state: "await", team: true }, { login: "okoro", state: "await" }]);
  });

  test("logins are matched without case", () => {
    expect(people([r("Okoro", "APPROVED")], { pending: ["okoro"] })).toEqual([{ login: "okoro", state: "again" }]);
  });

  test("somebody who only commented is listed when nobody else is", () => {
    const v = humanVerdict([r("bjorn", "COMMENTED")], { author: "maintainer" });
    expect(v?.kind).toBe("commented");
    expect(v?.people).toEqual([{ login: "bjorn", state: "comment" }]);
    expect(people([r("bjorn", "COMMENTED")], { pending: ["okoro"] })).toEqual([{ login: "okoro", state: "await" }]);
  });

  test("additive: kind, who and the flags read the same as before", () => {
    const v = humanVerdict([r("a", "APPROVED"), r("b", "CHANGES_REQUESTED")], { author: "maintainer", pending: ["c"] });
    const { people: _p, ...rest } = v!;
    expect(rest.kind).toBe("changes");
    expect(rest.who).toEqual(["b"]);
    expect(rest.others).toBe(1);
  });

  test("nobody asked and nobody spoke is still null", () => {
    expect(humanVerdict([], { author: "maintainer" })).toBeNull();
  });
});
