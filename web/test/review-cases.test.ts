// "Every possible case" of the review side of the merge box, one row of a table
// each: what the headline says, what the Review cell says, the tally, the rows
// and who moves each. The roster's own states are in review-roster.test.ts; this
// is what the box makes of them. People are invented (bob wrote the pull
// request; alice, bobby, carol, dave, erin review; acme/orbit-core is a team).
import { describe, expect, test } from "bun:test";
import { mergePath, type ActionId, type MergePath, type MergePathInput, type StageStatus } from "../../shared/mergePath.ts";
import type { ReviewerState } from "../../shared/reviewRoster.ts";
import type { PrCheck, PrMergeGate, PrReview } from "../../shared/types.ts";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const HEAD = "c2";
const rv = (author: string, state: PrReview["state"], min = 60, commit = HEAD, isBot = false): PrReview =>
  ({ author, isBot, state, body: "", submittedAt: ago(min), nodeId: `n-${author}`, url: `https://example.test/r/${author}`, commit });
const gate = (over: Partial<PrMergeGate> = {}): PrMergeGate => ({
  permission: "WRITE", canBypass: false, protectionVisible: true, locked: false, viewerCanPush: true, approvals: 2, codeOwners: false,
  lastPushApproval: false, dismissStale: false, conversationResolution: false, upToDate: false, signatures: false, deployments: [],
  requiredContexts: [], mergeQueue: false, inQueue: false, ...over,
});
const ci: PrCheck[] = [{ name: "build", workflow: "CI", state: "success", done: true, required: true }];
const pr = (over: Partial<MergePathInput> = {}): MergePathInput => ({
  state: "OPEN", mergeState: "BLOCKED", mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED", author: "bob", viewerDidAuthor: true,
  checksAll: ci, gate: gate(), baseRefName: "main", openThreads: 0, headSha: HEAD, now: NOW, ...over,
});

const say = (p: MergePath) => p.hero.parts.map((x) => x.text).join("");
const review = (p: MergePath) => p.stages.find((s) => s.key === "review")!;
/** [title, label] of each row in the order drawn, with a · for the ones that are not counted. */
const rows = (p: MergePath) => p.rows.map((r) => `${r.counted ? "" : "· "}${r.title} → ${r.moverLabel}`);

interface Case {
  name: string; in: MergePathInput;
  say?: string | RegExp; need?: string | undefined | null; sub?: string; status?: StageStatus;
  rows?: string[]; tally?: ReviewerState[]; primary?: ActionId; ready?: boolean;
}

const cases: Case[] = [
  {
    name: "five reviewers, five states (the approved mockup)",
    in: pr({
      reviewDecision: "CHANGES_REQUESTED", gate: gate({ approvals: 3, conversationResolution: true }), openThreads: 5,
      reviews: [rv("alice", "APPROVED", 180), rv("bobby", "APPROVED", 25, "c1"), rv("carol", "CHANGES_REQUESTED", 120), rv("dave", "CHANGES_REQUESTED", 1440), rv("erin", "COMMENTED", 60)],
      reviewers: [{ login: "dave" }], threadAuthors: ["carol", "carol", "carol", "carol", "erin"], askedAt: { dave: ago(20) },
    }),
    say: "carol still wants changes. Answer the 4 threads. dave's re-review is pending.",
    need: "2 of 3 approvals needed", sub: "2 approved · 1 changes · 1 re-requested · 1 commented", status: "blocked",
    tally: ["approved", "approved-old", "changes", "changes-again", "commented"],
    rows: [
      "carol · changes requested → YOU", "erin · commented → YOU", "dave · re-review requested → DAVE",
      "· alice · approved → DONE", "· bobby · approved → DONE",
    ],
  },
  {
    name: "approved on the current commit, with a second approval: ready",
    in: pr({ mergeState: "CLEAN", reviewDecision: "APPROVED", reviews: [rv("alice", "APPROVED"), rv("bobby", "APPROVED")] }),
    say: "Ready to merge.", ready: true, need: "2 of 2 approvals", status: "done", rows: ["· alice · approved → DONE", "· bobby · approved → DONE"],
  },
  {
    name: "one approval where two are needed, nobody else asked",
    in: pr({ reviews: [rv("alice", "APPROVED")] }),
    say: "Ask someone to review. Nobody has been asked, and it needs an approving review.", primary: "ask-review",
    need: "1 of 2 approvals needed", rows: ["Needs 1 more approving review → YOU", "· alice · approved → DONE"],
  },
  {
    name: "one approval where two are needed, the second is asked",
    in: pr({ reviews: [rv("alice", "APPROVED")], reviewers: [{ login: "dave" }] }),
    say: "Waiting on dave to review.", need: "1 of 2 approvals needed", status: "wait", sub: "1 approved · 1 not answered",
    rows: ["dave · review requested → DAVE", "· alice · approved → DONE"],
  },
  {
    name: "three approvals needed, one in, one asked: the third is still nobody's",
    in: pr({ gate: gate({ approvals: 3 }), reviews: [rv("alice", "APPROVED")], reviewers: [{ login: "dave" }] }),
    say: "Ask someone else to review. dave is asked, and it needs one more approval.", primary: "ask-review", need: "1 of 3 approvals needed",
    rows: ["Needs 1 more approving review → YOU", "dave · review requested → DAVE", "· alice · approved → DONE"],
  },
  {
    name: "approved before a push and the repository keeps approvals: counts, and says so",
    in: pr({ mergeState: "CLEAN", reviewDecision: "APPROVED", gate: gate({ approvals: 1 }), reviews: [rv("alice", "APPROVED", 60, "c1")] }),
    say: "Ready to merge.", ready: true, need: "1 of 1 approvals", tally: ["approved-old"], rows: ["· alice · approved → DONE"],
  },
  {
    name: "approved before a push and the repository dismisses stale approvals: does not count",
    in: pr({ gate: gate({ approvals: 1, dismissStale: true }), reviews: [rv("alice", "APPROVED", 60, "c1")] }),
    say: "alice's approval no longer counts. It was given before the last push.", primary: "ask-review",
    need: "0 of 1 approvals needed", tally: ["approved-void"], rows: ["alice · approval no longer counts → YOU"],
  },
  {
    name: "changes requested, viewer wrote it",
    in: pr({ reviewDecision: "CHANGES_REQUESTED", reviews: [rv("carol", "CHANGES_REQUESTED", 120)], gate: gate({ approvals: 1 }) }),
    say: "carol still wants changes. Address them and ask for another look.", rows: ["carol · changes requested → YOU"], need: "0 of 1 approvals needed",
  },
  {
    name: "changes requested, viewer did not write it",
    in: pr({ viewerDidAuthor: false, reviewDecision: "CHANGES_REQUESTED", reviews: [rv("carol", "CHANGES_REQUESTED", 120)] }),
    say: "carol wants changes. The author has to answer them.", rows: ["carol · changes requested → AUTHOR"],
  },
  {
    name: "changes requested, then asked to look again: it is carol's move",
    in: pr({ reviewDecision: "CHANGES_REQUESTED", reviews: [rv("carol", "CHANGES_REQUESTED", 1440)], reviewers: [{ login: "carol" }] }),
    say: "carol was asked to look again. The changes are in; it is their move.", status: "wait", rows: ["carol · re-review requested → CAROL"],
  },
  {
    name: "approved, but changes requested by another still blocks",
    in: pr({ reviewDecision: "CHANGES_REQUESTED", reviews: [rv("alice", "APPROVED"), rv("carol", "CHANGES_REQUESTED")] }),
    say: /^carol still wants changes/, need: "1 of 2 approvals needed", rows: ["carol · changes requested → YOU", "· alice · approved → DONE"],
  },
  {
    name: "commented only, approvals not required: FYI",
    in: pr({ mergeState: "CLEAN", reviewDecision: null, gate: gate({ approvals: 0 }), reviews: [rv("erin", "COMMENTED")] }),
    say: "Ready to merge.", ready: true, need: "review not required", rows: ["· erin · commented → FYI"],
  },
  {
    name: "commented with an open thread, the branch requires them resolved: on the author",
    in: pr({ gate: gate({ approvals: 1, conversationResolution: true }), reviewDecision: "APPROVED", reviews: [rv("alice", "APPROVED"), rv("erin", "COMMENTED", 30)], openThreads: 1, threadAuthors: ["erin"] }),
    say: "erin left 1 thread open. Answer and press Resolve on each.", primary: "go-thread", rows: ["erin · commented → YOU", "· alice · approved → DONE"],
  },
  {
    name: "commented with an open thread, the branch does not require them resolved: FYI",
    in: pr({ mergeState: "CLEAN", reviewDecision: "APPROVED", gate: gate({ approvals: 1 }), reviews: [rv("alice", "APPROVED"), rv("erin", "COMMENTED", 30)], openThreads: 1, threadAuthors: ["erin"] }),
    say: "Ready to merge.", ready: true, rows: ["· erin · commented → FYI", "· alice · approved → DONE"],
  },
  {
    name: "asked and never answered, viewer is the author",
    in: pr({ reviewers: [{ login: "dave" }], gate: gate({ approvals: 1 }) }),
    say: "Waiting on dave to review.", status: "wait", need: "0 of 1 approvals needed", rows: ["dave · review requested → DAVE"],
  },
  {
    name: "asked and never answered, the viewer is the one asked",
    in: pr({ viewerDidAuthor: false, viewerRequested: true, reviewers: [{ login: "dave" }], gate: gate({ approvals: 1 }) }),
    say: "Your review is what this is waiting for.", rows: ["dave · review requested → YOU"],
  },
  {
    name: "review dismissed, nobody asked again",
    in: pr({ gate: gate({ approvals: 1 }), reviews: [rv("dave", "DISMISSED")] }),
    say: "dave's review was dismissed, so it no longer counts.", primary: "ask-review", rows: ["dave · review dismissed → YOU"],
  },
  {
    name: "a review requested from a team, not a person",
    in: pr({ gate: gate({ approvals: 1 }), reviewers: [{ login: "acme/orbit-core", isTeam: true }] }),
    say: "Waiting on acme/orbit-core to review.", status: "wait", tally: ["team"], need: "0 of 1 approvals needed",
    rows: ["acme/orbit-core · review requested from the team → TEAM"],
  },
  {
    name: "a team and a person asked together",
    in: pr({ reviewers: [{ login: "acme/orbit-core", isTeam: true }, { login: "dave" }] }),
    say: "Waiting on dave and acme/orbit-core to review.", rows: ["dave · review requested → DAVE", "acme/orbit-core · review requested from the team → TEAM"],
  },
  {
    name: "a code owner is required and nobody was asked",
    in: pr({ gate: gate({ approvals: 1, codeOwners: true }), reviewers: [{ login: "dave" }] }),
    rows: ["dave · review requested → DAVE"],
  },
  {
    name: "the author's own comments and a bot's approval are never a reviewer",
    in: pr({ gate: gate({ approvals: 1 }), reviews: [rv("bob", "COMMENTED"), rv("bob", "APPROVED"), rv("orbit-bot", "APPROVED", 5, HEAD, true)] }),
    say: /^Ask someone to review/, need: "0 of 1 approvals needed", rows: ["Needs 1 approving review → YOU"], tally: undefined,
  },
  {
    name: "no reviewers at all and review required: ask someone",
    in: pr({ gate: gate({ approvals: 1 }) }),
    say: "Ask someone to review. Nobody has been asked, and it needs an approving review.", primary: "ask-review", rows: ["Needs 1 approving review → YOU"],
  },
  {
    name: "no reviewers, two approvals needed: the count is in the sentence",
    in: pr({}),
    say: "Ask someone to review. Nobody has been asked, and it needs 2 more approvals.", primary: "ask-review",
  },
  {
    name: "no reviewers, viewer did not write it: not theirs to ask",
    in: pr({ viewerDidAuthor: false }),
    say: "It needs an approving review, and nobody has been asked.", rows: ["Needs 2 approving reviews → AUTHOR"],
  },
  {
    name: "the branch rule could not be read: no number is made up",
    in: pr({ gate: gate({ approvals: 0, protectionVisible: false }), reviews: [rv("alice", "APPROVED")] }),
    need: "approval required", rows: ["Needs an approving review → YOU", "· alice · approved → DONE"],
  },
  {
    name: "no rule at all and a person asked: still ready, but merging skips them (a warning, not a wait)",
    in: pr({ mergeState: "CLEAN", reviewDecision: null, gate: gate({ approvals: 0 }), reviewers: [{ login: "dave" }] }),
    say: "Ready to merge.", ready: true, need: "review not required", status: "idle", rows: ["· dave · review requested → DAVE"],
  },
  {
    name: "approvals satisfied but a thread is open and must be resolved",
    in: pr({ reviewDecision: "APPROVED", gate: gate({ approvals: 1, conversationResolution: true }), reviews: [rv("alice", "APPROVED")], openThreads: 2 }),
    say: "2 review threads still open. Answer them and press Resolve on each.", need: "1 of 1 approvals", status: "blocked", rows: ["2 review threads open → YOU", "· alice · approved → DONE"],
  },
  {
    name: "a draft with everything approved",
    in: pr({ isDraft: true, reviewDecision: "APPROVED", gate: gate({ approvals: 1 }), reviews: [rv("alice", "APPROVED")] }),
    say: "This is still a draft. Mark it ready for review to start the merge path.", rows: ["It is a draft → YOU", "· alice · approved → DONE"],
  },
];

describe("the review side, every case", () => {
  for (const c of cases) {
    test(c.name, () => {
      const p = mergePath(c.in);
      if (c.say !== undefined) typeof c.say === "string" ? expect(say(p)).toBe(c.say) : expect(say(p)).toMatch(c.say);
      if (c.ready !== undefined) expect(p.ready).toBe(c.ready);
      if ("need" in c) expect(review(p).need).toBe(c.need ?? undefined);
      if (c.sub !== undefined) expect(review(p).sub).toBe(c.sub);
      if (c.status !== undefined) expect(review(p).status).toBe(c.status);
      if (c.rows) expect(rows(p).slice(0, c.rows.length)).toEqual(c.rows);
      if ("tally" in c) expect(review(p).tally?.map((t) => t.key)).toEqual(c.tally);
      if (c.primary) expect(p.hero.primary?.id).toBe(c.primary);
    });
  }
});

describe("ordering", () => {
  test("what is the viewer's comes before a reviewer's, and done rows come last", () => {
    const p = mergePath(cases[0]!.in);
    expect(p.rows.map((r) => r.mover)).toEqual(["you", "you", "reviewer", "done", "done"]);
    expect(p.rows.filter((r) => r.counted).map((r) => r.n)).toEqual([1, 2, 3]);
    expect(p.count).toBe(3);
  });
  test("the reviewer rows carry the person, for the avatar", () => {
    const p = mergePath(cases[0]!.in);
    expect(p.rows.map((r) => r.person?.state)).toEqual(["changes", "commented", "changes-again", "approved", "approved-old"]);
  });
  test("a code owner rule is said on the rows that wait for someone", () => {
    const p = mergePath(cases.find((c) => c.name.startsWith("a code owner"))!.in);
    expect(p.rows[0]!.why).toContain("code owner");
  });
});

describe("no request to GitHub is made from here", () => {
  test("the model is pure: it reads the gate the detail already carries", async () => {
    const src = await Bun.file(new URL("../../shared/reviewRoster.ts", import.meta.url)).text();
    expect(src).not.toMatch(/fetch\(|gh\(|Bun\.spawn|await /);
  });
});
