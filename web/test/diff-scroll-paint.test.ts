/*
 * Scroll a diff sideways and it keeps being a diff.
 *
 * Reported with two screenshots: scrolled right, the tint on the rows, the blue
 * hunk bar and everything else painted simply stopped, and past that edge there
 * was bare background with code still in it.
 *
 * Nothing was missing. Every hunk sized itself — a `max-content` grid column
 * per hunk in the unified pane, `min-width: max-content` per hunk in the split
 * one — so a file whose widest line is in hunk 1 scrolls to hunk 1's width
 * while hunk 4 stops painting at its own, several hundred pixels earlier. The
 * hunk header had it worse: a plain block is as wide as the pane, never as wide
 * as the pane's scrollWidth.
 *
 * Measured in Chrome before and after, on a pane 418px wide holding a 574px
 * file: the second hunk's rows were 70px wide and sat at x = -28 (entirely off
 * to the left) once scrolled right; afterwards every row is 516px and reaches
 * the right edge.
 *
 * The rule, and what this file holds: inside a horizontal scroller, one element
 * owns the width — `width: max-content; min-width: 100%` — and everything
 * painted inside it is a block that inherits that width. A column that has to
 * absorb the slack uses `minmax(max-content, 1fr)`, never bare `max-content`.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UnifiedDiff, SplitDiff } from "../src/components/diff/DiffLines.tsx";

/** Two hunks of very different widths — the shape that showed the bug. */
const HUNKS = [
  {
    oldStart: 1, oldLines: 3, newStart: 1, newLines: 3,
    lines: [" const short = 1", `-const removed = "${"x".repeat(120)}"`, `+const added = "${"x".repeat(120)}"`],
  },
  { oldStart: 40, oldLines: 3, newStart: 40, newLines: 3, lines: [" tiny()", "-old()", "+new()"] },
] as never;

const uni = (wrap: boolean) => renderToStaticMarkup(React.createElement(UnifiedDiff, { hunks: HUNKS, wrap } as never));
const split = (wrap: boolean) => renderToStaticMarkup(React.createElement(SplitDiff, { hunks: HUNKS, wrap } as never));

describe("one width for the whole file", () => {
  test("the unified pane hangs its hunks off a single max-content box", () => {
    expect(uni(false)).toContain("width:max-content;min-width:100%");
  });

  test("each split column does the same", () => {
    // One per side: the two columns scroll independently, so each owns a width.
    expect((split(false).match(/width:max-content;min-width:100%/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("every unified row carries the file's width", () => {
    /* The grid this replaced sized one column per HUNK, so a short hunk stopped
       painting where its own longest line ended. Now the row is the box: as wide
       as its content, never narrower than the pane. */
    const html = uni(false);
    expect(html).not.toContain("grid-template-columns");
    expect((html.match(/class="flex" style="width:max-content;min-width:100%"/g) ?? []).length).toBe(6);
  });

  test("a split row is at least as wide as the column it sits in", () => {
    expect(split(false)).toContain("width:max-content;min-width:100%");
  });

  test("the text cell grows into the slack rather than stopping at its text", () => {
    /* `max-content` on a grid column was the first shape of this bug; the rows
       are flex now, so the equivalent is the text cell being the one that
       flexes. Without it a short line's tint ends where the line does. */
    const html = uni(false);
    expect(html).toMatch(/class="[^"]*flex-1[^"]*"[^>]*style="[^"]*background:/);
  });
});

/*
 * And the numbers stay while it scrolls.
 *
 * Reported straight after the paint fix: "los números de las líneas se deben
 * quedar, ¿no?". They were already written as sticky and had never once stuck,
 * because `.agx-gutter{position:relative}` — the rule that places the hover "+"
 * — sits on the same element and wins the cascade. Measured, not read: a probe
 * in headless Chrome reported `position: relative` and the gutter at x=-170
 * after scrolling right; now it reports `sticky` and x=0.
 *
 * The second half is that sticky only works at all if the row is the element
 * that is as wide as the file — a sticky GRID ITEM is stuck to its own grid
 * area, which is 4ch wide and goes nowhere. That is why the unified pane draws
 * flex rows instead of a grid.
 */
describe("the line numbers stay put", () => {
  test("the gutter rule does not fight the sticky it sits on", () => {
    const css = readFileSync(join(import.meta.dir, "..", "src", "components", "diff", "DiffLines.tsx"), "utf8");
    expect(css).toContain(".agx-gutter{position:sticky}");
    expect(css).not.toContain(".agx-gutter{position:relative}");
  });

  test("both unified gutters are sticky and opaque", () => {
    const html = uni(false);
    // Two per row: the old-side number pinned at 0 and the new-side one pinned
    // a gutter's width along, each with a background mixed into --bg so the
    // code passes behind them instead of through them.
    expect(html).toMatch(/class="[^"]*sticky left-0[^"]*"[^>]*style="[^"]*background:color-mix\(in srgb, var\(--\w+\) 13%, var\(--bg\)\)|background:var\(--bg\)/);
    expect((html.match(/sticky/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  test("the rows are flex, because a sticky grid item sticks to nothing", () => {
    expect(uni(false)).not.toContain('class="contents"');
  });

  test("the gutter is as wide as the biggest line number in the file", () => {
    /* A flat 4ch fits three digits. Once the gutters went opaque, a four-digit
       file drew "18511851" — the old number ran under the new one. */
    const deep = renderToStaticMarkup(React.createElement(UnifiedDiff, {
      hunks: [{ oldStart: 1851, oldLines: 1, newStart: 1851, newLines: 1, lines: [" a()"] }], wrap: false,
    } as never));
    expect(deep).toContain("width:5ch");
    // And a short file still looks like every other short file.
    expect(uni(false)).toContain("width:4ch");
  });
});

describe("the same rule where lines are painted next to code", () => {
  test("the conflict view owns its width too", () => {
    /* Same `white-space: pre` body, same tinted blocks over it — held as source
       because rendering it needs a conflicted file, and what broke is one style
       on one element. */
    const s = readFileSync(join(import.meta.dir, "..", "src", "components", "ConflictMode.tsx"), "utf8");
    expect(s).toContain('<div className="py-2" style={{ width: "max-content", minWidth: "100%" }}>');
  });
});

/*
 * And exactly one thing scrolls vertically in a column.
 *
 * Reported twice — "no entiendo este doble scroll", then "sigue estando… es
 * como que el scroll de dentro no funciona, es inútil". Measured in the real
 * app this time (headless Chrome over the demo build, Files tab, window shrunk
 * until things overflow): before, the split panes reported `overflowY: auto`
 * and were scroll containers nobody had asked for; after, `overflowY: hidden`
 * and the only vertical scroller left in that column is the column itself.
 *
 * The rule underneath: CSS has no one-axis overflow. `overflow-x: auto` alone
 * computes `overflow-y: auto` too, so anything that scrolls sideways is also a
 * vertical scroll container unless the other axis is spelled out. Every diff
 * pane scrolls sideways.
 */
describe("the diff pane scrolls sideways and nothing else", () => {
  test("both axes are spelled out, because setting one sets the other", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "components", "diff", "DiffLines.tsx"), "utf8");
    /* Four panes: unified, split-wrapped, and the split pair. The split's LEFT
       column was written this way from the start — its vertical scroll was
       always the right column's job — which is the shape the other three have
       now adopted. The fifth is the sticky rail that stands in for a pane's own
       scrollbar (see diff-hrail.test.ts): a proxy for a horizontal scroller is
       a horizontal scroller, and the same rule applies to it. */
    expect((src.match(/overflowX: "auto", overflowY: "hidden"/g) ?? []).length).toBe(5);
    // `overflow-auto` on a pane is the shape this replaced: it is both axes.
    expect(src).not.toContain("min-w-0 overflow-auto text-[12px]");
  });

  test("the pull request's file card wraps it in no scroller of its own", () => {
    const pr = readFileSync(join(import.meta.dir, "..", "src", "components", "PrPanel.tsx"), "utf8");
    expect(pr).not.toContain('<div className="flex" style={{ overflowX: "auto" }}>');
  });
});
