import { expect, test } from "bun:test";

/* The header above a commit's diff printed the machine path of the file
   (/home/.../orbit/src/partial.ts); the list beside it already showed it
   relative to the checkout. No renderer here, so asserted against source. */
const src = await Bun.file(new URL("../src/components/diff/PresetDiff.tsx", import.meta.url)).text();

test("the title line shows the repo-relative path", () => {
  expect(src).toMatch(/\{repoRelative\(root, selected\.file_path\)\}<\/p>/);
  expect(src).not.toMatch(/\{selected\.file_path\}<\/p>/);
});
