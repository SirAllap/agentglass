/*
 * When the preview sits beside the columns and when it takes the whole pane.
 * Strata's rule (preview/layout.rs): split only if what is left for the
 * browser, after the divider, still holds one column (300 px, 240 for Icons and
 * List) and the preview keeps its own 240. Below that the preview is a page of
 * its own, opened with Space. A fixed "wide window" number was 900 px and put
 * the preview away at widths where it would have fitted.
 */
import { describe, expect, test } from "bun:test";
import { PREVIEW_MIN_W, previewFits } from "../src/lib/finderColumns.ts";

describe("does the preview fit beside the browser", () => {
  test("Strata's floors", () => { expect(PREVIEW_MIN_W).toBe(240); });
  test("columns need 300 + 240 + the 6 px divider", () => {
    expect(previewFits(546, "columns")).toBe(true);
    expect(previewFits(545, "columns")).toBe(false);
  });
  test("icons and list need only 240 for the browser", () => {
    expect(previewFits(486, "icons")).toBe(true);
    expect(previewFits(485, "list")).toBe(false);
  });
  test("the sidebar's room is taken off first by the caller, so a 500 px finder with its list shown has none", () => {
    expect(previewFits(500 - 201, "columns")).toBe(false);
  });
  test("a window the old rule called narrow now shows it", () => { expect(previewFits(800 - 201, "columns")).toBe(true); });
});

describe("the finder asks the rule", () => {
  test("no fixed width decides it", async () => {
    const s = await Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url)).text();
    expect(s).toContain("previewFits(");
    expect(s).not.toContain("PREVIEW_MIN");
  });
});
