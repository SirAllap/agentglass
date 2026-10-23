import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * Every control in the pull-request bar is one size. There is no renderer here,
 * so the rule is asserted against source: a button in the bar takes `BAR_CTRL`
 * (or `BAR_SQUARE` when it holds only an icon) and does not set a height or a
 * padding of its own. The bar used to hold five heights (22, 24, 27.3, 28, 32)
 * because each control was written beside the code it belongs to.
 */
const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
const code = (x: string) => x.split("\n").filter((l) => !/^\s*(\/?\*|\/\/)/.test(l)).join("\n");
const chrome = code(read("../src/components/workspace/Chrome.tsx"));
const filterBar = code(read("../src/components/PrFilterBar.tsx"));
const presetsAll = code(read("../src/components/FilterPresets.tsx"));
const panel = code(read("../src/components/PrPanel.tsx"));
const triage = code(read("../src/components/TriageBoard.tsx"));

/** The opening tag of every <button …>: its props, not the children that follow. */
const buttons = (src: string) => src.split(/<button\b/).slice(1).map((c) => c.split(/>\s*\n\s*(?=[<{A-Za-z])/)[0]!);
const OWN_SIZE = /\b(?:min-h|h|py|px|w)-\[?\d|\bp[xy]-\d|minHeight|height:|width:/;

const presets =
  presetsAll.slice(presetsAll.indexOf("const chip = (p: Preset)"), presetsAll.indexOf("const chipMenuItems")) +
  presetsAll.slice(presetsAll.indexOf('role="toolbar"'), presetsAll.indexOf("{more && hidden.length > 0 && ("));
const bar = filterBar.replace(/<div id="pr-at-people"[\s\S]*?<\/div>\s*\)}\s*<\/div>/, "");

describe("the pull-request bar's one control", () => {
  it("is the CHIP's shape at the 28 rung, with a height and not a minimum", () => {
    expect(chrome).toContain("export const BAR_H = CTRL_H.regular;");
    expect(chrome).toMatch(/export const BAR_CTRL = "[^"]*\bh-\[28px\][^"]*"/);
    expect(chrome).toMatch(/export const BAR_SQUARE = "[^"]*\bw-\[28px\] h-\[28px\][^"]*"/);
    expect(chrome).toMatch(/export const BAR_INPUT =\s*"[^"]*\bh-\[28px\]/);
  });

  it("no button of the filter bar sets its own height or padding", () => {
    const bs = buttons(bar).filter((b) => !b.includes('role="option"'));
    expect(bs.length).toBeGreaterThanOrEqual(4);
    for (const b of bs) {
      expect(b).toMatch(/BAR_CTRL|BAR_SQUARE/);
      expect(b.replace(/\$\{BAR_(?:CTRL|SQUARE)\}/g, "")).not.toMatch(OWN_SIZE);
    }
  });

  it("the search box is the bar's input, not the 32px one", () => {
    expect(bar).toContain("${BAR_INPUT}");
    expect(bar).not.toMatch(/\$\{INPUT\}/);
  });

  it("the saved sets, More, Clear filters and the ⋯ menu are the same control", () => {
    const bs = buttons(presets).filter((b) => !b.includes("Menu for"));
    expect(bs.length).toBe(4);
    for (const b of bs) {
      expect(b).toContain("BAR_CTRL");
      expect(b.replace(/\$\{BAR_CTRL\}/g, "")).not.toMatch(OWN_SIZE);
    }
  });

  it("the view switcher's pill is that control too", () => {
    const from = panel.indexOf("function Pill(");
    const pill = panel.slice(from, panel.indexOf("\n}\n", from));
    const [b] = buttons(pill);
    expect(b).toContain("BAR_CTRL");
    expect(b.replace(/\$\{BAR_CTRL\}/g, "")).not.toMatch(OWN_SIZE);
  });

  it("the refresh, the age and the banner buttons take the bar's height and icon", () => {
    expect(panel).toContain("iconSize={BAR_ICON}");
    expect(panel).toMatch(/inline-flex items-center h-\[28px\] text-\[11px\] tabular-nums/);
    expect(triage).toMatch(/agx-btn ml-auto \$\{BAR_CTRL\}/);
    expect(triage).toMatch(/agx-btn \$\{BAR_CTRL\} font-semibold/);
  });

  it("no bar control draws its glyph at a size of its own", () => {
    expect(bar).not.toMatch(/Icon size=\{ICON\.(?:xs|md)\}/);
    expect(presets).not.toMatch(/Glyph name="(?:dots|chev)" \/>\s*\{live|<Glyph name="chev" \/>/);
  });
});
