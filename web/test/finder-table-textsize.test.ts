/*
 * A wide Markdown table in the Finder preview was squeezed until words broke mid-letter, and the
 * Text size setting reached the file lists but not the preview. Both are asserted against source:
 * there is no renderer here, so the rules are read as text.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { DEFAULT_PREFS, fzScale } from "../src/lib/finderMiller.ts";
import { narrowColumns } from "../src/lib/markdown.tsx";

const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
const md = await Bun.file(new URL("../src/lib/markdown.tsx", import.meta.url)).text();
const machine = await Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url)).text();

const rule = (selector: string): string => {
  const at = css.indexOf(selector);
  if (at < 0) return "";
  return css.slice(at, css.indexOf("}", at));
};

describe("a wide table keeps its words whole and scrolls inside its own box", () => {
  test("the wrapper scrolls sideways and shows its scrollbar", () => {
    const r = rule(".agx-prose-pane .agx-md-table {");
    expect(r).toContain("overflow: auto");
    expect(r).toContain("max-height");
    expect(r).toContain("scrollbar-width: auto");
    expect(rule(".agx-prose-pane .agx-md-table th {")).toContain("position: sticky");
  });
  test("cells wrap at word boundaries and hold a floor width", () => {
    const r = rule(".agx-prose-pane .agx-md-table td");
    expect(r).toContain("white-space: normal");
    expect(r).toContain("overflow-wrap: normal");
    expect(r).toMatch(/min-width: \d+(\.\d+)?em/);
  });
  test("a code span in a cell may break a long path, a word may not", () => {
    expect(rule(".agx-prose-pane .agx-md-table code")).toContain("overflow-wrap: anywhere");
  });
  test("the table is a real table as wide as its columns need", () => {
    const r = rule(".agx-prose-pane .agx-md-table table");
    expect(r).toContain("display: table");
    expect(r).toContain("width: 100%");
  });
  test("the markdown renderer marks the wrapper and the narrow columns", () => {
    expect(md).toContain("agx-md-table");
    expect(md).toContain("narrowColumns(");
  });
  test("a column of short cells (a row number) stays narrow, a column with prose does not", () => {
    expect(narrowColumns(["#", "Area", "Notes"], [["1", "ids", "a long sentence of text"], ["2", "keys", "another one here"]])).toEqual([true, true, false]);
    expect(narrowColumns(["#", "Area"], [["1", "a much longer cell than six"]])).toEqual([true, false]);
    expect(narrowColumns(["A"], [])).toEqual([true]);
  });
});

describe("Text size scales the whole Finder", () => {
  test("the scale is the size over the default, 1 at the default", () => {
    expect(fzScale(DEFAULT_PREFS.textSize)).toBe(1);
    expect(fzScale(26)).toBe(2);
  });
  test("the Finder hands the scale down, and to the menus it portals out", () => {
    expect(machine).toContain('"--fz"');
    expect(machine).toContain("documentElement.style.setProperty(\"--fz\"");
  });
  test("every font size a Finder file spells in px has a scaled rule", async () => {
    const used = new Set<string>();
    const dir = new URL("../src/components/finder/machine/", import.meta.url).pathname;
    for await (const f of new Glob("*.tsx").scan({ cwd: dir })) {
      const text = await Bun.file(dir + f).text();
      for (const m of text.matchAll(/text-\[([0-9.]+)px\]/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(5);
    for (const px of used) {
      const escaped = px.replace(".", "\\.");
      expect(css).toContain(`.text-\\[${escaped}px\\] { font-size: calc(${px}px * var(--fz, 1)); }`);
    }
  });
  // The JSON graph keeps its 10.5: its nodes are laid out in fixed geometry, so scaling the text would overflow them.
  test("the preview spells no size in bare px", async () => {
    const text = await Bun.file(new URL("../src/components/finder/machine/PreviewBody.tsx", import.meta.url)).text();
    const code = text.split("\n").filter((l) => !l.trim().startsWith("//") && !l.includes("srcdoc")).join("\n");
    expect(code).not.toMatch(/fontSize: \d/);
  });
});
