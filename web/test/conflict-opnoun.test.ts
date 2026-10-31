// A revert or cherry-pick stopped on a conflict said "merge" on every label.
import { expect, it } from "bun:test";
import { opNoun } from "../src/lib/conflictBrief.ts";

it("names the operation that is actually stopped", () => {
  expect(["merging", "rebasing", "reverting", "cherry-picking", undefined].map(opNoun))
    .toEqual(["merge", "rebase", "revert", "cherry-pick", "merge"]);
});

it("the conflict screen has no hard-coded merge wording left for the commit step", async () => {
  const src = await Bun.file(new URL("../src/components/ConflictMode.tsx", import.meta.url)).text();
  expect(src).not.toContain('"merge committed"');
  expect(src).not.toContain('"merge aborted"');
  expect(src).not.toContain('"Commit the merge"');
});

it("the strip's abort toast names the operation too", async () => {
  const src = await Bun.file(new URL("../src/components/GitPanel.tsx", import.meta.url)).text();
  expect(src).not.toContain('"merge aborted"');
});
