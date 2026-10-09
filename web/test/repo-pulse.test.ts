import { describe, expect, test } from "bun:test";
import type { GitRepoRef } from "../../shared/types.ts";
import { PILL_POLL_MS, withFreshRepo } from "../src/lib/repoPulse.ts";

const row = (root: string, over: Partial<GitRepoRef> = {}): GitRepoRef =>
  ({ root, name: root.split("/").pop()!, branch: "fix-thing", dirty: 0, ahead: 0, behind: 0, touchedAt: 1, ...over });

describe("withFreshRepo", () => {
  const list = [row("/code/orbit"), row("/code/orbit-wt", { worktreeOf: "/code/orbit", touchedAt: 5 })];

  test("a rename and a new change reach the row the pill reads", () => {
    const next = withFreshRepo(list, row("/code/orbit-wt", { branch: "fix-other", dirty: 2 }));
    expect(next[1]).toMatchObject({ branch: "fix-other", dirty: 2, worktreeOf: "/code/orbit", touchedAt: 5 });
    expect(next[0]).toBe(list[0]!);
  });

  test("an unchanged answer returns the same array, so the panel does not re-render on a timer", () => {
    expect(withFreshRepo(list, row("/code/orbit-wt", { touchedAt: 99 }))).toBe(list);
  });

  test("a checkout the list does not hold is not added, and no answer is no change", () => {
    expect(withFreshRepo(list, row("/code/elsewhere", { dirty: 4 }))).toBe(list);
    expect(withFreshRepo(list, null)).toBe(list);
  });

  test("the beat is a few seconds, not the server's 15 s cache", () => {
    expect(PILL_POLL_MS).toBeGreaterThanOrEqual(2000);
    expect(PILL_POLL_MS).toBeLessThanOrEqual(5000);
  });
});
