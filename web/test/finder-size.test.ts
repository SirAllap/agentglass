import { test, expect } from "bun:test";
import { FINDER_BOX } from "../src/lib/finderSize.ts";

const src = await Bun.file(new URL("../src/components/FilePalette.tsx", import.meta.url)).text();

/* The finder jumped between heights as its content changed (a folder of three
 * items short, one item shorter, an open file tall). The surface's box is one
 * constant, and the panel must take it from there and not size to content. */
test("the box is a fixed height, not one derived from content", () => {
  expect(FINDER_BOX.height).toBe("100%");
  expect(FINDER_BOX.width).toMatch(/^min\(\d+px, 100%\)$/);
});

test("the panel takes its box from finderSize and does not size to content", () => {
  const at = src.indexOf('aria-label="Find a file"');
  expect(at).toBeGreaterThan(0);
  const open = src.lastIndexOf("<motion.div", at);
  const tag = src.slice(open, at).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  expect(tag).toContain("...FINDER_BOX");
  expect(tag).not.toMatch(/maxHeight|minHeight|h-auto|max-h-|min-h-/);
  expect(tag).not.toMatch(/\bwidth:/);
});
