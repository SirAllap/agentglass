/*
 * `gh pr update-branch` answers 202 and the merge can then not happen. The
 * server reads the remote head before and after and only syncs this machine's
 * copy when it moved.
 */
import { describe, expect, test } from "bun:test";
import { updateLanded } from "../src/prs.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("updateLanded", () => {
  test("head changed: moved", () => expect(updateLanded(A, B)).toBe("moved"));
  test("head the same: unmoved, so nothing is fast-forwarded and nothing is called synced", () => expect(updateLanded(A, A)).toBe("unmoved"));
  test("a read that failed is unknown, never unmoved", () => {
    expect(updateLanded(null, B)).toBe("unknown");
    expect(updateLanded(A, null)).toBe("unknown");
  });
});
