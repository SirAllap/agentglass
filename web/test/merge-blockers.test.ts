// Every reason a pull request will not merge, ranked — one test per reason.
//
// The first fixture is the shape that started it: a base branch locked for a
// deploy, three failing checks of which only one is required, approvals in
// place. The old sentence named the first two failing checks and folded the
// required one into "+1 more", and said nothing about the lock.
import { describe, expect, test } from "bun:test";
import {
  mergeBlockers, mergeRefusal, autoMergeRefusal, staleApproval, checkNames,
  type BlockerInput,
} from "../../shared/mergeBlockers.ts";
import type { PrCheck, PrMergeGate } from "../../shared/types.ts";

const check = (name: string, state: PrCheck["state"], required = false, done = state !== "pending"): PrCheck =>
  ({ name, workflow: "CI", state, done, required });

// An admin's view by default: everything readable, nothing set.
const gate = (over: Partial<PrMergeGate> = {}): PrMergeGate => ({
  permission: "ADMIN", canBypass: false, protectionVisible: true, locked: false,
  viewerCanPush: true, approvals: 1, codeOwners: false, lastPushApproval: false,
  dismissStale: false, conversationResolution: false, upToDate: false, signatures: false,
  deployments: [], requiredContexts: [], mergeQueue: false, inQueue: false, ...over,
});
// A writer's: classic protection unreadable, so what lives only there is null.
const writer = (over: Partial<PrMergeGate> = {}) =>
  gate({ permission: "WRITE", protectionVisible: false, locked: null, dismissStale: null, upToDate: null, ...over });

const input = (over: Partial<BlockerInput> = {}): BlockerInput => ({
  state: "OPEN", mergeState: "BLOCKED", mergeable: "MERGEABLE", reviewDecision: "APPROVED",
  baseRefName: "main", checksAll: [check("build", "success", true)], gate: gate(), openThreads: 0, ...over,
});

const kinds = (i: BlockerInput) => mergeBlockers(i).map((b) => b.kind);
const redThree = [check("e2e", "failure"), check("bench", "failure"), check("gate", "failure", true)];

describe("a locked base with one required check red", () => {
  const locked = input({ gate: writer({ locked: true, lockedBy: "release freeze" }), checksAll: redThree });

  test("the lock comes first, then the required check by name, then the rest as not required", () => {
    const list = mergeBlockers(locked);
    expect(list.map((b) => b.kind)).toEqual(["locked", "required-failing", "optional-failing"]);
    expect(list[0]!.title).toBe("main is locked");
    expect(list[0]!.detail).toContain("release freeze");
    expect(list[1]!.title).toBe("gate failing — required");
    expect(list[2]!.title).toBe("e2e, bench failing — not required");
    expect(list[2]!.weight).toBe("warns");
  });

  test("and neither the merge button nor 'Merge when green' is offered over the lock", () => {
    const list = mergeBlockers(locked);
    // Even where GitHub's own state would read as mergeable.
    expect(mergeRefusal(list, "CLEAN")?.kind).toBe("locked");
    expect(autoMergeRefusal(list)).toContain("going green would not merge it");
  });

  test("somebody GitHub lets past the lock is told, not refused", () => {
    const list = mergeBlockers(input({ mergeState: "CLEAN", gate: gate({ locked: true, canBypass: true }) }));
    expect(list.map((b) => [b.kind, b.weight])).toEqual([["locked", "warns"]]);
    expect(mergeRefusal(list, "CLEAN")).toBeNull();
  });
});

test("to a writer, the same pull request shows the required check and says the list may be one short", () => {
  // What a writer actually gets: the lock invisible (null), the check not.
  const list = mergeBlockers(input({ gate: writer(), checksAll: redThree }));
  expect(list.map((b) => b.kind)).toEqual(["required-failing", "unseen", "optional-failing"]);
  expect(list[1]!.detail).toContain("locked branch");
});

test("nothing is called unseen where it could not be, or where a person still owes the next step", () => {
  expect(kinds(input({ checksAll: [check("s", "failure", true)] }))).not.toContain("unseen");
  expect(kinds(input({ gate: writer(), mergeState: "UNSTABLE", checksAll: [check("s", "failure")] }))).not.toContain("unseen");
  expect(kinds(input({ gate: writer(), reviewDecision: "REVIEW_REQUIRED" }))).not.toContain("unseen");
});

describe("each reason", () => {
  test("nothing on a closed or merged pull request", () => {
    expect(mergeBlockers(input({ state: "MERGED" }))).toEqual([]);
  });

  test("a draft", () => {
    expect(kinds(input({ isDraft: true, mergeState: "DRAFT" }))[0]).toBe("draft");
  });

  test("a role without merge rights, even where GitHub's state reads clean", () => {
    for (const permission of ["READ", "TRIAGE"]) {
      const list = mergeBlockers(input({ mergeState: "CLEAN", gate: gate({ permission, viewerCanPush: false }) }));
      expect(list.map((b) => b.kind)).toEqual(["no-permission"]);
      expect(mergeRefusal(list, "CLEAN")).not.toBeNull();
    }
  });

  test("a writer whom a push restriction leaves off the list", () => {
    expect(kinds(input({ mergeState: "CLEAN", gate: gate({ viewerCanPush: false }) }))).toEqual(["restricted"]);
  });

  test("a merge queue is a note, not a refusal, and says nothing once it is queued", () => {
    const list = mergeBlockers(input({ mergeState: "CLEAN", gate: gate({ mergeQueue: true }) }));
    expect(list.map((b) => [b.kind, b.weight])).toEqual([["merge-queue", "warns"]]);
    expect(mergeRefusal(list, "CLEAN")).toBeNull();
    expect(autoMergeRefusal(list)).toBeNull();
    expect(kinds(input({ mergeState: "CLEAN", gate: gate({ mergeQueue: true, inQueue: true }) }))).toEqual([]);
  });

  test("conflicts, from GitHub or from the caller's fresher git answer", () => {
    expect(kinds(input({ mergeState: "DIRTY", mergeable: "CONFLICTING" }))).toContain("conflicts");
    expect(kinds(input({ mergeState: "DIRTY", mergeable: "CONFLICTING", conflicted: false }))).not.toContain("conflicts");
    expect(kinds(input({ mergeState: "UNKNOWN", mergeable: "UNKNOWN", conflicted: true }))).toContain("conflicts");
  });

  test("required checks failing, named, required ones first", () => {
    const list = mergeBlockers(input({ checksAll: [check("a", "failure", true), check("b", "failure", true), check("c", "failure", true)] }));
    expect(list[0]!.title).toBe("a, b +1 more failing — required");
    expect(list[0]!.checks).toHaveLength(3);
  });

  test("a required check that never reported blocks — and is a wait right after a push", () => {
    const g = writer({ requiredContexts: ["build", "e2e"] });
    const never = mergeBlockers(input({ gate: g }));
    expect(never.map((b) => b.kind)).toEqual(["required-missing", "unseen"]);
    expect(never[0]!.title).toBe("e2e never reported — required");
    expect(never[0]!.detail).toContain("path filter");
    const soon = mergeBlockers(input({ gate: g, awaitingChecks: true }));
    expect(soon.map((b) => [b.kind, b.weight])).toEqual([["required-missing", "waits"]]);
    expect(autoMergeRefusal(soon)).toBeNull();
    // Nor "never" while something it may depend on is still running.
    const later = mergeBlockers(input({ gate: g, checksAll: [check("build", "pending", true)] }));
    expect(later.find((b) => b.kind === "required-missing")).toMatchObject({ weight: "waits", title: "e2e not started yet — required" });
  });

  test("without a gate nobody knows which are required, and it says so instead of guessing", () => {
    const list = mergeBlockers(input({ gate: undefined, checksAll: [check("a", "failure"), check("b", "failure")] }));
    expect(list[0]!.title).toBe("a, b failing");
    expect(list[0]!.detail).toContain("did not say which");
    // UNSTABLE is GitHub's own word for "failing, and not required".
    expect(kinds(input({ gate: undefined, mergeState: "UNSTABLE", checksAll: [check("a", "failure")] }))).toEqual(["optional-failing"]);
  });

  test("changes requested", () => {
    expect(kinds(input({ reviewDecision: "CHANGES_REQUESTED" }))).toEqual(["changes-requested"]);
  });

  test("approvals owed, with the count and every condition the branch sets", () => {
    const b = mergeBlockers(input({ reviewDecision: "REVIEW_REQUIRED", gate: gate({ approvals: 2, codeOwners: true, lastPushApproval: true }) }))[0]!;
    expect(b.kind).toBe("review-required");
    expect(b.title).toBe("Needs 2 approving reviews");
    expect(b.detail).toContain("code owner");
    expect(b.detail).toContain("after the latest push");
  });

  test("unresolved conversations only where the branch requires them resolved", () => {
    expect(kinds(input({ openThreads: 3 }))).not.toContain("threads");
    const b = mergeBlockers(input({ openThreads: 3, gate: gate({ conversationResolution: true }) }))[0]!;
    expect(b.kind).toBe("threads");
    expect(b.title).toBe("3 conversations unresolved");
  });

  test("behind, which the panel may still merge past with a confirmation", () => {
    const strict = mergeBlockers(input({ mergeState: "BEHIND", gate: gate({ upToDate: true }) }));
    expect(strict.map((b) => [b.kind, b.weight])).toEqual([["behind", "blocks"]]);
    expect(mergeRefusal(strict, "BEHIND")).toBeNull();
    // Auto-merge never updates a branch, so it would wait forever.
    expect(autoMergeRefusal(strict)).not.toBeNull();
    const loose = mergeBlockers(input({ mergeState: "BEHIND", gate: writer() }));
    expect(loose[0]!.weight).toBe("warns");
    expect(loose[0]!.detail).toContain("may need updating");
  });

  test("behind without a gate keeps 'merge anyway', failing checks or not", () => {
    const list = mergeBlockers(input({ gate: undefined, mergeState: "BEHIND", checksAll: [check("a", "failure")] }));
    expect(mergeRefusal(list, "BEHIND")).toBeNull();
  });

  test("GitHub still computing", () => {
    const b = mergeBlockers(input({ mergeState: "UNKNOWN", mergeable: "UNKNOWN" }))[0]!;
    expect(b.kind).toBe("computing");
    expect(b.weight).toBe("waits");
  });

  test("right after a push, nothing reported yet is a wait — never 'blocked without saying why'", () => {
    const list = mergeBlockers(input({ gate: writer(), checksAll: [], awaitingChecks: true }));
    expect(list.map((b) => b.kind)).toEqual(["awaiting"]);
    expect(autoMergeRefusal(list)).toBeNull();
  });

  test("required checks still running are a wait, and named as required", () => {
    const list = mergeBlockers(input({ checksAll: [check("gate", "pending", true), check("lint", "pending")] }));
    // It explains BLOCKED on its own, so no "without saying why" beside it.
    expect(list.map((b) => b.kind)).toEqual(["required-pending"]);
    expect(list[0]!.title).toBe("gate still running — required");
    expect(autoMergeRefusal(list)).toBeNull();
  });

  test("optional checks still running say none of them is required", () => {
    const b = mergeBlockers(input({ mergeState: "UNSTABLE", checksAll: [check("lint", "pending")] }))[0]!;
    expect(b.kind).toBe("pending");
    expect(b.detail).toBe("None of them is required.");
  });

  test("blocked with nothing to show for it is a reason of its own, naming what cannot be seen", () => {
    const list = mergeBlockers(input({ gate: writer() }));
    expect(list.map((b) => b.kind)).toEqual(["unexplained"]);
    expect(list[0]!.detail).toContain("a locked branch");
    expect(autoMergeRefusal(list)).toContain("not the checks");
  });

  test("an admin who can merge past it is told so, and not sent looking for a lock", () => {
    const b = mergeBlockers(input({ gate: gate({ canBypass: true, signatures: true }) }))[0]!;
    expect(b.kind).toBe("unexplained");
    expect(b.detail).toContain("unsigned commit");
    expect(b.detail).not.toContain("locked branch");
    expect(b.detail).toContain("as an admin");
  });

  test("repository hooks are a note, not a block", () => {
    const list = mergeBlockers(input({ mergeState: "HAS_HOOKS" }));
    expect(list.map((b) => [b.kind, b.weight])).toEqual([["hooks", "warns"]]);
  });

  test("a clean pull request has nothing to say", () => {
    expect(mergeBlockers(input({ mergeState: "CLEAN" }))).toEqual([]);
  });
});

describe("the merge button follows GitHub where GitHub can see", () => {
  test("a check wrongly marked required does not take a button GitHub offers", () => {
    // UNSTABLE: GitHub will merge. Only what its state cannot see refuses.
    const list = mergeBlockers(input({ mergeState: "UNSTABLE", checksAll: [check("gate", "failure", true)] }));
    expect(mergeRefusal(list, "UNSTABLE")).toBeNull();
  });

  test("where GitHub has refused, the refusal names the first reason", () => {
    const list = mergeBlockers(input({ reviewDecision: "REVIEW_REQUIRED" }));
    expect(mergeRefusal(list, "BLOCKED")?.kind).toBe("review-required");
  });
});

describe("'Merge when green' stays offered for what going green does clear", () => {
  test("failing and running checks, owed reviews", () => {
    const list = mergeBlockers(input({ reviewDecision: "REVIEW_REQUIRED", checksAll: [check("gate", "failure", true)] }));
    expect(autoMergeRefusal(list)).toBeNull();
  });

  test("but not a conflict or a draft", () => {
    expect(autoMergeRefusal(mergeBlockers(input({ mergeState: "DIRTY", mergeable: "CONFLICTING" })))).not.toBeNull();
    expect(autoMergeRefusal(mergeBlockers(input({ isDraft: true, mergeState: "DRAFT" })))).not.toBeNull();
  });
});

describe("an approval commits have landed after", () => {
  test("still counts on GitHub's word, and says why only where the rule is known", () => {
    const known = staleApproval("APPROVED", "Approved by ada", { lastPushApproval: false, dismissStale: false });
    expect(known.counts).toBe(true);
    expect(known.head).toBe("Approved by ada — still counts");
    expect(known.head).not.toContain("moved since");
    expect(known.note).toContain("keeps approvals across pushes");
    // A writer cannot read the dismissal rule, so the reason is not claimed.
    const unknown = staleApproval("APPROVED", "Approved", { lastPushApproval: false, dismissStale: null });
    expect(unknown.counts).toBe(true);
    expect(unknown.note).not.toContain("keeps approvals");
  });

  test("short of what GitHub requires is not 'still counts'", () => {
    const s = staleApproval("REVIEW_REQUIRED", "Approved", { lastPushApproval: false, dismissStale: false });
    expect(s.counts).toBeNull();
    expect(s.head).toBe("Approved, but it has moved since");
  });

  test("a last-push rule: older approvals still count toward the number, the latest push needs its own", () => {
    const s = staleApproval("APPROVED", "Approved", { lastPushApproval: true, dismissStale: false });
    expect(s.counts).toBe(true);
    expect(s.head).toBe("Approved, but not the latest push");
    expect(staleApproval("REVIEW_REQUIRED", "Approved", { lastPushApproval: true, dismissStale: false }).counts).toBe(false);
  });

  test("with no review rule, only what is known", () => {
    expect(staleApproval(null).head).toBe("Approved, but it has moved since");
    expect(staleApproval(null).counts).toBeNull();
  });
});

test("check names put the required ones first", () => {
  expect(checkNames([check("a", "failure"), check("b", "failure"), check("z", "failure", true)])).toBe("z, a +1 more");
});
