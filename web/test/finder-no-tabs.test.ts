/*
 * The finder is one mode. Name, Contents, Recent and Machine used to be four
 * tabs in the palette's top bar; the owner decided there is the finder, a box
 * that searches the folder that is open, a chip for what is inside the files,
 * and Recent as the sidebar's entry. This fails the build if a strip or a
 * switcher between those comes back, in the palette or anything it renders.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

const strip = (s: string) => s.split("\n").filter((l) => { const t = l.trim(); return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); }).join("\n");
const palette = strip(await Bun.file(new URL("../src/components/FilePalette.tsx", import.meta.url)).text());
const dirs = ["finder", "finder/machine"].map((d) => new URL(`../src/components/${d}/`, import.meta.url));
const rendered = await Promise.all(dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".tsx")).map(async (f) => [f, strip(await Bun.file(new URL(f, d)).text())] as const)));

describe("the finder has no tab strip", () => {
  test("the palette has no tab list, no tab buttons and no switcher type", () => {
    expect(palette).not.toMatch(/role=["']tablist["']/);
    expect(palette).not.toMatch(/role=["']tab["']/);
    expect(palette).not.toContain("PaletteTab");
    expect(palette).not.toMatch(/\bTABS\b/);
    expect(palette).not.toContain('aria-label="What to search"');
  });
  test("no four-way question is declared anywhere it renders", () => {
    for (const [f, t] of [["FilePalette.tsx", palette] as const, ...rendered]) {
      expect(t, f).not.toMatch(/id:\s*"names"/);
      expect(t, f).not.toMatch(/id:\s*"contents"/);
      expect(t, f).not.toMatch(/label:\s*"(Name|Contents|Machine)"/);
    }
  });
  test("Tab no longer cycles questions", () => {
    expect(palette).not.toMatch(/goTab\(TABS/);
    expect(palette).not.toMatch(/e\.shiftKey \? TABS/);
  });
  test("Recent is the sidebar's entry", () => {
    expect(palette).toContain('onRecent={() => goTab("recent")}');
  });
});
