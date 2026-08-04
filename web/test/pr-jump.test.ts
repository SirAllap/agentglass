// "Open this pull request", asked from a surface that cannot reach the panel.
//
// The notification list lives in the top bar and can be open over any view; the
// PR panel may not be mounted at all when a row is clicked. So the request is
// left in a slot, exactly as termIssue.ts does for the terminal. The rules worth
// pinning are the two that bite: a repeat must not look like the request already
// served, and the repo must travel with the number.
import { test, expect, beforeEach } from "bun:test";
import { requestPrJump, prJump, clearPrJump, subscribePrJump } from "../src/lib/prJump.ts";

beforeEach(() => clearPrJump());

test("nothing is pending until something asks", () => {
  expect(prJump()).toBe(null);
});

test("the repo travels with the number", () => {
  // A number alone is not an identity: #16175 names a different pull request in
  // every repository, and the panel is pointed at one repo at a time.
  requestPrJump("acme/orbit", 16175);
  expect(prJump()).toMatchObject({ repo: "acme/orbit", number: 16175 });
});

test("asking twice for the same PR is two requests", () => {
  // Without the counter, closing a PR and clicking the same notification again
  // would look like the request that has already been served.
  requestPrJump("acme/orbit", 42);
  const first = prJump()!.n;
  requestPrJump("acme/orbit", 42);
  expect(prJump()!.n).toBe(first + 1);
});

test("subscribers hear both the request and the clearing", () => {
  let beats = 0;
  const off = subscribePrJump(() => { beats++; });
  requestPrJump("acme/orbit", 7);
  clearPrJump();
  off();
  expect(beats).toBe(2);
  expect(prJump()).toBe(null);
});
