/*
 * The pinned pull requests strip scrolls without a scrollbar and wears the
 * house shape.
 *
 * With eight pins the row is wider than its 40% of the header, and the native
 * horizontal bar drew a thick track inside the capsule. The row now hides it
 * and does by hand what it did: the wheel, the lit chip kept on screen, an
 * arrow on each side that has chips past it. The chips are `rounded-lg`
 * controls at 28px like the rest of the header, and the strip has no box of
 * its own. The decisions are numbers, tested as numbers; the markup is
 * asserted against source, because there is no renderer here.
 */
import { describe, expect, it } from "bun:test";
import { edgeMask, overflowEdges, stepX } from "../src/lib/tabStrip.ts";

const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

/** Comments out, so a word in prose does not satisfy or fail a guard. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

/** The scroller's own source, to its closing brace. */
const scroller = (() => {
  const a = panel.indexOf("function PinScroller(");
  const b = panel.indexOf("\n}\n", a);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return code(panel.slice(a, b));
})();
const capsule = (() => {
  const a = panel.indexOf("function PinnedCapsule(");
  const b = panel.indexOf("\n}\n", a);
  return code(panel.slice(a, b));
})();

describe("which arrows show", () => {
  // scrollLeft, clientWidth, scrollWidth: eight chips in a 400px strip.
  const arrows = (l: number, c: number, w: number) => overflowEdges(l, c, w);

  it("none when the chips fit", () => {
    expect(arrows(0, 400, 400)).toEqual({ start: false, end: false });
    expect(arrows(0, 400, 280)).toEqual({ start: false, end: false });
  });
  it("only the one ahead at the start, only the one behind at the end, both between", () => {
    expect(arrows(0, 400, 1100)).toEqual({ start: false, end: true });
    expect(arrows(700, 400, 1100)).toEqual({ start: true, end: false });
    expect(arrows(300, 400, 1100)).toEqual({ start: true, end: true });
  });
  it("a fractional end on a zoomed display is the end", () => {
    expect(arrows(699.5, 400, 1100)).toEqual({ start: true, end: false });
  });
});

describe("what an arrow does", () => {
  const v = { scrollLeft: 0, clientWidth: 400, scrollWidth: 1100 };
  it("pages three quarters of the strip toward its side", () => {
    expect(stepX(v, 1)).toBe(300);
    expect(stepX({ ...v, scrollLeft: 300 }, -1)).toBe(0);
  });
  it("stops at the ends", () => {
    expect(stepX({ ...v, scrollLeft: 600 }, 1)).toBe(700);
  });
  it("does nothing toward a side with nothing hidden", () => {
    expect(stepX(v, -1)).toBeNull();
    expect(stepX({ ...v, scrollLeft: 700 }, 1)).toBeNull();
    expect(stepX({ scrollLeft: 0, clientWidth: 400, scrollWidth: 400 }, 1)).toBeNull();
  });
});

describe("the fade holds room for the arrow", () => {
  it("is transparent under the arrow before it starts to fade", () => {
    expect(edgeMask({ start: true, end: false }, 22)).toBe("linear-gradient(to right, transparent 0, transparent 22px, #000 46px, #000 100%)");
    expect(edgeMask({ start: false, end: true }, 22)).toBe("linear-gradient(to right, #000 0, #000 calc(100% - 46px), transparent calc(100% - 22px), transparent 100%)");
  });
});

describe("the strip in source", () => {
  it("hides the native scrollbar and does not draw one", () => {
    expect(scroller).toContain("agw-noscrollbar");
    expect(scroller).toContain("overflow-x-auto");
    expect(scroller).not.toContain("agx-scroll");
    expect(capsule).not.toContain("agx-scroll");
  });

  it("the chips are the house control radius, never a pill", () => {
    const both = scroller + capsule;
    expect(both).toContain("rounded-lg");
    expect(both).not.toContain("rounded-full");
    expect(both).not.toMatch(/rounded-\[/);
  });

  it("the chip is as tall as the header's other controls and the strip has no box", () => {
    expect(scroller).toContain("minHeight: CTRL_H.regular");
    expect(capsule).not.toMatch(/border: EDGE|bg3\) 85%/);
  });

  it("arrows are reachable, named, and mounted in both states so nothing shifts", () => {
    expect(scroller).toContain("aria-label={dir < 0");
    expect(scroller).toContain("disabled={!shown}");
    expect(scroller).toContain("{arrow(-1)}");
    expect(scroller).toContain("{arrow(1)}");
    expect(scroller).toContain("absolute");
  });

  it("scrolls by the shared strip hook, not its own wheel code", () => {
    expect(scroller).toContain("useTabStripScroll(");
    expect(scroller).toContain("data-window=");
  });
});
