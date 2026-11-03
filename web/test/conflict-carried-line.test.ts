import { describe, expect, it } from "bun:test";
import { carriedLine } from "../src/lib/conflictBrief.ts";

describe("the sentence under a conflict's clean files names the operation", () => {
  it("merge, rebase, cherry-pick and revert each say their own word", () => {
    expect(carriedLine("merging", 2)).toBe("come in with this merge without conflicting.");
    expect(carriedLine("rebasing", 1)).toBe("is replayed with this commit without conflicting.");
    expect(carriedLine("cherry-picking", 1)).toBe("comes in with this commit without conflicting.");
    expect(carriedLine("reverting", 3)).toBe("come in with this revert without conflicting.");
  });
});
