import { describe, expect, test } from "bun:test";
import { mergeGate } from "../src/model/prMergeGate.ts";
import type { PrDetail } from "../../shared/types.ts";

const base = {
  number: 1042, state: "OPEN", isDraft: false, mergeState: "CLEAN", mergeable: "MERGEABLE",
  baseRefName: "main", threads: [], checks: { total: 3, success: 3, failure: 0, pending: 0, skipped: 0 },
} as unknown as PrDetail;

describe("mergeGate", () => {
  test("a clean pull request has no refusal", () => {
    expect(mergeGate(base)).toEqual({ refusal: null, autoRefusal: null });
  });
  test("a draft refuses the merge and the arm, in the desktop's words", () => {
    const g = mergeGate({ ...base, isDraft: true, mergeState: "DRAFT" } as PrDetail);
    expect(g.refusal).toBeTruthy();
    expect(g.autoRefusal).toBeTruthy();
  });
});
