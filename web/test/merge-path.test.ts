// The merge box's decision, one test per state a pull request can be in.
//
// Each state is asked the same four things — what the hero says and offers,
// which stage holds the merge, what the rows are and who moves each — because
// that is the whole box. Fixtures are the shape of real pull requests with
// invented people (alice reviews, bob wrote it) and invented workflows.
import { describe, expect, test } from "bun:test";
import { mergePath, checkKindLine, fmtEta, type MergePathInput, type MergePath } from "../../shared/mergePath.ts";
import type { PrCheck, PrMergeGate, PrReview } from "../../shared/types.ts";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const S = 1000, M = 60 * S, H = 60 * M;

const check = (name: string, state: PrCheck["state"], over: Partial<PrCheck> = {}): PrCheck =>
  ({ name, workflow: "CI", state, done: state !== "pending", ...over });
const req = (name: string, state: PrCheck["state"], over: Partial<PrCheck> = {}) => check(name, state, { required: true, ...over });
const running = (name: string, over: Partial<PrCheck> = {}) => check(name, "pending", { startedAt: ago(40 * S), ...over });

const gate = (over: Partial<PrMergeGate> = {}): PrMergeGate => ({
  permission: "WRITE", canBypass: false, protectionVisible: true, locked: false,
  viewerCanPush: true, approvals: 1, codeOwners: false, lastPushApproval: false,
  dismissStale: false, conversationResolution: false, upToDate: false, signatures: false,
  deployments: [], requiredContexts: [], mergeQueue: false, inQueue: false, ...over,
});

const review = (author: string, state: PrReview["state"], at = ago(5 * H)): PrReview =>
  ({ author, isBot: false, state, body: "", submittedAt: at, nodeId: `r-${author}-${state}`, url: `https://example.test/r/${author}` });

const base = (over: Partial<MergePathInput> = {}): MergePathInput => ({
  state: "OPEN", mergeState: "CLEAN", mergeable: "MERGEABLE", reviewDecision: "APPROVED",
  humanReview: { kind: "approved", who: ["alice"] },
  reviews: [review("alice", "APPROVED")], author: "bob", viewerDidAuthor: true,
  checksAll: [req("build", "success"), req("audit", "success")], gate: gate(),
  baseRefName: "main", openThreads: 0, now: NOW, ...over,
});

const say = (p: MergePath) => p.hero.parts.map((x) => x.text).join("");
const rowKinds = (p: MergePath) => p.rows.filter((r) => r.counted).map((r) => [r.kind, r.mover]);
const stage = (p: MergePath, k: string) => p.stages.find((s) => s.key === k)!;
const current = (p: MergePath) => p.stages.find((s) => s.current)?.key;

describe("approved and everything green", () => {
  const p = mergePath(base());
  test("the hero says ready and the primary is the merge", () => {
    expect(p.ready).toBe(true);
    expect(p.hero.tone).toBe("ready");
    expect(say(p)).toBe("Ready to merge.");
    expect(p.hero.primary?.id).toBe("merge");
    expect(p.hero.sub).toContain("Approved by alice");
    expect(p.hero.sub).toContain("2 required checks passed");
  });
  test("no list, no callout, every stage done and the merge is the current one", () => {
    expect(p.count).toBe(0);
    expect(p.callout).toBeNull();
    expect(p.stages.map((s) => s.status)).toEqual(["done", "done", "idle", "done"]);
    expect(current(p)).toBe("merge");
  });
  test("other CI still running does not stop it, and is said", () => {
    const q = mergePath(base({ mergeState: "UNSTABLE", checksAll: [req("build", "success"), running("lint"), running("e2e")] }));
    expect(q.ready).toBe(true);
    expect(q.hero.sub).toContain("2 other checks are still running, none required");
    expect(q.otherCi?.running).toBe(2);
  });
  test("no checks at all is said as that, not as green", () => {
    const q = mergePath(base({ checksAll: [], gate: gate() }));
    expect(q.hero.sub).toContain("no checks reported on this commit");
  });
});

describe("a required check failing", () => {
  const p = mergePath(base({
    mergeState: "BLOCKED",
    checksAll: [req("build", "failure", { url: "https://example.test/run/1", startedAt: ago(9 * M), completedAt: ago(5 * M) }), req("audit", "success")],
  }));
  test("the hero names it and offers the log, then the re-run", () => {
    expect(p.ready).toBe(false);
    expect(say(p)).toBe("build is failing. Open the log, fix it or re-run it.");
    expect(p.hero.parts[0]).toEqual({ text: "build", em: true });
    expect(p.hero.primary).toEqual({ id: "open-log", label: "Open log ↗", url: "https://example.test/run/1" });
    expect(p.hero.secondary?.id).toBe("rerun");
    expect(p.hero.tone).toBe("you");
  });
  test("one row on you, with the failure said", () => {
    expect(rowKinds(p)).toEqual([["check-failing", "you"]]);
    const r = p.rows[0]!;
    expect(r.pill).toBe("required");
    expect(r.why).toContain("Failed after 4 min");
    expect(r.ring?.mode).toBe("failed");
  });
  test("the required-checks stage is the one that holds it", () => {
    expect(current(p)).toBe("required");
    expect(stage(p, "required").status).toBe("blocked");
    expect(stage(p, "required").big).toBe("1 failing");
  });
  test("two failing are named, three are counted; no log means the re-run leads", () => {
    const two = mergePath(base({ mergeState: "BLOCKED", checksAll: [req("build", "failure"), req("lint", "failure")] }));
    expect(say(two)).toContain("build and lint are failing.");
    expect(two.hero.primary?.id).toBe("rerun");
    const three = mergePath(base({ mergeState: "BLOCKED", checksAll: [req("a", "failure"), req("b", "failure"), req("c", "failure")] }));
    expect(say(three)).toContain("3 required checks are failing.");
  });
  test("somebody else's pull request: it is the author's to fix", () => {
    const q = mergePath(base({ mergeState: "BLOCKED", viewerDidAuthor: false, checksAll: [req("build", "failure")] }));
    expect(rowKinds(q)).toEqual([["check-failing", "author"]]);
    expect(q.hero.eyebrow).toContain("THE AUTHOR'S");
  });
  test("a failing check that is not required is not a row, it is Other CI", () => {
    const q = mergePath(base({ mergeState: "UNSTABLE", checksAll: [req("build", "success"), check("e2e", "failure")] }));
    expect(q.ready).toBe(true);
    expect(q.count).toBe(0);
    expect(q.otherCi?.failed).toBe(1);
  });
});

describe("conflicts", () => {
  const p = mergePath(base({ mergeState: "DIRTY", mergeable: "CONFLICTING", conflictFiles: 3 }));
  test("the hero counts the files and hands over to the resolver", () => {
    expect(say(p)).toBe("It conflicts with main. Resolve 3 files and push.");
    expect(p.hero.primary?.id).toBe("resolve-conflicts");
    expect(rowKinds(p)).toEqual([["conflicts", "you"]]);
  });
  test("the merge stage holds it", () => {
    expect(current(p)).toBe("merge");
    expect(stage(p, "merge").sub).toBe("Conflicts with main");
    expect(p.otherCi).toBeNull();
  });
});

describe("a draft", () => {
  const p = mergePath(base({ mergeState: "DRAFT", isDraft: true }));
  test("mark ready is the one thing to do", () => {
    expect(say(p)).toContain("still a draft");
    expect(p.hero.primary?.id).toBe("mark-ready");
    expect(rowKinds(p)).toEqual([["draft", "you"]]);
  });
  test("not yours: no button", () => {
    expect(mergePath(base({ mergeState: "DRAFT", isDraft: true, viewerDidAuthor: false })).hero.primary).toBeUndefined();
  });
});

describe("a locked base, and GitHub not saying why", () => {
  test("a lock is not yours to move, and checks going green will not clear it", () => {
    const p = mergePath(base({ mergeState: "BLOCKED", gate: gate({ locked: true, lockedBy: "release freeze" }) }));
    expect(p.hero.tone).toBe("stuck");
    expect(say(p)).toBe("main is locked. Nothing merges into it until it is unlocked.");
    expect(p.hero.sub).toContain("release freeze");
    expect(p.hero.primary?.id).toBe("open-github");
    expect(rowKinds(p)).toEqual([["locked", "other"]]);
    expect(p.rows[0]!.moverLabel).toBe("SOMEONE ELSE");
  });
  test("a lock the viewer may merge past is a note, and the merge is live", () => {
    const p = mergePath(base({ gate: gate({ locked: true, canBypass: true }) }));
    expect(p.ready).toBe(true);
    expect(p.rows.map((r) => [r.kind, r.mover, r.counted])).toEqual([["locked", "fyi", false], ["approved", "done", false]]);
  });
  test("BLOCKED with nothing visible says so in GitHub's words", () => {
    const p = mergePath(base({ mergeState: "BLOCKED", gate: undefined, checksAll: [req("build", "success")], reviewDecision: "APPROVED" }));
    expect(say(p)).toBe("GitHub is blocking it without saying why.");
    expect(p.hero.primary?.id).toBe("open-github");
    expect(p.hero.sub).toContain("locked branch");
    expect(rowKinds(p)).toEqual([["unexplained", "other"]]);
  });
});

describe("review", () => {
  test("required and nobody asked", () => {
    const p = mergePath(base({ mergeState: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", humanReview: undefined, reviews: [], reviewers: [] }));
    expect(say(p)).toBe("It needs an approving review, and nobody has been asked.");
    expect(rowKinds(p)).toEqual([["review-required", "you"]]);
    expect(p.rows[0]!.sub).toBe("nobody has been asked yet");
    expect(current(p)).toBe("review");
    expect(stage(p, "review").status).toBe("blocked");
  });
  test("required and asked: it is the reviewers' move", () => {
    const p = mergePath(base({ mergeState: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", humanReview: { kind: "awaiting", who: ["alice", "carol"] }, reviews: [], reviewers: [{ login: "alice" }, { login: "carol" }] }));
    expect(say(p)).toBe("Waiting on alice and carol to review.");
    expect(rowKinds(p)).toEqual([["review-required", "reviewer"]]);
    expect(p.rows[0]!.moverLabel).toBe("REVIEWER");
    expect(p.hero.tone).toBe("wait");
    expect(stage(p, "review").status).toBe("wait");
  });
  test("the viewer is the one asked", () => {
    const p = mergePath(base({ mergeState: "BLOCKED", viewerDidAuthor: false, viewerRequested: true, reviewDecision: "REVIEW_REQUIRED", humanReview: { kind: "awaiting", who: ["alice"] }, reviews: [], reviewers: [{ login: "alice" }] }));
    expect(rowKinds(p)).toEqual([["review-required", "you"]]);
    expect(say(p)).toBe("Your review is what this is waiting for.");
  });
  test("a code-owner rule is named where the gate has one", () => {
    const p = mergePath(base({ mergeState: "BLOCKED", gate: gate({ codeOwners: true }), reviewDecision: "REVIEW_REQUIRED", humanReview: undefined, reviews: [], reviewers: [] }));
    expect(p.rows[0]!.why).toContain("code owner");
  });
  test("an approval nobody required does not hold anything", () => {
    const p = mergePath(base({ reviewDecision: null, humanReview: { kind: "commented", who: ["alice"] }, gate: gate({ approvals: 0 }) }));
    expect(p.ready).toBe(true);
    expect(stage(p, "review").status).toBe("idle");
  });
});

// The pull request that started the design: a reviewer still wants changes, twelve
// threads open, two required checks still running and a fifty-eight-check tail.
describe("changes requested, threads open, CI still running", () => {
  const others = [
    ...Array.from({ length: 12 }, (_, k) => running(`other-${k}`, { workflow: "Nightly" })),
    ...Array.from({ length: 3 }, (_, k) => check(`skip-${k}`, "skipped", { workflow: "Nightly" })),
    ...Array.from({ length: 43 }, (_, k) => check(`queued-${k}`, "pending", { workflow: "Nightly" })),
  ];
  const input = base({
    mergeState: "BLOCKED", reviewDecision: "CHANGES_REQUESTED",
    humanReview: { kind: "changes", who: ["alice"], at: ago(5 * 24 * H) },
    reviews: [review("alice", "CHANGES_REQUESTED", ago(5 * 24 * H))],
    gate: gate({ conversationResolution: true }), openThreads: 12,
    checksAll: [
      req("summary", "pending", { workflow: "CI / Tests" }),
      req("audit", "pending", { workflow: "Ops / Audit", startedAt: ago(40 * S) }),
      check("audit", "success", { workflow: "Ops / Audit", event: "pull_request_review", required: false, startedAt: ago(2 * H), completedAt: ago(2 * H - 50 * S) }),
      ...others,
    ],
  });
  const p = mergePath(input);
  test("the hero is sentence-first: who, what to do, and when after that", () => {
    expect(say(p)).toBe("alice still wants changes. Answer the 12 threads, then this can merge.");
    expect(p.hero.tone).toBe("you");
    expect(p.hero.parts[0]).toEqual({ text: "alice", em: true });
    expect(p.hero.primary).toEqual({ id: "go-thread", label: "Go to first open thread →" });
    expect(p.hero.after).toBe("then re-request review from alice");
    expect(p.hero.sub).toContain("CI is finishing the 2 required checks by itself");
  });
  test("four rows, two on you first and two on CI, numbered in that order", () => {
    expect(p.count).toBe(4);
    expect(rowKinds(p)).toEqual([["changes", "you"], ["threads", "you"], ["check-queued", "ci"], ["check-running", "ci"]]);
    expect(p.rows.filter((r) => r.counted).map((r) => r.n)).toEqual([1, 2, 3, 4]);
    expect(p.rows[0]!.sub).toBe("by alice · 5d ago");
    expect(p.rows[0]!.why).toBe("Clears only when alice approves or the request is dismissed.");
  });
  test("a running check with a known duration shows how far along, an unknown one only that it runs", () => {
    const audit = p.rows.find((r) => r.title === "audit")!;
    // The done run of the same job under another event is what "typical" is.
    expect(audit.why).toContain("40s of ~50s");
    expect(audit.ring).toEqual({ mode: "running", fraction: 0.8 });
    expect(audit.sub).toBe("Ops / Audit");
    expect(audit.pill).toBe("required");
    const summary = p.rows.find((r) => r.title === "summary")!;
    expect(summary.ring).toEqual({ mode: "queued" });
    expect(summary.why).toContain("Roll-up");
    expect(summary.why).toContain("Not started yet");
  });
  test("the strip: review holds it, required checks are in flight, the rest wait", () => {
    expect(current(p)).toBe("review");
    expect(p.stages.map((s) => s.status)).toEqual(["blocked", "wait", "idle", "idle"]);
    expect(stage(p, "review").sub).toBe("you are here · 12 threads");
    expect(stage(p, "required").sub).toBe("1 running · 1 queued · by themselves");
    expect(stage(p, "other").sub).toBe("optional · 55 running");
    expect(stage(p, "merge").sub).toBe("opens after 1 and 2");
  });
  test("Other CI is one row: the rollup's numbers, minus the two required", () => {
    // 61 checks in the rollup: 2 required, and 59 others counting the finished audit run under the other event.
    expect(p.otherCi).toMatchObject({ total: 59, passed: 1, failed: 0, running: 12, queued: 43, skipped: 3 });
    expect(p.otherCi!.text).toBe("12 running · 1 passed · 43 queued · 3 skipped of 59");
    expect(p.otherCi!.tail).toBe("No conflicts");
    expect(p.otherCi!.segments.map((s) => s.key)).toEqual(["passed", "running", "skipped", "queued"]);
  });
  test("the callout says which rows Merge when green does not cover", () => {
    expect(p.callout).toEqual({ tone: "warn", text: `"Merge when green" covers the CI rows only — rows 1–2 are on you.` });
  });
  test("the same duration known for both means the hero can say how long", () => {
    const q = mergePath({ ...input, checksAll: [
      req("audit", "pending", { workflow: "Ops / Audit", startedAt: ago(40 * S) }),
      check("audit", "success", { workflow: "Ops / Audit", event: "pull_request_review", startedAt: ago(2 * H), completedAt: ago(2 * H - 5 * M) }),
    ] });
    expect(say(q)).toBe("alice still wants changes. Answer the 12 threads, then this can merge in about 4 min.");
  });
  test("history is offered once there is a round to look back on", () => {
    expect(p.historyCount).toBe(1);
    expect(p.hero.secondary).toEqual({ id: "history", label: "Review history (1)" });
  });
  test("re-asked: the ball is with the reviewer", () => {
    const q = mergePath({ ...input, humanReview: { kind: "changes", who: ["alice"], askedAgain: true, at: ago(5 * 24 * H) } });
    expect(rowKinds(q).slice(0, 2)).toEqual([["threads", "you"], ["changes", "reviewer"]]);
    expect(say(q)).toBe("12 review threads still open. Answer them and press Resolve on each.");
  });
});

describe("only CI is left", () => {
  const two = [req("build", "pending", { startedAt: ago(1 * M) }), req("audit", "pending")];
  const p = mergePath(base({ mergeState: "BLOCKED", checksAll: two }));
  test("nothing to do, and the primary is to arm auto-merge", () => {
    expect(p.hero.tone).toBe("wait");
    expect(p.hero.eyebrow).toBe("WAITING ON CI · NOTHING TO DO");
    expect(say(p)).toBe("Waiting on CI. The 2 required checks are still running.");
    expect(p.hero.primary).toEqual({ id: "arm-auto", label: "Merge when green" });
    expect(rowKinds(p).every(([, m]) => m === "ci")).toBe(true);
  });
  test("an ETA only from a duration this pull request already has", () => {
    const q = mergePath(base({ mergeState: "BLOCKED", checksAll: [
      req("build", "pending", { startedAt: ago(1 * M) }),
      check("build", "success", { event: "pull_request_review", startedAt: ago(3 * H), completedAt: ago(3 * H - 5 * M) }),
    ] }));
    expect(say(q)).toBe("Waiting on CI. The required check should finish in about 4 min.");
    expect(stage(q, "required").big).toBe("~4 min");
  });
  test("the ETA is the job's own median over earlier runs, not a guess", () => {
    const u = { usual: { median: 14 * M, p90: 16 * M, n: 20 } };
    const q = mergePath(base({ mergeState: "BLOCKED", checksAll: [req("evals", "pending", { startedAt: ago(4 * M), ...u })] }));
    expect(say(q)).toBe("Waiting on CI. The required check should finish in about 10 min.");
    // too little history: no number made up from it
    const few = mergePath(base({ mergeState: "BLOCKED", checksAll: [req("evals", "pending", { startedAt: ago(4 * M), usual: { ...u.usual, n: 3 } })] }));
    expect(say(few)).toBe("Waiting on CI. The required check is still running.");
  });
  test("a run that has outlived its earlier duration gets no ETA, not a negative one", () => {
    const q = mergePath(base({ mergeState: "BLOCKED", checksAll: [
      req("build", "pending", { startedAt: ago(9 * M) }),
      check("build", "success", { event: "pull_request_review", startedAt: ago(3 * H), completedAt: ago(3 * H - 5 * M) }),
    ] }));
    expect(say(q)).toBe("Waiting on CI. The required check is still running.");
    expect(q.rows[0]!.why).toContain("longer than the 5 min it took before");
  });
  test("armed already: it says so and offers nothing", () => {
    const q = mergePath(base({ mergeState: "BLOCKED", checksAll: two, autoArmed: true }));
    expect(q.hero.primary).toBeUndefined();
    expect(q.hero.sub).toContain("Auto-merge is armed");
  });
  test("with nobody else to move, Merge when green covers every row", () => {
    expect(p.callout?.tone).toBe("ok");
    expect(p.callout?.text).toContain("all 2 rows");
  });
  test("the runs GitHub has not created yet are waited for, not read as green", () => {
    const q = mergePath(base({ mergeState: "BLOCKED", checksAll: [], awaitingChecks: true }));
    expect(say(q)).toBe("Waiting for the checks to start.");
  });
  test("a required check that has not reported while others run is waiting, and one that never will is not", () => {
    const g = gate({ requiredContexts: ["deploy"] });
    const waiting = mergePath(base({ mergeState: "BLOCKED", gate: g, checksAll: [running("lint")] }));
    expect(rowKinds(waiting)).toEqual([["required-missing", "ci"]]);
    const never = mergePath(base({ mergeState: "BLOCKED", gate: g, checksAll: [check("lint", "success")] }));
    expect(rowKinds(never)).toEqual([["required-missing", "you"]]);
    expect(say(never)).toBe("deploy never reported. GitHub is waiting for it and nothing is running.");
  });
});

describe("behind the base", () => {
  test("where GitHub allows it: ready, with the update as the secondary", () => {
    const p = mergePath(base({ mergeState: "BEHIND", behind: 81 }));
    expect(p.ready).toBe(true);
    expect(say(p)).toBe("Ready to merge, but it is behind main.");
    expect(p.hero.secondary?.id).toBe("update-branch");
  });
  test("where the branch must be up to date: the update is the one thing", () => {
    const p = mergePath(base({ mergeState: "BEHIND", behind: 81, gate: gate({ upToDate: true }) }));
    expect(say(p)).toBe("It has to be up to date with main first.");
    expect(p.hero.primary?.id).toBe("update-branch");
  });
  test("Other CI says how far behind and whether that matters", () => {
    const p = mergePath(base({ mergeState: "UNSTABLE", behind: 81, checksAll: [req("build", "success"), running("lint")] }));
    expect(p.otherCi!.tail).toBe("No conflicts · 81 behind main (fine)");
  });
});

describe("counts are GitHub's", () => {
  const all = [
    req("a", "success"), req("b", "pending"), check("c", "success"), check("d", "failure"), check("e", "skipped"),
    check("f", "neutral"), running("g"), check("h", "pending"),
  ];
  const p = mergePath(base({ mergeState: "BLOCKED", checksAll: all }));
  test("required plus other is the rollup total, whatever the mix", () => {
    const requiredTotal = all.filter((c) => c.required).length;
    expect(p.otherCi!.total + requiredTotal).toBe(all.length);
    const o = p.otherCi!;
    expect(o.passed + o.failed + o.running + o.queued + o.skipped).toBe(o.total);
    expect(o).toMatchObject({ passed: 1, failed: 1, skipped: 2, running: 1, queued: 1 });
  });
  test("without the gate nothing is called required, and a red check on a blocked pull request gates it", () => {
    const q = mergePath(base({ mergeState: "BLOCKED", gate: undefined, checksAll: [check("x", "failure"), check("y", "success")] }));
    expect(rowKinds(q)).toEqual([["check-failing", "you"]]);
    expect(q.rows[0]!.pill).toBeUndefined();
    expect(q.otherCi!.total).toBe(1);
  });
  test("a job that runs once per event keeps both, told apart by the event", () => {
    const q = mergePath(base({ mergeState: "BLOCKED", checksAll: [
      req("build", "failure", { event: "pull_request" }), req("build", "failure", { event: "pull_request_review" }),
    ] }));
    expect(q.rows.map((r) => r.sub)).toEqual(["CI · pull_request", "CI · pull_request_review"]);
  });
});

describe("the words for a check", () => {
  test("GitHub's own title wins over a guess", () => {
    const p = mergePath(base({ mergeState: "BLOCKED", checksAll: [req("build", "failure", { title: "2 tests failed" })] }));
    expect(p.rows[0]!.why.startsWith("2 tests failed")).toBe(true);
  });
  test("otherwise a line by kind", () => {
    expect(checkKindLine({ name: "summary", workflow: "CI" }, true)).toContain("Roll-up");
    expect(checkKindLine({ name: "audit", workflow: "Ops" }, true)).toContain("Audits");
    expect(checkKindLine({ name: "unit", workflow: "Tests" }, true)).toContain("tests");
    expect(checkKindLine({ name: "eslint", workflow: "Lint" }, true)).toContain("lint");
    expect(checkKindLine({ name: "frobnicate", workflow: "X" }, true)).toBe("A required status check on this branch.");
  });
  test("an ETA is said the way a person says it", () => {
    expect(fmtEta(30 * S)).toBe("under a minute");
    expect(fmtEta(4 * M)).toBe("about 4 min");
  });
});

describe("review history is offered whatever the headline", () => {
  // Two people reviewed, one approved and one asked for changes and was asked
  // again; the headline is the open threads, not the changes row.
  const input = base({
    reviewDecision: "CHANGES_REQUESTED",
    humanReview: { kind: "changes", who: ["carol"], askedAgain: true, cleared: true, at: ago(29 * H) },
    reviews: [review("alice", "APPROVED", ago(3 * H)), review("carol", "CHANGES_REQUESTED", ago(29 * H))],
    reviewers: [{ login: "carol" }], askedAt: { carol: ago(3 * H) },
    openThreads: 2,
  });
  const p = mergePath(input);
  test("the headline is the threads and the history button is still there", () => {
    expect(say(p)).toContain("2 review threads still open");
    expect(p.hero.secondary).toEqual({ id: "history", label: "Review history (2)" });
  });
  test("an approval alone is a review too", () => {
    const q = mergePath(base({ reviewDecision: "REVIEW_REQUIRED", openThreads: 1 }));
    expect(q.historyCount).toBe(1);
    expect(q.hero.secondary?.id).toBe("history");
  });
  test("no reviews, no history", () => {
    const q = mergePath({ ...input, reviews: [], humanReview: undefined, reviewDecision: "REVIEW_REQUIRED" });
    expect(q.historyCount).toBe(0);
    expect(q.hero.secondary?.id).not.toBe("history");
    expect(q.hero.also).toBeUndefined();
  });
  test("a busy secondary slot keeps its action and history moves beside it", () => {
    const q = mergePath({ ...input, openThreads: 0, checksAll: [req("build", "failure", { url: "https://example.test/run/1" })] });
    expect(q.hero.secondary?.id).toBe("rerun");
    expect(q.hero.also).toEqual({ id: "history", label: "Review history (2)" });
  });
  test("re-requested: the row says when and on whom", () => {
    const row = p.rows.find((r) => r.kind === "changes")!;
    expect(row.sub).toBe("re-requested 3h ago · waiting on carol");
  });
});

describe("what the review side already decided is said", () => {
  // alice approved 25 minutes ago; carol asked for changes and was asked again.
  const input = base({
    reviewDecision: "CHANGES_REQUESTED",
    humanReview: { kind: "changes", who: ["carol"], askedAgain: true, cleared: true, at: ago(29 * H) },
    reviews: [
      review("alice", "APPROVED", ago(25 * M)), review("carol", "CHANGES_REQUESTED", ago(29 * H)),
      { ...review("ci-bot", "APPROVED", ago(20 * M)), isBot: true },
    ],
    reviewers: [{ login: "carol" }], openThreads: 0,
  });
  const p = mergePath(input);
  test("a quiet DONE row per current human approval, after the blockers, no bots", () => {
    const done = p.rows.filter((r) => r.kind === "approved");
    expect(done.map((r) => [r.title, r.mover, r.moverLabel, r.counted])).toEqual([["Approved by alice · 25m ago", "done", "DONE", false]]);
    expect(p.rows[p.rows.length - 1].kind).toBe("approved");
    expect(p.count).toBe(rowKinds(p).length);
  });
  test("the Review cell says how far it got and who it waits on", () => {
    expect(stage(p, "review").sub).toBe("1 of 2 approved · waiting on carol");
  });
  test("an approval that was asked again, or overtaken by changes, is not current", () => {
    const q = mergePath({ ...input, reviewers: [{ login: "carol" }, { login: "alice" }] });
    expect(q.rows.some((r) => r.kind === "approved")).toBe(false);
    const r = mergePath({ ...input, reviews: [review("alice", "APPROVED", ago(2 * H)), review("alice", "CHANGES_REQUESTED", ago(1 * H))] });
    expect(r.rows.some((x) => x.kind === "approved")).toBe(false);
  });
});
