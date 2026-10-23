/*
 * The "raw HTML is shown as inert text" note belongs to a Markdown file that has raw HTML.
 */
import { describe, expect, test } from "bun:test";
import { hasRawHtml } from "../src/lib/finderPreview.ts";

const body = await Bun.file(new URL("../src/components/finder/machine/PreviewBody.tsx", import.meta.url)).text();
const media = await Bun.file(new URL("../src/components/finder/machine/MediaPreview.tsx", import.meta.url)).text();

describe("hasRawHtml", () => {
  test.each(["# Title\n<div class=\"x\">hi</div>", "a <br/> b", "<details>\n<summary>x</summary>", "</p>"])("%j has", (t) => { expect(hasRawHtml(t)).toBe(true); });
  test.each(["# Title\n\nplain text", "if a < b and c > d", "see <https://example.com/x>", "1 <2> 3", ""])("%j has not", (t) => { expect(hasRawHtml(t)).toBe(false); });
  test("nothing read is nothing", () => { expect(hasRawHtml(undefined)).toBe(false); });
});

describe("the scheme of a theme", () => {
  test("a light background draws native controls light even on a dark system, a dark one dark", async () => {
    const { schemeOfBg } = await import("../src/lib/schemeOfTheme.ts");
    expect(schemeOfBg("#ffffff")).toBe("light");
    expect(schemeOfBg(" #fdf6e3 ")).toBe("light");
    expect(schemeOfBg("#1e1e1e")).toBe("dark");
    expect(schemeOfBg("")).toBe("dark");
  });
});

describe("the preview", () => {
  test("shows the note only for a text with HTML, and tells the audio bar the theme", () => {
    expect(body).toContain("{hasRawHtml(facts.text) && <div role=\"note\"");
    expect(media).toContain("colorScheme: schemeOfTheme()");
    expect(media).not.toContain('colorScheme: "light dark"');
  });
});
