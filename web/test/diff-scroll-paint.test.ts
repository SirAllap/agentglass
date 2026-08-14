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

  test("the text column absorbs the slack rather than stopping at its own text", () => {
    /* `max-content` alone was the bug in the unified pane: the column is as wide
       as the longest line in THAT hunk, and the row's background ends there. */
    const html = uni(false);
    expect(html).toContain("minmax(max-content,1fr)");
    expect(html).not.toMatch(/grid-template-columns:4ch 4ch max-content/);
  });

  test("a split row is at least as wide as the column it sits in", () => {
    expect(split(false)).toContain("width:max-content;min-width:100%");
  });

  test("wrapped mode does not scroll sideways, so it keeps its fr columns", () => {
    // Nothing to fix here, and pinned so the fix above does not spread into it:
    // wrapping means there is no overflow to paint into.
    expect(uni(true)).toContain("4ch 4ch minmax(0,1fr)");
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
