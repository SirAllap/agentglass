/*
 * ONE RULE FOR "IS THIS CARD OURS", TWO ANSWERS FOR "WE DO NOT KNOW YET".
 *
 * The chip says yes for an unread prefix (it only picks where a tap goes), the
 * merge form says no (it would spin on a lookup). That used to be two copies of
 * the prefix test; both gates now call `looksLikeOurs` and the difference is the
 * argument. Pinned from both sides so neither can drift back.
 */
import { describe, expect, it } from "bun:test";
import { cardRef, chipAction, looksLikeOurs } from "../src/lib/cardRef.ts";
import { mergeCardRef } from "../src/lib/cardMove.ts";

const pr = { headRefName: "fix/ORBIT-1042-pagination" };
const ref = cardRef(pr)!;

describe("a prefix nobody has read yet", () => {
  it("is ours for the chip and not ours for the merge form", () => {
    expect(looksLikeOurs(ref, undefined)).toBe(true);
    expect(looksLikeOurs(ref, undefined, false)).toBe(false);
    expect(chipAction(ref, { connected: true })).toEqual({ in: "tasks" });
    expect(mergeCardRef(pr, { connected: true })).toBeNull();
  });

  it("is decided by the prefix once it is read, for both gates", () => {
    expect(looksLikeOurs(ref, "ORBIT-", false)).toBe(true);
    expect(looksLikeOurs(ref, "ACME-", false)).toBe(false);
    expect(mergeCardRef(pr, { connected: true, prefix: "ORBIT-" })?.label).toBe("ORBIT-1042");
    expect(mergeCardRef(pr, { connected: true, prefix: "ACME-" })).toBeNull();
  });
});
