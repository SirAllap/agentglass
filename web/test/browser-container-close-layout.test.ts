/*
 * NO SECOND CONTROL IS DRAWN ON TOP OF ANOTHER.
 *
 * "The close button works but the UI, as always, is the worst: an ugly button
 * laid on top": the container row's × used to be laid over the chip, on top of the
 * name and the colour rail. It was fixed by giving it a cell of its own in the
 * row, and this is the lock that stops it being laid back over.
 *
 * Read off the rendered markup rather than off the source, because what went
 * wrong is a LAYOUT and the source can express the same layout twenty ways.
 * The row is one flex line with exactly two children: the chip, which takes
 * the space that is left, and the close cell, which takes exactly its own —
 * and that pair is the whole of not overlapping.
 *
 * The first version of this test finished with
 * `expect(html.match(…)).toBeDefined()`, and `String.match` answers `null`,
 * which IS defined: two of its three checks could not fail. Checked both ways
 * below — see the note on each.
 */
import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import React from "react";
import { BrowserView, __forceBrowser } from "../src/components/BrowserPanel";

const paint = () => {
  __forceBrowser(true);
  return renderToString(React.createElement(BrowserView, { active: true }));
};

/**
 * The container row, from its opening tag to the `</div>` that closes it.
 *
 * Found by walking to the end of the chip button first: the row's own closing
 * tag is the next one after that, and a plain non-greedy `[\s\S]*?</div>` stops
 * at the first `</div>` in the whole page instead.
 */
function containerRow(html: string): string | null {
  const at = html.indexOf('class="group flex items-stretch');
  if (at < 0) return null;
  const afterChip = html.indexOf("</button>", at);
  if (afterChip < 0) return null;
  const end = html.indexOf("</div>", afterChip);
  return end < 0 ? null : html.slice(at, end);
}

describe("the container row", () => {
  it("is drawn at all in the first paint", () => {
    /* Everything below reads this slice, so a row that stops being rendered
       has to fail here rather than silently pass three `not.toContain`s. */
    expect(containerRow(paint())).not.toBeNull();
  });

  it("gives the close control a cell of its own beside the chip", () => {
    const row = containerRow(paint())!;
    /* The chip takes what is left, the cell takes exactly its own width, and
       they are siblings on one line. Remove either half and the × has nowhere
       to be except on top of the name. */
    expect(row).toContain("flex items-stretch");
    expect(row).toContain("flex-1");
    expect(/class="[^"]*shrink-0[^"]*"[^>]*style="[^"]*width:2\dpx/.test(row)).toBe(true);
  });

  it("lays nothing over the name or the colour rail", () => {
    /* An absolutely positioned child inside this row IS the overlay this is
       about. Asserted on the row and not on the page, which has legitimate
       overlays elsewhere. */
    const row = containerRow(paint())!;
    expect(row).not.toContain("absolute");
  });

  it("keeps every close button big enough to hit", () => {
    /* The house minimum for an icon-only control is a 20×20 box — reported
       often enough to be a rule: "the icons come out ridiculously
       small". Read off every × on the page, because the row's own cell is a
       placeholder until a container is closable. */
    const html = paint();
    const sizes = [...html.matchAll(/class="agx-x[^"]*"[^>]*style="([^"]*)"/g)]
      .map((m) => Number(/width:(\d+)px/.exec(m[1] ?? "")?.[1] ?? 0));
    expect(sizes.length).toBeGreaterThan(0);
    for (const w of sizes) expect(w).toBeGreaterThanOrEqual(20);
    /* And the container's own ×, which is only drawn once a container can be
       closed and so never appears in this paint. It shares one constant with
       the placeholder that IS drawn, measured just above — which is the whole
       reason that constant exists. */
    expect(containerRow(html)).toContain("width:20px");
  });
});
