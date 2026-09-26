/*
 * Sending a review clears the draft in one module, and the Files tab kept a
 * copy of the queue taken when it first opened. `clearDraft` told nobody, so
 * "Yours · not sent yet" stayed on screen under a review that had already
 * gone out. A subscriber per key closes that: every holder re-reads on
 * change instead of only when its own key changes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  clearAllDrafts,
  clearDraft,
  draft,
  subscribeDraft,
  takeDraft,
} from "../src/model/reviewDraft.ts";

afterEach(() => {
  clearAllDrafts();
});

describe("reviewDraft subscribers", () => {
  test("clearDraft notifies, and a subscriber sees [] straight after", () => {
    const key = "acme/orbit#7";
    takeDraft(key, () => [{ path: "a.ts", line: 3, body: "why not a guard here" }]);

    let seen: unknown = "never called";
    const unsubscribe = subscribeDraft(key, () => { seen = draft(key); });

    clearDraft(key);

    expect(seen).toEqual([]);
    unsubscribe();
  });

  test("takeDraft notifies too — a second remark shows up without a remount", () => {
    const key = "acme/orbit#8";
    let calls = 0;
    const unsubscribe = subscribeDraft(key, () => { calls += 1; });

    takeDraft(key, (was) => [...was, { path: "b.ts", line: 1, body: "one" }]);
    takeDraft(key, (was) => [...was, { path: "b.ts", line: 2, body: "two" }]);

    expect(calls).toBe(2);
    expect(draft(key)).toEqual([
      { path: "b.ts", line: 1, body: "one" },
      { path: "b.ts", line: 2, body: "two" },
    ]);
    unsubscribe();
  });

  test("a subscriber on one pull request is not told about another's draft", () => {
    const mine = "acme/orbit#1";
    const other = "acme/orbit#2";
    let calls = 0;
    const unsubscribe = subscribeDraft(mine, () => { calls += 1; });

    takeDraft(other, () => [{ path: "c.ts", line: 5, body: "unrelated" }]);
    clearDraft(other);

    expect(calls).toBe(0);
    unsubscribe();
  });

  test("unsubscribe stops the calls", () => {
    const key = "acme/orbit#9";
    let calls = 0;
    const unsubscribe = subscribeDraft(key, () => { calls += 1; });
    unsubscribe();

    takeDraft(key, () => [{ path: "d.ts", line: 1, body: "x" }]);

    expect(calls).toBe(0);
  });
});
