import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * The review hint names the platform's modifier.
 *
 * "⌘↵ to add" was hardcoded — every Windows and Linux hand reading the diff
 * view saw a Mac key it does not have. MergeDialog.tsx's confirm hint already
 * solved this with MOD_KEY (lib/format.ts), which resolves ⌘ or "Ctrl+" from
 * the platform at runtime; DiffReview.tsx's comment box is the same shape of
 * hint and had simply not been switched over.
 */
const src = readFileSync(new URL("../src/components/diff/DiffReview.tsx", import.meta.url), "utf8");

/* A hundred-plus lines of component between the import and the hint itself —
 * sliced to just those two spots, so a failure names the one word that
 * changed instead of dumping the whole file (same idiom as
 * browser-tab-ownership.test.ts's `.includes()` into a boolean). */
const imports = src.slice(0, src.indexOf("const CARD"));
const hintStart = src.indexOf('style={{ color: "var(--text3)" }}>', src.indexOf("CommentBox"));
const hintLine = src.slice(hintStart, src.indexOf(" to add") + 40);

describe("the comment box's keyboard hint", () => {
  test("uses MOD_KEY rather than a literal ⌘", () => {
    expect(hintLine.includes("MOD_KEY")).toBe(true);
    expect(hintLine.includes("⌘")).toBe(false);
  });

  test("imports it from lib/format.ts, the same source MergeDialog.tsx uses", () => {
    expect(imports.includes('MOD_KEY') && imports.includes('from "../../lib/format.ts"')).toBe(true);
  });
});
