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

describe("a workspace known to have no custom ids", () => {
  // Without them a free ClickUp workspace has no `ABC-12` to find, so one in a
  // branch is somebody else's tracker (a Jira key, HOTFIX-12) and a chip for it
  // dead-ends in "No card called ABC-12".
  const jira = { headRefName: "fix/ABC-12-pagination" };
  const native = { headRefName: "CU-86abc123_pagination" };
  const none = { connected: true, noCustomIds: true };

  it("does not take a bare ABC-12 for a card, for either gate", () => {
    expect(chipAction(cardRef(jira), none)).toBeNull();
    expect(mergeCardRef(jira, none)).toBeNull();
    expect(looksLikeOurs(cardRef(jira)!, undefined, true, true)).toBe(false);
  });

  it("still takes ClickUp's own CU- id, wherever the prefix stands", () => {
    expect(chipAction(cardRef(native), none)).toEqual({ in: "tasks" });
    expect(mergeCardRef(native, none)?.query).toBe("CU-86abc123");
    // A workspace WITH a prefix is no reason to refuse the native spelling.
    expect(chipAction(cardRef(native), { connected: true, prefix: "ORBIT-" })).toEqual({ in: "tasks" });
  });

  it("still takes an address", () => {
    const linked = { headRefName: "fix/ABC-12", body: "https://app.clickup.com/t/86abc123" };
    expect(chipAction(cardRef(linked), none)).toEqual({ in: "tasks" });
  });

  it("changes nothing while it is unknown", () => {
    expect(chipAction(cardRef(jira), { connected: true })).toEqual({ in: "tasks" });
    expect(chipAction(cardRef(jira), { connected: true, noCustomIds: false })).toEqual({ in: "tasks" });
  });
});
