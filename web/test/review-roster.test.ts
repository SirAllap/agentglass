// The review side of a pull request, one row of a table per state a reviewer
// can be in. Fixtures are invented people (alice, bob, carol, dave, erin) on an
// invented repository; bob wrote the pull request.
import { describe, expect, test } from "bun:test";
import { approvalsNeed, buildRoster, rosterCounts, type RosterInput, type ReviewerState } from "../../shared/reviewRoster.ts";
import type { PrReview } from "../../shared/types.ts";

const T = (min: number) => new Date(Date.parse("2026-09-30T12:00:00Z") - min * 60_000).toISOString();
const HEAD = "c2";
const rv = (author: string, state: PrReview["state"], min = 60, commit = HEAD, isBot = false): PrReview =>
  ({ author, isBot, state, body: "", submittedAt: T(min), commit });
const gate = (approvals: number, over: Record<string, unknown> = {}) => ({ approvals, dismissStale: false as boolean | null, protectionVisible: true, codeOwners: false, ...over });
const input = (over: Partial<RosterInput> = {}): RosterInput => ({ author: "bob", headSha: HEAD, gate: gate(2), reviewDecision: "REVIEW_REQUIRED", ...over });

interface Case { name: string; in: RosterInput; state: ReviewerState; counts: boolean; who?: string; threads?: number; askedAgain?: boolean }

const cases: Case[] = [
  { name: "approved on the current commit", in: input({ reviews: [rv("alice", "APPROVED")] }), state: "approved", counts: true },
  { name: "approved before a push, and the repository keeps approvals: counts, and says so", in: input({ reviews: [rv("alice", "APPROVED", 60, "c1")] }), state: "approved-old", counts: true },
  { name: "approved before a push, and the repository dismisses stale approvals: does not count", in: input({ gate: gate(2, { dismissStale: true }), reviews: [rv("alice", "APPROVED", 60, "c1")] }), state: "approved-void", counts: false },
  { name: "an approval with no commit recorded is not called stale", in: input({ reviews: [{ ...rv("alice", "APPROVED"), commit: "" }] }), state: "approved", counts: true },
  { name: "no head commit known: nothing is called stale", in: input({ headSha: undefined, reviews: [rv("alice", "APPROVED", 60, "c1")] }), state: "approved", counts: true },
  { name: "changes requested", in: input({ reviews: [rv("carol", "CHANGES_REQUESTED")], reviewDecision: "CHANGES_REQUESTED" }), state: "changes", counts: false, who: "carol" },
  { name: "changes requested, then asked to look again", in: input({ reviews: [rv("carol", "CHANGES_REQUESTED")], reviewers: [{ login: "carol" }] }), state: "changes-again", counts: false, askedAgain: true },
  { name: "approved, then asked to look again: still counts, and is marked", in: input({ reviews: [rv("alice", "APPROVED")], reviewers: [{ login: "alice" }] }), state: "approved", counts: true, askedAgain: true },
  { name: "commented only", in: input({ reviews: [rv("erin", "COMMENTED")] }), state: "commented", counts: false },
  { name: "commented, with two threads open that they started", in: input({ reviews: [rv("erin", "COMMENTED")], threadAuthors: ["erin", "Erin", "alice"] }), state: "commented", counts: false, threads: 2 },
  { name: "asked and never answered", in: input({ reviewers: [{ login: "dave" }] }), state: "requested", counts: false },
  { name: "review dismissed, nobody asked again", in: input({ reviews: [rv("dave", "DISMISSED")] }), state: "dismissed", counts: false },
  { name: "review dismissed, asked again: it is a request", in: input({ reviews: [rv("dave", "DISMISSED")], reviewers: [{ login: "dave" }] }), state: "requested", counts: false },
  { name: "a team is asked, not a person", in: input({ reviewers: [{ login: "acme/orbit-core", isTeam: true }] }), state: "team", counts: false, who: "acme/orbit-core" },
  { name: "a later approval replaces an earlier change request", in: input({ reviews: [rv("carol", "CHANGES_REQUESTED", 120), rv("carol", "APPROVED", 30)] }), state: "approved", counts: true },
  { name: "a later comment does not undo a change request", in: input({ reviews: [rv("carol", "CHANGES_REQUESTED", 120), rv("carol", "COMMENTED", 30)] }), state: "changes", counts: false },
];

describe("one reviewer, every state", () => {
  for (const c of cases) {
    test(c.name, () => {
      const r = buildRoster(c.in);
      expect(r.entries).toHaveLength(1);
      const e = r.entries[0]!;
      expect(e.state).toBe(c.state);
      expect(e.counts).toBe(c.counts);
      if (c.who) expect(e.login).toBe(c.who);
      expect(e.threads).toBe(c.threads ?? 0);
      expect(e.askedAgain).toBe(c.askedAgain ?? false);
      expect(r.counted).toBe(c.counts ? 1 : 0);
    });
  }
});

describe("who is never a reviewer", () => {
  test("the author's own comments and approvals", () => {
    const r = buildRoster(input({ reviews: [rv("bob", "COMMENTED"), rv("BOB", "APPROVED")], reviewers: [{ login: "bob" }] }));
    expect(r.entries).toEqual([]);
  });
  test("a bot, whatever it says", () => {
    const r = buildRoster(input({ reviews: [rv("orbit-bot", "APPROVED", 60, HEAD, true), rv("orbit-bot", "CHANGES_REQUESTED", 30, HEAD, true)] }));
    expect(r.entries).toEqual([]);
    expect(r.counted).toBe(0);
  });
  test("a review that was started and never submitted", () => {
    expect(buildRoster(input({ reviews: [rv("erin", "PENDING")] })).entries).toEqual([]);
  });
});

describe("the approvals the branch asks for", () => {
  test.each([[1, 1], [2, 2], [3, 3]])("branch protection asks for %i: needed is %i", (n, want) => {
    expect(buildRoster(input({ gate: gate(n) })).needed).toBe(want);
  });
  test("a readable branch with no rule: reviews are not required", () => {
    expect(buildRoster(input({ gate: gate(0), reviewDecision: null })).needed).toBe(0);
  });
  test("a rule nobody could read is null, never a number made up", () => {
    expect(buildRoster(input({ gate: gate(0, { protectionVisible: false }), reviewDecision: "REVIEW_REQUIRED" })).needed).toBeNull();
    expect(buildRoster(input({ gate: undefined })).needed).toBeNull();
  });
  test("GitHub asking for a review beats a rule that read as zero", () => {
    expect(buildRoster(input({ gate: gate(0), reviewDecision: "REVIEW_REQUIRED" })).needed).toBeNull();
  });
  test("the headline for each", () => {
    const two = buildRoster(input({ reviews: [rv("alice", "APPROVED")] }));
    expect(approvalsNeed(two, "REVIEW_REQUIRED")).toBe("1 of 2 approvals needed");
    const met = buildRoster(input({ gate: gate(1), reviews: [rv("alice", "APPROVED")], reviewDecision: "APPROVED" }));
    expect(approvalsNeed(met, "APPROVED")).toBe("1 of 1 approvals");
    expect(approvalsNeed(buildRoster(input({ gate: gate(0), reviewDecision: null })), null)).toBe("review not required");
    expect(approvalsNeed(buildRoster(input({ gate: undefined })), "REVIEW_REQUIRED")).toBe("approval required");
    expect(approvalsNeed(buildRoster(input({ gate: undefined })), "APPROVED")).toBeNull();
  });
  test("stale approvals that the repository dismisses do not add to the count", () => {
    const r = buildRoster(input({ gate: gate(2, { dismissStale: true }), reviews: [rv("alice", "APPROVED"), rv("bobby", "APPROVED", 60, "c1")] }));
    expect(r.counted).toBe(1);
    expect(approvalsNeed(r, "REVIEW_REQUIRED")).toBe("1 of 2 approvals needed");
  });
});

describe("five reviewers, five states", () => {
  const r = buildRoster(input({
    gate: gate(3),
    reviews: [rv("alice", "APPROVED", 180), rv("bobby", "APPROVED", 25, "c1"), rv("carol", "CHANGES_REQUESTED", 120), rv("dave", "CHANGES_REQUESTED", 1440), rv("erin", "COMMENTED", 60)],
    reviewers: [{ login: "dave" }], threadAuthors: ["carol", "carol", "carol", "carol", "erin"],
  }));
  test("ordered the way the tally reads, with the counts", () => {
    expect(r.entries.map((e) => [e.login, e.state])).toEqual([
      ["alice", "approved"], ["bobby", "approved-old"], ["carol", "changes"], ["dave", "changes-again"], ["erin", "commented"],
    ]);
    expect(rosterCounts(r.entries)).toBe("2 approved · 1 changes · 1 re-requested · 1 commented");
    expect(approvalsNeed(r, "CHANGES_REQUESTED")).toBe("2 of 3 approvals needed");
  });
  test("each thread belongs to the person who opened it", () => {
    expect(r.entries.map((e) => e.threads)).toEqual([0, 0, 4, 0, 1]);
  });
});
