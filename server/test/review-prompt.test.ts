import { test, expect } from "bun:test";
import { reviewPromptText } from "../src/prs.ts";

/*
 * The opener a pull request gets when nobody named a prompt.
 *
 * This used to be the whole feature — two shapes, chosen by two fields. It is
 * the DEFAULT now: the button offers a dozen prompts and this is which one sits
 * at the top of the menu with nothing else said. Worth its own suite for the
 * same reason as before: the wording is a contract with the agent, and it is
 * assertable without a `gh` round trip.
 *
 * The cases below are the six branches of `suggestRecipeId`, in the order it
 * asks them.
 */
const base = { number: 123, repo: "owner/repo", head: "abc123" };

test("your PR with changes requested → address prompt (checkout, not read-only)", () => {
  const p = reviewPromptText({ ...base, viewerDidAuthor: true, reviewDecision: "CHANGES_REQUESTED", viewerRequested: false });
  expect(p).toContain("gh pr checkout 123");
  expect(p).toContain("address them");
  expect(p).not.toContain("Read-only");
  expect(p).toContain("abc123"); // pinned at head
});

test("your PR + changes requested wins over a stray review request (you don't review your own PR)", () => {
  const p = reviewPromptText({ ...base, viewerDidAuthor: true, reviewDecision: "CHANGES_REQUESTED", viewerRequested: true });
  expect(p).toContain("gh pr checkout 123");
  expect(p).not.toContain("Review it. In this order");
});

test("your PR nobody has read yet → review it yourself, before asking", () => {
  const p = reviewPromptText({ ...base, viewerDidAuthor: true, reviewDecision: null, viewerRequested: false });
  expect(p).toContain("nobody has reviewed it yet");
  expect(p).toContain("Read-only");
  expect(p).not.toContain("gh pr checkout");
});

test("someone else's PR, your review requested → review it, with a verdict", () => {
  const p = reviewPromptText({ ...base, viewerDidAuthor: false, reviewDecision: "REVIEW_REQUIRED", viewerRequested: true });
  expect(p).toContain("Read-only");
  expect(p).toContain("My review is the one it is waiting on");
  expect(p).toContain("fine to approve");
  expect(p).not.toContain("gh pr checkout");
  expect(p).toContain("abc123"); // pinned at the head sha
});

/*
 * The case the whole catalogue was written for: reviewed once, changed, handed
 * back — and NOT re-requested, so `viewerRequested` is false and the old rule
 * would have offered "what is this pull request about" for the third time.
 */
test("a PR you have reviewed, moved since → the delta, and whether you were answered", () => {
  const p = reviewPromptText({ ...base, viewerDidAuthor: false, reviewDecision: null, viewerRequested: false, since: "9f8e7d6" });
  expect(p).toContain("what came after 9f8e7d6");
  expect(p).toContain("compare/9f8e7d6...abc123");
  expect(p).toContain("was it done, done differently, argued with, or ignored");
  // The point of the prompt is not to hear the same findings again.
  expect(p).toContain("Do not repeat findings");
});

test("a review of yours written against the CURRENT head is not 'it moved'", () => {
  const p = reviewPromptText({ ...base, viewerDidAuthor: false, reviewDecision: null, viewerRequested: false, since: "abc123" });
  expect(p).toContain("What is this pull request about");
  expect(p).not.toContain("what came after");
});

test("plain PR, nothing asked of you → read-only understand only", () => {
  const p = reviewPromptText({ ...base, viewerDidAuthor: false, reviewDecision: null, viewerRequested: false });
  expect(p).toContain("What is this pull request about");
  expect(p).not.toContain("gh pr checkout");
  // The read-only prompt keeps its deliberate blank-line separators — a bare
  // join, not a `.filter(l => l !== "")` that would drop them and render the
  // whole thing cramped. Assert one such separator between two known lines.
  expect(p).toContain("Pull request #123 of owner/repo.\n\nRead-only:");
});

test("no prompt leaves a placeholder behind", () => {
  for (const situation of [
    { viewerDidAuthor: true, reviewDecision: "CHANGES_REQUESTED", viewerRequested: false },
    { viewerDidAuthor: true, reviewDecision: null, viewerRequested: false },
    { viewerDidAuthor: false, reviewDecision: null, viewerRequested: true },
    { viewerDidAuthor: false, reviewDecision: null, viewerRequested: false, since: "9f8e7d6" },
    { viewerDidAuthor: false, reviewDecision: null, viewerRequested: false },
  ]) {
    const p = reviewPromptText({ ...base, branch: "fix/thing", title: "A thing", author: "someone", url: "https://x/y", card: "ORBIT-1042", ...situation });
    expect(p, JSON.stringify(situation)).not.toMatch(/\{(number|repo|head|branch|title|author|url|since|card)\}/);
  }
});
