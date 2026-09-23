/*
 * The tab strip scrolls: the wheel moves it, the lit tab stays on screen, and
 * the side with hidden tabs says so.
 *
 * With twelve windows named like agents name them the row is wider than the
 * panel, and before this the tabs past the right edge could not be reached with
 * a plain mouse wheel, a window picked with the prefix could be lit off screen,
 * and nothing showed there was anything to reach.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { edgeMask, overflowEdges, revealX, wheelToX } from "../src/lib/tabStrip.ts";

const src = readFileSync(new URL("../src/components/TerminalPanel.tsx", import.meta.url).pathname, "utf8");

const wide = { scrollWidth: 1800, clientWidth: 900 };

describe("the wheel", () => {
  test("a vertical notch scrolls an overflowing strip sideways", () => {
    expect(wheelToX({ deltaX: 0, deltaY: 100, deltaMode: 0 }, wide)).toBe(100);
    expect(wheelToX({ deltaX: 0, deltaY: -100, deltaMode: 0 }, wide)).toBe(-100);
  });

  test("line-mode deltas (Firefox) are converted to pixels", () => {
    expect(wheelToX({ deltaX: 0, deltaY: 3, deltaMode: 1 }, wide)).toBe(48);
  });

  test("a strip that fits is left alone", () => {
    expect(wheelToX({ deltaX: 0, deltaY: 100, deltaMode: 0 }, { scrollWidth: 900, clientWidth: 900 })).toBeNull();
  });

  test("a gesture that is already sideways stays native", () => {
    // A trackpad swipe, or Shift+wheel: the browser already scrolls these.
    expect(wheelToX({ deltaX: 40, deltaY: 5, deltaMode: 0 }, wide)).toBeNull();
  });

  test("Ctrl+wheel is the app's zoom and passes through", () => {
    expect(wheelToX({ deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: true }, wide)).toBeNull();
    expect(wheelToX({ deltaX: 0, deltaY: 100, deltaMode: 0, metaKey: true }, wide)).toBeNull();
  });
});

describe("the lit tab is brought on screen", () => {
  const view = { scrollLeft: 0, clientWidth: 900, scrollWidth: 1800 };

  test("a tab already visible does not move the row", () => {
    expect(revealX(view, { left: 100, width: 120 }, 24)).toBeNull();
  });

  test("a tab past the right edge scrolls the least that shows it", () => {
    // Its right edge plus the pad lands exactly on the view's right edge.
    expect(revealX(view, { left: 1200, width: 120 }, 24)).toBe(1200 + 120 + 24 - 900);
  });

  test("a tab past the left edge scrolls back to it", () => {
    expect(revealX({ ...view, scrollLeft: 800 }, { left: 300, width: 120 }, 24)).toBe(276);
  });

  test("never past either end", () => {
    expect(revealX({ ...view, scrollLeft: 500 }, { left: 10, width: 80 }, 24)).toBe(0);
    expect(revealX(view, { left: 1750, width: 50 }, 24)).toBe(900);
  });

  test("a tab wider than the strip shows its start, where the name is", () => {
    expect(revealX({ scrollLeft: 0, clientWidth: 100, scrollWidth: 1800 }, { left: 500, width: 300 }, 0)).toBe(500);
  });
});

describe("the hidden side fades", () => {
  test("edges follow the scroll position", () => {
    expect(overflowEdges(0, 900, 1800)).toEqual({ start: false, end: true });
    expect(overflowEdges(400, 900, 1800)).toEqual({ start: true, end: true });
    expect(overflowEdges(900, 900, 1800)).toEqual({ start: true, end: false });
    expect(overflowEdges(0, 900, 900)).toEqual({ start: false, end: false });
  });

  test("half a pixel short of the end is the end", () => {
    expect(overflowEdges(899.5, 900, 1800).end).toBe(false);
  });

  test("no mask when nothing is hidden, and only the hidden side dissolves", () => {
    expect(edgeMask({ start: false, end: false })).toBeUndefined();
    expect(edgeMask({ start: false, end: true })).toBe("linear-gradient(to right, #000 0, #000 calc(100% - 24px), transparent 100%)");
    expect(edgeMask({ start: true, end: false })).toBe("linear-gradient(to right, transparent 0, #000 24px, #000 100%)");
  });
});

describe("the strip uses it", () => {
  test("the scroller carries the hook's ref and mask", () => {
    expect(src).toContain("ref={tabStrip.ref}");
    expect(src).toContain("maskImage: edgeMask(tabStrip.edges)");
  });

  test("tabs are addressable by window id, so the hook can find the lit one", () => {
    expect(src).toContain("data-window={w.id}");
  });

  test("names are cut with an ellipsis and the full name is in the tooltip", () => {
    expect(src).toContain("max-w-[16ch] truncate");
    expect(src).toMatch(/title=\{`\$\{w\.name \|\| "shell"\} — window \$\{w\.index\}/);
  });
});
