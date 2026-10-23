// Branch moves live in the footer row whatever the headline is. The same
// "Resolve conflicts" button used to sit under the headline when the conflict
// was the headline and in the footer when it was a secondary blocker.
import { describe, expect, test } from "bun:test";
import { mergePath, heroPlacement, actionInFooter, type MergePathInput, type ActionId } from "../../shared/mergePath.ts";
import type { PrCheck, PrMergeGate } from "../../shared/types.ts";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const check = (name: string, state: PrCheck["state"]): PrCheck =>
  ({ name, workflow: "CI", state, done: state !== "pending", required: true });
const gate: PrMergeGate = {
  permission: "WRITE", canBypass: false, protectionVisible: true, locked: false,
  viewerCanPush: true, approvals: 1, codeOwners: false, lastPushApproval: false,
  dismissStale: false, conversationResolution: false, upToDate: false, signatures: false,
  deployments: [], requiredContexts: [], mergeQueue: false, inQueue: false,
};
const base = (over: Partial<MergePathInput> = {}): MergePathInput => ({
  state: "OPEN", mergeState: "CLEAN", mergeable: "MERGEABLE", reviewDecision: "APPROVED",
  humanReview: { kind: "approved", who: ["alice"] }, reviews: [], author: "bob", viewerDidAuthor: true,
  checksAll: [check("build", "success")], gate, baseRefName: "main", openThreads: 0, now: NOW, ...over,
});
const ids = (as: { id: ActionId }[]) => as.map((a) => a.id);
const place = (over: Partial<MergePathInput>) => heroPlacement(mergePath(base(over)).hero);

describe("which hero buttons go under the headline", () => {
  test("conflict as the headline: Resolve conflicts is the footer's, nothing on top", () => {
    const p = place({ mergeState: "DIRTY", mergeable: "CONFLICTING", conflicted: true });
    expect(ids(p.footer)).toContain("resolve-conflicts");
    expect(ids(p.top)).not.toContain("resolve-conflicts");
  });
  test("behind base: no branch move under the headline", () => {
    const p = place({ mergeState: "BEHIND", behind: 81 });
    expect(p.top.filter((a) => actionInFooter(a.id))).toEqual([]);
  });
  test("ready to merge: nothing on top", () => {
    expect(place({}).top).toEqual([]);
  });
  test("checks failing: the CI buttons stay on top", () => {
    const p = place({ mergeState: "UNSTABLE", checksAll: [check("build", "failure")] });
    expect(ids(p.top)).toContain("rerun");
    expect(p.footer).toEqual([]);
  });
  test("review missing: ask-review stays on top", () => {
    const p = place({ reviewDecision: "REVIEW_REQUIRED", humanReview: { kind: "none", who: [] } as never, mergeState: "BLOCKED" });
    expect(p.footer).toEqual([]);
  });
  test("draft: Mark ready is the footer's", () => {
    const p = place({ mergeState: "DRAFT", isDraft: true });
    expect(ids(p.footer)).toEqual(["mark-ready"]);
    expect(p.top).toEqual([]);
  });
  test("conflict as a secondary blocker: still no branch move on top", () => {
    const p = place({ mergeState: "DIRTY", mergeable: "CONFLICTING", conflicted: true, checksAll: [check("build", "failure")] });
    expect(p.top.filter((a) => actionInFooter(a.id))).toEqual([]);
  });
});

describe("the rule by id", () => {
  test.each(["merge", "resolve-conflicts", "update-branch", "arm-auto", "mark-ready"] as ActionId[])("%s is the footer's", (id) => {
    expect(actionInFooter(id)).toBe(true);
  });
  test.each(["open-log", "rerun", "history", "open-github", "go-thread", "go-review", "ask-review"] as ActionId[])("%s stays on top", (id) => {
    expect(actionInFooter(id)).toBe(false);
  });
});
