/*
 * The Browser view and its overlays, held to the house controls.
 *
 * A render of the view beside the Plugins view found the same things drawn a
 * second time by hand:
 *
 *   - the screenshot bar's Copy / Download / Visible / Cancel and the page
 *     picker's and markup bar's buttons were `<button>`s with their own
 *     padding, at 26px on a 22 / 28 ladder, on a private border constant;
 *   - the picker's Change / Question toggle was two bordered buttons in a row
 *     instead of `Segmented`, and its note box sat on `--bg` with a primary
 *     border instead of the well and `EDGE`;
 *   - the terminal hand-off was a typed `▸_`;
 *   - the sidebar's menu, new-tab, folder, find-step and split buttons were
 *     24 / 22px squares at `rounded-md` or `rounded`, and the import dialog's
 *     space picker and buttons were `rounded-md` text with a private tint.
 *
 * Read from source: mounting these wants a live webview.
 */
import { describe, expect, test } from "bun:test";

const read = (p: string) => Bun.file(new URL(`../src/components/${p}`, import.meta.url)).text();
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const shooter = code(await read("browser/Shooter.tsx"));
const picker = code(await read("browser/PagePicker.tsx"));
const markup = code(await read("browser/MarkupLayer.tsx"));
const panel = code(await read("BrowserPanel.tsx"));

describe("the overlays' push buttons", () => {
  test.each([
    ["Shooter", shooter],
    ["PagePicker", picker],
  ])("%s draws no <button> of its own", (_n, src) => {
    expect(src).not.toContain("<button");
    expect(src).toContain("<Button");
  });

  test("the markup bar's Done is Button; only its colour and width swatches are raw", () => {
    expect(markup).toContain('<Button onClick={onDone} size="compact">Done</Button>');
    expect(markup.match(/<button/g)?.length).toBe(2);
  });

  test("the screenshot bar uses EDGE, not a border of its own", () => {
    expect(shooter).not.toContain("const BORDER");
    expect(shooter).toContain("EDGE");
    expect(shooter).toContain('<Button tone="primary"');
  });

  test("the terminal hand-off is a drawn icon, not a typed prompt", () => {
    for (const src of [picker, markup]) {
      expect(src).toContain("<TerminalIcon");
      expect(src).not.toContain("▸_");
    }
  });
});

describe("the page picker", () => {
  test("its intent toggle is Segmented", () => {
    expect(picker).toContain("<Segmented<Intent>");
  });

  test("its note box wears the house well and edge", () => {
    const at = picker.indexOf("<textarea");
    const tag = picker.slice(at, picker.indexOf("/>", at));
    expect(tag).toContain("var(--surface-inset)");
    expect(tag).toContain("EDGE");
    expect(tag).not.toContain('"var(--bg)"');
  });
});

describe("the sidebar's small controls", () => {
  test("stand on the compact rung with a control's radius", () => {
    expect(panel).not.toMatch(/width: 2[24], height: 2[24]/);
    expect(panel).not.toMatch(/rounded-md"\s*\n?\s*style=\{\{ width/);
    expect(panel).toContain("width: CTRL_H.compact, height: CTRL_H.compact");
  });

  test("a close on a row is rounded-lg like every control", () => {
    expect(panel).not.toContain("group-focus-within:opacity-100 rounded-md");
  });

  test("the import dialog is Chip and Button, not tinted text", () => {
    const at = panel.indexOf("Import from ");
    const dialog = panel.slice(at, panel.indexOf("{carry &&", at));
    expect(dialog).toContain("<Chip");
    expect(dialog).toContain('<Button size="compact" tone="primary"');
    expect(dialog).not.toContain("<button");
  });
});
