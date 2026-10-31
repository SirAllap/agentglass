import { expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();

// A merge pressed in the app empties the PR list cache, so the list read that follows has no "was open" to compare: the PR never looks gone and Automatic never ran (a merged PR kept its leftovers).
test("a merge made through /prs/merge asks the automatic cleanup directly, except when it only enabled auto-merge", () => {
  const line = src.split("\n").find((l) => l.includes("afterMergeHook?.(root, n)")) ?? "";
  expect(line).toContain('pathname === "/prs/merge"');
  expect(line).toContain("res?.ok");
  expect(line).toContain("!b.auto");
  expect(src).toMatch(/afterMergeHook = \(root, n\) =>[^\n]*onPrsGone\(auto, id\.nameWithOwner, \[n\]\)/);
});
