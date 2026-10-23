// Re-requesting a review drew the sidebar's amber dot at once and left the merge
// box saying "still wants changes ... then re-request review", because the two
// read different fields: the dot came from the outstanding-request list, the box
// and the sidebar header from the server's `humanReview` verdict, which the
// optimistic patch never touched. One datum, two views: the patch has to move
// both. Fixture: alice asked for changes on a pull request bob wrote.
import { describe, expect, test } from "bun:test";
import { mergePath, type MergePathInput } from "../../shared/mergePath.ts";
import { reviewersPatch } from "../src/lib/prOptimistic.ts";
import type { PrDetail, PrMergeGate, PrReview } from "../../shared/types.ts";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const gate: PrMergeGate = {
  permission: "WRITE", canBypass: false, protectionVisible: true, locked: false,
  viewerCanPush: true, approvals: 1, codeOwners: false, lastPushApproval: false,
  dismissStale: false, conversationResolution: false, upToDate: false, signatures: false,
  deployments: [], requiredContexts: [], mergeQueue: false, inQueue: false,
};
const review: PrReview = {
  author: "alice", isBot: false, state: "CHANGES_REQUESTED", body: "",
  submittedAt: new Date(NOW - 3_600_000).toISOString(), nodeId: "r-alice", url: "https://example.test/r/alice",
};
const detail = (over: Partial<PrDetail> = {}) => ({
  number: 7, author: "bob", reviews: [review], reviewers: [],
  humanReview: { kind: "changes", who: ["alice"], askedAgain: false },
  ...over,
}) as unknown as PrDetail;

const box = (d: PrDetail) => mergePath({
  state: "OPEN", mergeState: "BLOCKED", mergeable: "MERGEABLE", reviewDecision: "CHANGES_REQUESTED",
  humanReview: d.humanReview, reviews: d.reviews, reviewers: d.reviewers, author: d.author,
  viewerDidAuthor: true, checksAll: [], gate, baseRefName: "main", openThreads: 0, now: NOW,
} as MergePathInput);
const says = (d: PrDetail) => box(d).hero.parts.map((p) => p.text).join("");

describe("re-requesting the reviewer who asked for changes", () => {
  const before = detail();
  const after = reviewersPatch(7, ["alice"], [])(before);

  test("the merge box stops saying the reviewer still wants changes", () => {
    expect(says(before)).toContain("still wants changes");
    expect(says(after)).not.toContain("still wants changes");
  });

  test("the verdict the sidebar header reads is asked-again and cleared", () => {
    expect(after.humanReview).toMatchObject({ kind: "changes", askedAgain: true, cleared: true });
  });

  test("one of two changes-requesters re-asked is asked again but not cleared", () => {
    const two = detail({ humanReview: { kind: "changes", who: ["alice", "carol"], askedAgain: false } });
    expect(reviewersPatch(7, ["alice"], [])(two).humanReview).toMatchObject({ askedAgain: true });
    expect(reviewersPatch(7, ["alice"], [])(two).humanReview?.cleared).toBeFalsy();
  });

  test("removing the request puts the box back", () => {
    const asked = detail({ reviewers: [{ login: "alice" }], humanReview: { kind: "changes", who: ["alice"], askedAgain: true, cleared: true } });
    const gone = reviewersPatch(7, [], ["alice"])(asked);
    expect(gone.humanReview?.askedAgain).toBe(false);
    expect(gone.humanReview?.cleared).toBeFalsy();
    expect(says(gone)).toContain("still wants changes");
  });

  test("the sidebar's ↻ goes through the layer, not straight to the endpoint", async () => {
    const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
    expect(src).not.toContain("onAsk={(login) => api.prReviewers(");
  });

  test("`people` is dropped rather than left showing the old ring on the face just asked", () => {
    const withPeople = detail({ humanReview: { kind: "changes", who: ["alice"], askedAgain: false, people: [{ login: "alice", state: "changes" }, { login: "dave", state: "await" }] } });
    expect(reviewersPatch(7, ["alice"], [])(withPeople).humanReview?.people).toBeUndefined();
    const waiting = detail({ humanReview: { kind: "awaiting", who: ["dave"], people: [{ login: "dave", state: "await" }] } });
    expect(reviewersPatch(7, [], ["dave"])(waiting).humanReview?.people).toBeUndefined();
    expect(reviewersPatch(7, [], ["dave"])(waiting).humanReview?.kind).toBe("awaiting");
  });
});

// One reviewer answered after the last request event, the other was asked again
// after theirs. The outstanding-request list names both; only the second is waited on.
describe("two reviewers, only one of them asked again", () => {
  const H = 3_600_000, D = 24 * H;
  const at = (ms: number) => new Date(NOW - ms).toISOString();
  const mk = (author: string, ms: number): PrReview => ({ ...review, author, submittedAt: at(ms), nodeId: `r-${author}` });
  const d = detail({
    reviews: [mk("reviewer-a", 20 * H), mk("reviewer-b", 16 * D)],
    reviewers: [{ login: "reviewer-a" }, { login: "reviewer-b" }],
    humanReview: { kind: "changes", who: ["reviewer-a", "reviewer-b"], askedAgain: true, cleared: true },
  } as Partial<PrDetail>);
  const asked = { "reviewer-a": at(5 * D), "reviewer-b": at(7 * D) };
  const path = mergePath({
    state: "OPEN", mergeState: "BLOCKED", mergeable: "MERGEABLE", reviewDecision: "CHANGES_REQUESTED",
    humanReview: d.humanReview, reviews: d.reviews, reviewers: d.reviewers, askedAt: asked, author: d.author,
    viewerDidAuthor: true, checksAll: [], gate, baseRefName: "main", openThreads: 0, now: NOW,
  } as MergePathInput);

  test("the headline answers the first and waits on the second", () => {
    const says = path.hero.parts.map((p) => p.text).join("");
    expect(says).toContain("reviewer-a still wants changes");
    expect(says).toContain("reviewer-b's re-review is pending");
    expect(says).not.toContain("was asked");
  });
});
