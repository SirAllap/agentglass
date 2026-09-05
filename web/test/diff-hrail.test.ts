/*
 * The sideways scrollbar has to be where the eyes are.
 *
 * Reported with three screenshots: a 1400-line file open in split view, and to
 * reach the horizontal scrollbar he had to scroll to the very end of the diff —
 * "until I scroll all the way down I don't know it has a horizontal scroll". By then the
 * line he wanted to read sideways was long gone off the top.
 *
 * Why it happened: the panes scroll sideways and deliberately do NOT scroll
 * vertically (`overflow-y: hidden` — two nested vertical scrollers is the double
 * scroll this app fixed once already). Their height is therefore the file's
 * height, and a scrollbar lives at the bottom of ITS OWN box: 2800px down.
 *
 * The fix, measured in Chrome on a replica of this exact nesting — a 300px
 * column, a 200-line pane 932px wide inside it:
 *
 *   pane  scrollWidth 932 > clientWidth 385   → the pane still owns the scroll
 *   col   scrollHeight 2811 > clientHeight 300 → the column still scrolls it
 *   rail  bottom 301 at scrollTop 0, 1200 and 2811 — the column's bottom is 302
 *
 * i.e. the rail sits on the bottom edge of the view at the top of the file, in
 * the middle of it and at its end. Dragging the rail moved the pane to the same
 * scrollLeft (300), which is the whole point of a proxy bar.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UnifiedDiff, SplitDiff } from "../src/components/diff/DiffLines.tsx";

const HUNKS = [{
  oldStart: 1, oldLines: 3, newStart: 1, newLines: 3,
  lines: [" const short = 1", `-const removed = "${"x".repeat(160)}"`, `+const added = "${"x".repeat(160)}"`],
}] as never;

const uni = (wrap = false) => renderToStaticMarkup(React.createElement(UnifiedDiff, { hunks: HUNKS, wrap } as never));
const split = (wrap = false) => renderToStaticMarkup(React.createElement(SplitDiff, { hunks: HUNKS, wrap } as never));
const rails = (html: string) => (html.match(/data-hrail="true"/g) ?? []).length;
const panes = (html: string) => (html.match(/data-hpane="true"/g) ?? []).length;

describe("the rail that stands in for the pane's own scrollbar", () => {
  test("the unified pane has one, and the rail row is pinned to the bottom", () => {
    const html = uni();
    expect(panes(html)).toBe(1);
    expect(rails(html)).toBe(1);
    expect(html).toContain('class="sticky bottom-0 z-20 flex" data-hrail-row');
  });

  test("split has one per column, because the columns scroll independently", () => {
    /* A single bar across both would have to pick a width: the left column's
       longest line is not the right column's, and the two panes have always
       scrolled apart on purpose. */
    const html = split();
    expect(panes(html)).toBe(2);
    expect(rails(html)).toBe(2);
  });

  test("the panes keep the scrolling and give up the bar", () => {
    for (const html of [uni(), split()]) {
      // Still the horizontal scroller: the rail only mirrors it.
      expect(html).toContain("overflow-x:auto;overflow-y:hidden");
      // But its own scrollbar is hidden — otherwise there are two of them, one
      // of which is 2800px down the page, and the lower one is the one he kept
      // finding ("the scroll is still at the very bottom of the file diff").
      expect(html).toContain("agx-scroll agx-nobar");
    }
  });

  test("and they still pin the vertical axis, which is the older fix", () => {
    // `overflow-x: auto` computes `overflow-y: auto` unless the other axis is
    // set, and that is the double-scroll bug. Losing this while moving the bar
    // around would put it straight back.
    expect(uni()).not.toContain("overflow-x:auto;overflow-y:auto");
    expect(split()).not.toContain("overflow-x:auto;overflow-y:auto");
  });

  test("the rail is hidden until something measures it", () => {
    /* Width comes from `scrollWidth` in an effect, never from a guess, so a
       file that fits has no strip laid across the bottom of it. Server markup
       is the un-measured state: the row is display:none and the spacer 1px. */
    expect(uni()).toContain("height:12px;visibility:hidden");
    expect(uni()).toContain('style="width:1px;height:1px"');
    expect(uni()).toContain("data-hrail-row=\"true\" style=\"display:none");
  });

  test("a hidden rail keeps its half of the row", () => {
    /* `visibility`, not `display`. Measured with only the right column
       overflowing: the surviving bar stretched to 1243px under a 621px pane,
       i.e. it claimed the missing one's width and stopped pointing at anything.
       Both are laid out; one is simply not painted. */
    expect(split()).not.toContain("height:12px;display:none");
    expect((split().match(/visibility:hidden/g) ?? []).length).toBe(2);
  });

  test("never says `visible` — a hidden view has to stay hidden", () => {
    /* The workspace hides the view you are not looking at with
       `visibility: hidden` on its box, and a descendant that sets `visible`
       overrides it. This 12px bar did, so it went on painting sticky to the
       bottom of the WINDOW over every other view — reported as the diff's rail
       appearing everywhere in the app. Shown means "inherit", not "visible". */
    const src = readFileSync(new URL("../src/components/diff/DiffLines.tsx", import.meta.url), "utf8");
    const at = src.indexOf("data-hrail");
    expect(src.slice(at, at + 400)).not.toContain('"visible"');
  });

  test("hiding the pane's own bar cannot be done from a layer", () => {
    /* `.agw-noscrollbar` lives in `@layer components`, and an unlayered rule
       beats every layered one whatever its specificity — so `.agx-scroll`,
       injected as a plain <style> in the tree, kept the bar. Measured in the
       running app before the fix: scrollbar-width computed `thin` and the pane
       was 10px taller than its client box. This rule is unlayered, two classes
       deep, and rendered by the diff itself so no caller can leave it out. */
    expect(uni()).toContain(".agx-scroll.agx-nobar{scrollbar-width:none}");
    expect(split()).toContain(".agx-scroll.agx-nobar{scrollbar-width:none}");
  });

  test("the diff root is not a scroller — the column outside it is", () => {
    // The root used to be the pane. If it goes back to carrying overflow, the
    // rail's `position: sticky` starts measuring against the root's own
    // scrollport (which is the file's height) and pins to nothing.
    const head = uni().slice(0, uni().indexOf(">") + 1);
    expect(head).not.toContain("overflow");
    expect(head).toContain("flex flex-col");
  });
});
