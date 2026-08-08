/*
 * Markdown as a person reads it, not as a parser accepts it.
 *
 * `markdown-safety.test.ts` pins what the renderer must refuse. This pins the
 * other half — whether the output is worth reading — because every failure in
 * this file renders, validates and type-checks, and still puts a wall of text
 * on screen where the author wrote structure.
 *
 * It exists because the same automation comment was put side by side with
 * GitHub's rendering of it and ours read much worse: headings that weighed the
 * same as prose, a nested list that came out flush left, and blocks packed
 * tight enough that the sections ran together. None of that is a parse error,
 * so nothing in the suite noticed.
 *
 * There is no DOM here (bun test, no jsdom), so the component is rendered to
 * static markup exactly like `file-rail-view.test.ts` does. The Markdown
 * component holds no state and runs no effects, so the markup IS the component
 * — and the spacing it carries is Tailwind utilities and inline styles, both of
 * which are in that markup and can be read back out.
 *
 * The fixtures are invented. They have the SHAPE of the comment that was
 * compared — a bold lead-in over a stats line, screaming-caps severity
 * headings, a list whose items wrap and nest — and none of its words.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/lib/markdown.tsx";
import { contrast, parseColor } from "../src/lib/contrast.ts";

const render = (text: string): string => renderToStaticMarkup(React.createElement(Markdown, { text }));

/** One tag's opening, with its attributes. `<p` would also match `<pre`, and
 *  the code block is a `<pre>` sitting right beside the paragraphs. */
const open = (html: string, tag: string): string => {
  const m = html.match(new RegExp(`<${tag}(?=[\\s>])[^>]*>`));
  return m ? m[0] : "";
};

/**
 * A Tailwind spacing utility, in pixels.
 *
 * The scale is 4px per step (`my-1.5` is 6px), and the reason to convert rather
 * than to assert the class name is that a test spelling `my-2.5` is a test of a
 * string. What the reader gets is a distance, and a distance can be compared
 * with the one next to it — which is the whole claim these tests make.
 */
const space = (cls: string, prop: "my" | "mt" | "mb" | "gap"): number => {
  // The boundary allows a quote as well as whitespace: the utility being read
  // is as often the first class in `class="…"` as it is the fourth, and a
  // `(?:^|\s)` prefix silently returned zero for every element whose spacing
  // happened to be written first. Zero is a passing number for half of these
  // comparisons, which is exactly the kind of green a spacing test must not be.
  const m = cls.match(new RegExp(`(?:^|[\\s"])${prop}-(\\d+(?:\\.\\d+)?)(?:[\\s"]|$)`));
  return m ? Number(m[1]) * 4 : 0;
};

/** What a heading falls back to when the surface sets no `--agx-md-hN`. The
 *  variable is the seam a document viewer uses for its own scale; the fallback
 *  is what chat, the release notes and the settings modal actually render. */
const headingFallback = (html: string, lvl: number): number => {
  const m = html.match(new RegExp(`var\\(--agx-md-h${lvl},\\s*([\\d.]+)em\\)`));
  return m ? Number(m[1]) : 0;
};

// ---------------------------------------------------------------------------

describe("a lone newline inside a paragraph", () => {
  /*
   * GitHub renders comment bodies with hard breaks on, so a bold lead-in and
   * the stats line under it are two lines. Ours must not run them together.
   *
   * Answered with `whitespace-pre-wrap` and a real newline rather than with a
   * `<br>`, and that is deliberate: the document viewer sets
   * `.agx-prose p { white-space: normal }` so that a README wrapped at column
   * 80 is not reproduced as somebody else's window. A `<br>` element is not
   * undone by a white-space rule, so emitting one would take that seam away.
   */
  const LEAD = "**Widget Audit Summary**\n2 critical. 3 high. 6 medium.";

  test("the two lines stay two lines", () => {
    const html = render(LEAD);
    expect(html).toContain("</strong>\n2 critical.");
    expect(open(html, "p")).toContain("whitespace-pre-wrap");
  });

  test("and a blank line still starts a paragraph of its own", () => {
    // The control: if every newline became a break, the block structure would
    // be carried by whitespace alone and nothing would ever be a new block.
    expect(render("first\n\nsecond").split("<p").length - 1).toBe(2);
  });
});

describe("the bullet", () => {
  const LIST = "- first finding\n- second finding";

  test("every item draws one", () => {
    const html = render(LIST);
    expect(html.split("•").length - 1).toBe(2);
  });

  test("in an ink you can actually see it in", () => {
    /*
     * `t-dim2` is `--text4`, the palette's dimmest tier — floored at 4:1 by
     * `floorTiers`, which is the budget for a timestamp or a count in the
     * corner of a tile. A bullet is not metadata: it is the mark the reader
     * counts the items by, and at 4.1:1 on the default theme it was a smudge
     * where GitHub draws a dot. `--text3` is the tier floored at 5:1.
     */
    const html = render(LIST);
    expect(html).not.toContain("t-dim2");
    // Measured, not asserted by name: the default theme's own values.
    const bullet = parseColor("#8b949e")!;  // --text3
    const bg = parseColor("#0d1117")!;      // --bg
    expect(contrast(bullet, bg)).toBeGreaterThan(5);
  });
});

describe("a list with air in it", () => {
  /*
   * The shape a review bot actually writes: a blank line between items, and a
   * sub-list under one of them. Markdown calls this a "loose" list and it is
   * still ONE list.
   *
   * What it used to do: the item loop stopped at the first blank line, so this
   * came out as four separate `<ul>`s — and because depth is worked out from
   * the distinct indents present in the list being built, the sub-list was a
   * list of its own whose only indent was therefore its zero. Both nested
   * items rendered flush against their parent. The nesting the author typed
   * was on screen as no nesting at all.
   */
  const LOOSE = [
    "- The retry helper swallows the first error.",
    "",
    "- The widget cache keeps two clocks:",
    "",
    "  - one taken from the request",
    "  - one taken from the row",
    "",
    "- The final finding.",
  ].join("\n");

  test("a blank line between items does not start a new list", () => {
    expect(render(LOOSE).split("<ul").length - 1).toBe(1);
  });

  test("and the sub-list is still indented under the item it belongs to", () => {
    const html = render(LOOSE);
    const indents = [...html.matchAll(/margin-left:(\d+)(?:px)?/g)].map((m) => Number(m[1]));
    expect(indents).toHaveLength(5);
    // Four at the top level, two of them stepped in — and the step is the same
    // for both, because they are the same depth.
    expect(indents.filter((n) => n === 0)).toHaveLength(3);
    const stepped = indents.filter((n) => n > 0);
    expect(stepped).toHaveLength(2);
    expect(new Set(stepped).size).toBe(1);
  });

  test("a tight list is still one list, and three levels still step three times", () => {
    // The control on both fixes: the ordinary case must not have changed, and
    // depth must come from the order of the indents rather than from dividing
    // by a number nobody agreed on.
    const html = render("- one\n  - two\n    - three\n- back");
    expect(html.split("<ul").length - 1).toBe(1);
    const indents = [...html.matchAll(/margin-left:(\d+)(?:px)?/g)].map((m) => Number(m[1]));
    expect(new Set(indents).size).toBe(3);
    expect(Math.max(...indents)).toBeGreaterThan(Math.min(...indents));
  });

  test("prose after a blank line still ends the list", () => {
    // The other half of the loose-list rule: only another item may reach across
    // the gap. A paragraph after a list is a paragraph, not a fifth bullet.
    const html = render("- one\n\nA sentence that follows the list.\n\n- two");
    expect(html.split("<ul").length - 1).toBe(2);
    expect(html).toContain("A sentence that follows");
  });

  test("a wrapped item keeps its continuation, and does not become its own", () => {
    const html = render("- a finding long enough that the author\n  wrapped it onto a second line\n- the next one");
    expect(html.split("•").length - 1).toBe(2);
    expect(html).toContain("wrapped it onto a second line");
  });
});

describe("a heading that reads as one", () => {
  /*
   * "CRITICAL", "HIGH", "MEDIUM" over their findings. On GitHub they are
   * headings; here they were `1em` and bold, which against bold prose is
   * nothing — the severity bands read as another paragraph and the reader had
   * to find the boundaries by content.
   *
   * The size stays a variable the SURFACE sets. Only the fallback moved, which
   * is what every surface that sets nothing — chat, the release notes, the
   * settings modal — actually renders.
   */
  const DOC = "Some prose first.\n\n### MEDIUM\n\nThe finding under it.";

  test("the fallback scale is a ladder, not a flat 1em", () => {
    for (const [lvl, want] of [[1, 1.08], [2, 1.08], [3, 1], [4, 1]] as const) {
      void want;
      expect(headingFallback(render(`${"#".repeat(lvl)} A heading`), lvl)).toBeGreaterThan(0);
    }
    const h = (lvl: number) => headingFallback(render(`${"#".repeat(lvl)} A heading`), lvl);
    expect(h(1)).toBeGreaterThan(h(2));
    expect(h(2)).toBeGreaterThan(h(3));
    expect(h(3)).toBeGreaterThan(1);
    expect(h(4)).toBe(1);
  });

  test("the surface can still overrule every level of it", () => {
    // The seam: the document viewer's own scale lives in `--agx-md-h1..h4`, and
    // an inline size with no variable in it would beat any stylesheet.
    for (const lvl of [1, 2, 3, 4]) {
      expect(render(`${"#".repeat(lvl)} A heading`)).toContain(`var(--agx-md-h${lvl},`);
    }
  });

  test("it carries air above it, and belongs to what follows", () => {
    const head = open(render(DOC), "h3");
    const para = open(render(DOC), "p");
    // More space over a heading than between two paragraphs, or it does not
    // separate the sections it names.
    expect(space(head, "mt")).toBeGreaterThan(space(para, "my"));
    // And less under it than over it: the gap is what ties the heading to the
    // block it introduces rather than to the one it ended.
    expect(space(head, "mb")).toBeLessThan(space(head, "mt"));
  });

  test("a heading that opens the message keeps no space above it", () => {
    expect(open(render("# Title\n\nbody"), "h1")).toContain("first:mt-0");
  });
});

describe("the space between blocks, which is what makes it readable", () => {
  /*
   * The gap the whole comparison came down to. GitHub gives a paragraph a full
   * line of air (16px on 14px text); ours gave it 6, and at six pixels a
   * heading, its paragraph and the list under it are one grey mass.
   *
   * Checked at both ends, because this component is global. In a 320px column
   * — the chat panel and the phone — a paragraph is two or three lines and 10px
   * between them is one clear break without turning four findings into a scroll.
   * In the document viewer `.agx-prose` overrides these with its own 0.85em, so
   * a wide document is unaffected by the numbers here and keeps its seam.
   */
  const DOC = ["A paragraph.", "", "- an item", "- another", "", "> a quotation", "", "```ts", "const x = 1;", "```", "", "---", "", "The end."].join("\n");

  test("a paragraph gets a real gap, not a hairline", () => {
    expect(space(open(render(DOC), "p"), "my")).toBeGreaterThanOrEqual(10);
  });

  test("a list breathes with the prose around it, and its items with each other", () => {
    const ul = open(render(DOC), "ul");
    expect(space(ul, "my")).toBeGreaterThanOrEqual(10);
    expect(space(ul, "gap")).toBeGreaterThan(4);
  });

  test("a quotation and a code block are not tighter than the prose", () => {
    const html = render(DOC);
    const p = space(open(html, "p"), "my");
    expect(space(open(html, "blockquote"), "my")).toBeGreaterThanOrEqual(p);
    expect(space(open(html, "pre"), "my")).toBeGreaterThanOrEqual(p);
  });

  test("a rule gets the most, because it is the biggest thing an author can say", () => {
    const html = render(DOC);
    expect(space(open(html, "hr"), "my")).toBeGreaterThan(space(open(html, "p"), "my"));
  });

  test("the first and last blocks stay flush with their container", () => {
    // The other half of more air: a bubble that pads itself must not gain a
    // stripe of margin at the top and bottom of every message.
    const html = render(DOC);
    expect(open(html, "p")).toContain("first:mt-0");
    expect(open(html, "p")).toContain("last:mb-0");
  });
});
