/*
 * Source rules (no renderer): the settings modal has one scroller shared by
 * every page, so a page change must reset it before paint; and hiding a
 * built-in review prompt is reversible, so it is a plain button, not danger.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const modal = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url), "utf8");
const review = readFileSync(new URL("../src/components/ReviewPromptsPane.tsx", import.meta.url), "utf8");

describe("settings page scroll", () => {
  it("resets the shared scroller in a layout effect keyed on the pane", () => {
    expect(modal).toMatch(/useLayoutEffect\(\(\) => \{\s*if \(contentRef\.current\) contentRef\.current\.scrollTop = 0;\s*\}, \[navPane\]\);/);
  });
  it("Hide is a neutral button; only Delete is a danger action", () => {
    expect(review).toMatch(/<Button onClick=\{\(\) => void drop\(r\)\}>Hide<\/Button>/);
    expect(review).not.toMatch(/DangerAction label=\{r\.builtIn/);
  });
});
