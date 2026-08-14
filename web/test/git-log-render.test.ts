/*
 * The log's graph column, as it is actually emitted.
 *
 * Written after shipping the same class of bug twice in one afternoon. The lane
 * maths had a suite and passed it every time; what was wrong was the BOX around
 * the drawing, which no unit test of the maths can see:
 *
 *   1. the SVG was a fixed 26px tall inside a card whose height comes from its
 *      own content, so the lines did not meet across rows;
 *   2. then it was absolutely positioned — correct, so it can fill whatever
 *      height the row turns out to be — inside a parent with no width. An
 *      absolutely positioned child gives its parent no width, so the column
 *      collapsed to nothing and the graph drew straight over the commit
 *      subjects. Reported in three words: "encima del texto no".
 *
 * Both are visible in the markup, so they are held here rather than by looking
 * at it again. No DOM: `renderToStaticMarkup` is enough to see a style
 * attribute, and the row builders are pure.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { commitRows, List } from "../src/components/git/Lists.tsx";

const LINES = [
  { hash: "aaa1111", parents: ["bbb2222"], subject: "fix(ci): defend the budget floor", author: "Ana", date: "2 days ago", graph: "" },
  { hash: "bbb2222", parents: ["ccc3333", "ddd4444"], subject: "Merge pull request #17561 from acme/ORBIT-1042-record", author: "Ana", date: "2 days ago", graph: "" },
  { hash: "ccc3333", parents: [], subject: "chore: the first one", author: "Ana", date: "3 days ago", graph: "" },
];

const draw = () => renderToStaticMarkup(
  React.createElement(List, {
    rows: commitRows(LINES, { picked: new Set<string>(), run: () => {} }),
    cursor: 0, onCursor: () => {}, onMenu: () => {}, what: "commits", measure: 1180,
  }),
);

describe("the graph column", () => {
  test("reserves its width, so the drawing never lands on the text", () => {
    /* The exact failure: an absolutely positioned SVG in a parent with no
       width. The wrapper has to carry a pixel width of its own or the subject
       starts at x=0 and the lanes run across it. */
    const html = draw();
    expect(html).toMatch(/<span[^>]*style="[^"]*width:\d+px/);
  });

  test("fills the row's height rather than assuming one", () => {
    // A fixed pixel height is the first version of this bug: rows are as tall as
    // their content and as the app's UI scale says, and a drawing that is 26px
    // in a 34px row leaves a gap between one row's lines and the next's.
    const html = draw();
    expect(html).toContain('height:100%');
    expect(html).toContain('preserveAspectRatio="none"');
  });

  test("draws a line for every commit and a dot for each", () => {
    const html = draw();
    expect((html.match(/<path /g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((html.match(/<circle /g) ?? []).length).toBe(LINES.length);
  });

  test("keeps the subject in the row, not in the drawing", () => {
    // The subject is what the reader came for; if it ever ends up inside the
    // SVG it is because the graph has been put back into the title again.
    const html = draw();
    const svgEnd = html.indexOf("</svg>");
    expect(html.slice(0, svgEnd)).not.toContain("defend the budget floor");
    expect(html).toContain("defend the budget floor");
  });

  test("gives the log a line, not a card", () => {
    /* The card's border and 4px gap are what cut the graph five hundred times.
       If a log row ever comes back with `git-card` on it, the gutter is being
       chopped again. */
    const html = draw();
    expect(html).toContain("git-line");
    expect(html).not.toContain("git-card");
  });
});
