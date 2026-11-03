/*
 * A window shorter than the rail: something must scroll.
 *
 * Measured at 640x360: the shell was `clientHeight 360 / scrollHeight 410` with
 * `overflow: hidden`, and the 50px that did not fit were the Settings entry and
 * the git commit box — nothing could bring either into reach. At 427x240 the
 * rail lost three entries and four 22px icons painted over the button below
 * them, because every button compressed to a 24px floor.
 *
 * The shell now scrolls below 600px of height, and the rail is a scroller: a
 * button keeps the 30px its 26px icon needs and the strip is scrolled instead
 * of squeezed. The tooltips that made "the rail must not be a scroller" true
 * are drawn by TipHost on the body now, so nothing is clipped by the strip.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ICON } from "../src/lib/iconSize.ts";

const root = join(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");
const CSS = read("src/index.css");
const APP = read("src/App.tsx");
const WS = read("src/components/workspace/Workspace.tsx");
const RAIL = read("src/components/workspace/ViewRail.tsx");
const MODAL = read("src/components/SkillsModal.tsx");
const MACHINE_CSS = read("src/components/machine/machineCss.ts");

describe("the shell on a window shorter than the app", () => {
  test("it scrolls below 600px of height instead of clipping what does not fit", () => {
    const block = CSS.slice(CSS.indexOf("@media (max-height: 600px)"), CSS.indexOf("@media (max-height: 600px)") + 220);
    expect(block).toContain(".agx-shell { overflow-y: auto; }");
    expect(block).toContain(".agx-shell-grow { flex: 1 1 auto; min-height: 480px; }");
    expect(APP).toContain('className="agx-shell h-screen overflow-hidden flex flex-col relative"');
    expect(WS).toContain("agx-shell-grow flex-1 min-h-0 flex");
  });
});

describe("the rail in the same window", () => {
  test("the strip scrolls, so the cluster at the bottom is reachable", () => {
    expect(RAIL).toContain('className="shrink-0 flex flex-col gap-1 p-2 overflow-y-auto agw-noscrollbar"');
  });

  test("no button is ever shorter than the icon it draws", () => {
    const buttons = RAIL.match(/className="[^"]*agw-tip relative[^"]*"/g) ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const cls of buttons) {
      expect(cls, `a rail button that may compress: ${cls}`).toContain("shrink-0");
      const floor = Number(cls.match(/min-h-\[(\d+)px\]/)?.[1] ?? 0);
      expect(floor, `a rail button with no floor: ${cls}`).toBeGreaterThanOrEqual(ICON.rail + 4);
    }
  });

  test("the groups cannot shrink under the buttons, and the bottom cluster keeps its size", () => {
    // flex-[1_0_auto]: takes the empty run below the last icon (the drop target)
    // but never gives height back to a window that is too short.
    expect(RAIL).toContain('className="flex-[1_0_auto] min-h-0 flex flex-col gap-1"');
    expect(RAIL).toContain('className="pt-2 min-h-0 shrink-0 flex flex-col gap-1"');
    expect(RAIL).toContain('className="shrink-0 flex flex-col gap-1"');
  });
});

describe("the dialogs that were fixed to the window's height", () => {
  test("the skills catalog keeps 120px of list at any window, and the card scrolls the rest", () => {
    expect(MODAL).toContain("h-[min(960px,92vh)] rounded-xl flex flex-col overflow-y-auto");
    expect(MODAL).toContain('className="flex-1 min-h-[120px] overflow-y-auto px-5 pb-4"');
  });

  test("the machine panel's short-window rule is the one that wins", () => {
    // Same specificity as the base rules, so source order decides: the media
    // block must sit after both, with nothing re-declaring them below it.
    const short = MACHINE_CSS.indexOf("@media (max-height:480px)");
    expect(short).toBeGreaterThan(MACHINE_CSS.indexOf(".mc-mod{position:fixed"));
    expect(short).toBeGreaterThan(MACHINE_CSS.indexOf(".mc-spf{flex:none"));
    const block = MACHINE_CSS.slice(short, MACHINE_CSS.indexOf("\n", short));
    expect(block).toContain(".mc-mod{top:1vh;bottom:1vh}");
    expect(block).toContain(".mc-spf{max-height:30%;padding:6px 10px}");
    const below = MACHINE_CSS.slice(short + block.length);
    expect(below).not.toContain(".mc-mod{");
    expect(below).not.toContain(".mc-spf{");
    // The default inset is unchanged for every window tall enough for it.
    expect(MACHINE_CSS).toContain(".mc-mod{position:fixed;z-index:2;top:5vh;bottom:5vh");
  });
});
