/*
 * The rail must not push its own way out of the window.
 *
 * Reported from a short window (#466): the Resources button "looks cutoff".
 * The rail is a column of fixed-height buttons with no scroller — it cannot
 * have one, because the tooltips are `::after` pseudo-elements that escape
 * horizontally and any overflow container clips both axes. So the fix is the
 * other direction: every button gives up height, together, before the column
 * overflows, down to a floor the icon fits; the cluster below the hairline
 * (Ports, Resources, Settings, the way back from anywhere) compresses with the
 * rest, because holding its size made the groups above it paint over each other.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "src", "components", "workspace", "ViewRail.tsx"), "utf8");

describe("the rail in a window shorter than its icons", () => {
  test("every rail button may compress, and none below a legible floor", () => {
    const buttons = src.match(/className="agw-tip relative [^"]*"/g) ?? [];
    expect(buttons.length, "the rail still has its buttons").toBeGreaterThan(3);
    for (const cls of buttons) {
      expect(cls, `a rail button that cannot shrink: ${cls}`).toContain("shrink");
      expect(cls, `a rail button with no floor: ${cls}`).toContain("min-h-6");
    }
  });

  test("the group that holds the views may shrink below its content", () => {
    // Without `min-h-0` a flex child refuses to go under its content height,
    // and the column grows past the window instead of compressing.
    // flex-auto, not flex-1: from a zero basis the group never shrinks, so at 520 px it
    // went to nothing while the groups below kept their size and the buttons overlapped.
    expect(src).toContain('className="flex-auto min-h-0 flex flex-col gap-1"');
    expect(src).toContain('className="pt-2 min-h-0 flex flex-col gap-1"');
  });

  test("the cluster below the hairline gives way with everything else, to the same floor", () => {
    // Holding its full size (`shrink-0`) made the groups above it overlap on a short
    // window: five buttons at 520 px, none once all of them compress together.
    expect(src).toContain('className="min-h-0 flex flex-col gap-1"');
    expect(src).not.toContain('className="shrink-0 flex flex-col gap-1"');
  });

  test("the rail itself is still not a scroller, because the tooltips leave it", () => {
    // `overflow-y: auto` would make overflow-x compute to auto as well, and a
    // 200px tooltip beside a 52px rail would be clipped to the rail.
    expect(src).toContain("overflow-visible");
    expect(src).not.toMatch(/className="[^"]*w-\[52px\][^"]*overflow-(y-)?(auto|scroll)/);
  });
});

// The rail's names come from the one tooltip host (data-tip). A second, CSS-drawn box next to it showed the name twice.
test("the rail draws no tooltip of its own in CSS", async () => {
  const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
  expect(css).not.toMatch(/\.agw-tip[^{]*::after/);
});
