import { test, expect } from "bun:test";
import { reviewPromptText } from "../src/prs.ts";

const base = { number: 123, repo: "owner/repo", head: "abc123" };

test("your PR with changes requested → address prompt (checkout, not read-only)", () => {
  const p = reviewPromptText({ ...base, viewerDidAuthor: true, reviewDecision: "CHANGES_REQUESTED", viewerRequested: false });
  expect(p).toContain("gh pr checkout 123");
  expect(p).toContain("address them");
  expect(p).not.toContain("Read-only");
  expect(p).not.toContain("What is this pull request about");
  expect(p).toContain("abc123"); // pinned at head
});

test("your PR, review approved → read-only understand, not address", () => {
  const p = reviewPromptText({ ...base, viewerDidAuthor: true, reviewDecision: "APPROVED", viewerRequested: false });
  expect(p).toContain("Read-only");
  expect(p).toContain("What is this pull request about");
  expect(p).not.toContain("gh pr checkout");
  // The read-only prompt keeps its deliberate blank-line separators — a bare
  // join, not a `.filter(l => l !== "")` that would drop them and render the
  // whole thing cramped. Assert one such separator between two known lines.
  expect(p).toContain("Pull request #123 of owner/repo.\n\nRead-only:");
});

test("someone else's PR, your review requested → read-only + review the diff", () => {
  const p = reviewPromptText({ ...base, viewerDidAuthor: false, reviewDecision: "REVIEW_REQUIRED", viewerRequested: true });
  expect(p).toContain("Read-only");
  expect(p).toContain("My review has been requested");
  expect(p).not.toContain("gh pr checkout");
  expect(p).toContain("abc123"); // this branch pins the review at the head sha
});

test("plain PR, nothing asked of you → read-only understand only", () => {
  const p = reviewPromptText({ ...base, viewerDidAuthor: false, reviewDecision: null, viewerRequested: false });
  expect(p).toContain("What is this pull request about");
  expect(p).not.toContain("My review has been requested");
  expect(p).not.toContain("gh pr checkout");
});

test("your PR + changes requested wins over a stray review request (you don't review your own PR)", () => {
  const p = reviewPromptText({ ...base, viewerDidAuthor: true, reviewDecision: "CHANGES_REQUESTED", viewerRequested: true });
  expect(p).toContain("gh pr checkout 123");
  expect(p).not.toContain("My review has been requested");
});
