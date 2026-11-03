/*
 * The rail must not push its own way out of the window.
 *
 * Reported from a short window (#466): the Resources button "looks cutoff".
 * A first answer compressed every button down to a 24px floor. That held at
 * 520px of window and failed below it: at 427x240 the Settings entry was at
 * y=242 and four 26px icons painted over the button beneath them. The rail
 * scrolls now — a button keeps its 30px, and the strip moves. The reason it
 * could not be a scroller has gone: its tooltips are TipHost boxes on the body,
 * not `::after` pseudo-elements that an overflow container would clip.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ICON } from "../src/lib/iconSize.ts";

const src = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "src", "components", "workspace", "ViewRail.tsx"), "utf8");
const css = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "src", "index.css"), "utf8");

describe("the rail in a window shorter than its buttons", () => {
  test("every rail button keeps its height, never under the icon it draws", () => {
    const buttons = src.match(/className="[^"]*agw-tip relative[^"]*"/g) ?? [];
    expect(buttons.length, "the rail still has its buttons").toBeGreaterThanOrEqual(3);
    for (const cls of buttons) {
      expect(cls, `a rail button that may compress: ${cls}`).toContain("shrink-0");
      const floor = Number(cls.match(/min-h-\[(\d+)px\]/)?.[1] ?? 0);
      expect(floor, `a rail button with no floor: ${cls}`).toBeGreaterThanOrEqual(ICON.rail + 4);
    }
  });

  test("the groups keep their buttons, and the views' group still takes the empty run", () => {
    // flex-[1_0_auto] rather than flex-1: the blank middle below the last icon
    // is still a drop target, but the group never gives height back.
    expect(src).toContain('className="flex-[1_0_auto] min-h-0 flex flex-col gap-1"');
    expect(src).toContain('className="pt-2 min-h-0 shrink-0 flex flex-col gap-1"');
  });

  test("the rail is the scroller, and the cluster below the hairline is reachable through it", () => {
    expect(src).toContain("overflow-y-auto");
    expect(src).toContain('className="shrink-0 flex flex-col gap-1"');
  });

  test("the rail keeps one width whether or not it can scroll", () => {
    // The global 7px bar would take a sixth of the 52px strip and move the pill's
    // edges with the window; the app's own hidden-bar class keeps both still.
    const nav = src.match(/className="[^"]*overflow-y-auto[^"]*"/)?.[0] ?? "";
    expect(nav).toContain("agw-noscrollbar");
    expect(css).toContain(".agw-noscrollbar::-webkit-scrollbar");
  });
});

// The rail's names come from the one tooltip host (data-tip). A second, CSS-drawn box next to it showed the name twice.
test("the rail draws no tooltip of its own in CSS", async () => {
  const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
  expect(css).not.toMatch(/\.agw-tip[^{]*::after/);
});
