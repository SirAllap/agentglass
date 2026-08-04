// What a checkout costs, said before it happens.
//
// Written after it went wrong twice in one morning on a shared repository: a
// branch picked from a list that is mostly used for navigation turned out to
// MOVE that branch into whatever directory the console was standing in, evicting
// the ticket branch that lived there three minutes after a commit landed on it.
//
// These pin the three sentences, because each one was a thing the person at the
// keyboard did not know at the moment of clicking.
import { test, expect } from "bun:test";
import { checkoutTitle, checkoutBody, checkoutConfirm, needsCheckoutConfirm } from "../src/lib/checkoutWarning.ts";

const t = { branch: "master", dir: "orbit-WEB-1042", displacing: "WEB-1042-quota-banner", dirty: 9 };

test("the title alone says which branch and WHICH FOLDER", () => {
  // "here" is not an answer in a repo with twenty worktrees.
  expect(checkoutTitle(t)).toBe("Check out master in orbit-WEB-1042?");
});

test("it names what is being evicted", () => {
  expect(checkoutBody(t)).toContain("WEB-1042-quota-banner");
  expect(checkoutBody(t)).toContain("swapped out");
});

test("it warns that uncommitted work comes along", () => {
  // The one that surprises people whose model of git is CORRECT: changes live
  // in the directory, so they follow you onto a branch they have nothing to do
  // with.
  const b = checkoutBody(t);
  expect(b).toContain("9 uncommitted changes");
  expect(b).toContain("belong to the directory, not to the branch");
});

test("and that the branch is pinned here, gone from everywhere else", () => {
  // The fact that made the aftermath incomprehensible: the branch stopped being
  // available in any other checkout, and the labels flipped.
  expect(checkoutBody(t)).toContain("one folder at a time");
});

test("a clean folder is not told about changes it does not have", () => {
  const b = checkoutBody({ ...t, dirty: 0 });
  expect(b).not.toContain("uncommitted");
  expect(b).toContain("swapped out");
});

test("one uncommitted change is singular", () => {
  expect(checkoutBody({ ...t, dirty: 1 })).toContain("1 uncommitted change ");
});

test("nothing is evicted when the folder holds nothing else", () => {
  const b = checkoutBody({ branch: "master", dir: "orbit", displacing: null });
  expect(b).not.toContain("swapped out");
  expect(b).toContain("one folder at a time");
});

test("checking a branch out where it already is asks nothing", () => {
  // A confirmation for a no-op is how confirmations stop being read.
  expect(needsCheckoutConfirm({ branch: "master", dir: "orbit", displacing: "master" })).toBe(false);
  expect(needsCheckoutConfirm(t)).toBe(true);
});

test("the confirm button repeats the destination rather than saying OK", () => {
  expect(checkoutConfirm(t).confirmLabel).toBe("Check out in orbit-WEB-1042");
  // Not danger: nothing is destroyed. It is a move, and a move earns a sentence.
  expect((checkoutConfirm(t) as { danger?: boolean }).danger).toBeUndefined();
});
