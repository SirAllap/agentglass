/*
 * The bar a pane keeps under its own bottom edge.
 *
 * What stood here before was a 2×2 block of icon-only doors in the pane's
 * corner. It reached the right pane — that was the point, and it worked — but
 * four glyphs cannot say WHICH pull request or WHICH card they open, and every
 * attempt to add that inside the block turned the corner of a terminal into a
 * paragraph. "We no longer need the drawer, just the bar."
 *
 * So: a seam across the pane's foot, and a bar that rises out of it when the
 * pointer is there. Three halves are tested — the arithmetic that finds a
 * pane's foot on a rectangle of character cells, the cut that keeps a branch
 * name readable at any width, and the bar itself.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { paneFoot } from "../src/lib/paneBox.ts";
import { PaneBar, midCut, BAR_MIN_H, BAR_MIN_W, SEAM_ZONE } from "../src/components/terminal/PaneBar.tsx";

/** A 100×40 terminal, 10px per column and 20px per row, sitting at 0,0. */
const SCREEN = { left: 0, top: 0, width: 1000, height: 800 };
const SLOT = { left: 0, top: 0, width: 1000, height: 800 };
const GRID = { cols: 100, rows: 40 };

describe("finding a pane's foot", () => {
  test("the pane's own bottom edge, not the terminal's", () => {
    // The top-left pane of a 2×2 split: cells 0–49 across, 0–19 down.
    const foot = paneFoot({ screen: SCREEN, slot: SLOT, ...GRID, pane: { left: 0, top: 0, right: 49, bottom: 19 } });
    expect(foot).toEqual({ left: 0, top: 400, width: 500 });
  });

  test("`bottom` is the LAST row the pane owns, not the first one after it", () => {
    /* Reading it raw drew the bar a whole character inside the pane, which
       reads as a misalignment rather than as an off-by-one. */
    const foot = paneFoot({ screen: SCREEN, slot: SLOT, ...GRID, pane: { left: 50, top: 20, right: 99, bottom: 39 } });
    expect(foot).toEqual({ left: 500, top: 800, width: 500 });
  });

  test("no tmux, no panes: the whole terminal is the pane", () => {
    const foot = paneFoot({ screen: SCREEN, slot: SLOT, ...GRID, pane: null });
    expect(foot).toEqual({ left: 0, top: 800, width: 1000 });
  });

  test("the screen's offset inside the slot is carried, borders and all", () => {
    // In a split the slot wears a 1px border, so the two boxes are not the same.
    const foot = paneFoot({
      screen: { left: 11, top: 7, width: 1000, height: 800 },
      slot: { left: 10, top: 5, width: 1002, height: 802 },
      ...GRID, pane: { left: 0, top: 0, right: 49, bottom: 19 },
    });
    expect(foot).toEqual({ left: 1, top: 402, width: 500 });
  });

  test("a pane wider than the slot is clamped to it", () => {
    const foot = paneFoot({ screen: SCREEN, slot: { left: 0, top: 0, width: 300, height: 800 }, ...GRID, pane: null });
    expect(foot.width).toBe(300);
  });
});

describe("cutting the branch name", () => {
  const B = "ORBIT-1042-invoices-not-clearing-when-archived";

  test("a name that fits is left alone", () => {
    expect(midCut(B, 80)).toBe(B);
  });

  test("what is cut is the MIDDLE — the tail is what names the work", () => {
    const cut = midCut(B, 30);
    expect(cut.length).toBeLessThanOrEqual(30);
    expect(cut).toContain("…");
    expect(cut.endsWith("-when-archived")).toBe(true);
    expect(cut.startsWith("ORBIT-1042")).toBe(true);
  });

  test("a box too small to hold even the tail keeps the name whole", () => {
    // Better an overflowing name than "…-when-archived" on every pane.
    expect(midCut(B, 12)).toBe(B);
  });
});

const FOOT = { left: 100, top: 400, width: 700 };
const draw = (p: Partial<Parameters<typeof PaneBar>[0]> = {}) =>
  renderToStaticMarkup(React.createElement(PaneBar, {
    foot: FOOT, near: false, branch: "orbit-1049-break-times", dirty: 0,
    onDown: () => {}, onGit: () => {}, onDiff: () => {}, onCopy: () => {},
    ...p,
  } as never));

describe("the bar", () => {
  test("the branch, its copy and the changes are always there", () => {
    const bare = draw();
    expect(bare).toContain("orbit-1049-break-times");
    expect(bare).toContain("Copy branch name");
    expect(bare).toContain("File changes");
  });

  test("the pull request and the card only when they lead somewhere", () => {
    /* A control that is always refused is worse than no control: a branch with
       no pull request gets no pull-request button. */
    expect(draw()).not.toContain("#1249");
    const full = draw({
      pr: { number: 1249, title: "Break times", changes: false }, onPr: () => {},
      card: { label: "ORBIT-1049", prio: "high", inApp: true }, onCard: () => {},
    });
    expect(full).toContain("#1249");
    expect(full).toContain("ORBIT-1049");
  });

  test("the card wears its priority as a colour", () => {
    const urgent = draw({ card: { label: "ORBIT-1049", prio: "urgent", inApp: true }, onCard: () => {} });
    expect(urgent).toContain("var(--error)");
    const none = draw({ card: { label: "ORBIT-1049", prio: null, inApp: true }, onCard: () => {} });
    expect(none).toContain("var(--info)");
  });

  test("closed, it is under the pane's edge and takes no pointer events", () => {
    const shut = draw();
    expect(shut).toContain('data-open="0"');
    expect(shut).toContain("pointer-events:none");
    // Pushed DOWN out of the pane rather than merely faded: a transparent bar
    // over the last rows still intercepts a drag.
    expect(shut).toMatch(/translateY\(\d+px\)/);
  });

  test("open, it is up and clickable, and centred on the pane", () => {
    const up = draw({ near: true });
    expect(up).toContain('data-open="1"');
    expect(up).toContain("translateY(0)");
    // Centred by the row it sits in, which is exactly as wide as the pane.
    expect(up).toContain("justify-center");
  });

  test("the bar is never wider than the pane it belongs to", () => {
    // A split puts two of these on screen at half the width, and a bar that
    // overhangs is a bar sitting on its neighbour.
    expect(draw()).toContain(`max-width:${FOOT.width - 16}px`);
  });

  test("the seam is decorative: at rest the terminal keeps every click", () => {
    /* The whole point of a seam over a chevron — his: "es sencillo y claro" —
       is that it costs nothing. It is `pointer-events: none`, and the pane slot
       reports the pointer instead (see nearFoot in TerminalPanel). */
    const src = readFileSync(new URL("../src/components/terminal/PaneBar.tsx", import.meta.url), "utf8");
    const seam = src.slice(src.indexOf("data-pane-seam"), src.indexOf("data-pane-bar"));
    expect(seam).toContain("pointer-events-none");
    expect(seam).toContain("linear-gradient(90deg");
    // And the zone you have to be in is taller than the line you can see.
    expect(SEAM_ZONE).toBeGreaterThan(4);
  });

  test("leaving is forgiven for a moment", () => {
    const src = readFileSync(new URL("../src/components/terminal/PaneBar.tsx", import.meta.url), "utf8");
    expect(src).toContain("p.grace ?? 400");
    // Held open while the pointer is on the bar itself, so the trip from the
    // seam to a button never closes it.
    expect(src).toContain("const want = p.near || held;");
  });

  test("the seam clears the bottom line of output", () => {
    /* Twice reported, twice with a screenshot: the line went through the
       descenders of whatever the shell had just printed. It is 3px, and it
       hangs UNDER the foot it is given — which is the slot's edge rather than
       the screen's when the pane reaches the bottom (see paneFoot), so the
       strip it sits in is the one xterm cannot draw rows in. */
    const shut = draw();
    expect(shut).toContain(`top:${FOOT.top - 3}px`);
    expect(shut).toContain("height:3px");
  });

  test("and the foot it is given is the pane's edge, not the last row's", () => {
    // The pixels between the last row and the pane's border, which xterm cannot
    // draw a row in.
    const foot = paneFoot({
      screen: { left: 0, top: 0, width: 1000, height: 790 },
      slot: { left: 0, top: 0, width: 1000, height: 1600 },
      cols: 100, rows: 39, pane: null, edge: 803,
    });
    expect(foot.top).toBe(803);
  });

  test("the top half of a split hangs from ITS edge, not the grid's", () => {
    /* The coordinate space is the whole grid — that is where the bar is drawn —
       so reading its height as "the bottom" would put the top pane's bar inside
       the pane underneath. */
    const foot = paneFoot({
      screen: { left: 0, top: 0, width: 1000, height: 390 },
      slot: { left: 0, top: 0, width: 1000, height: 800 },
      cols: 100, rows: 39, pane: null, edge: 396,
    });
    expect(foot.top).toBe(396);
  });

  test("a pane with something under it still hangs from its own edge", () => {
    // Half a split: the strip under THIS pane belongs to the pane below it.
    const foot = paneFoot({ screen: SCREEN, slot: { left: 0, top: 0, width: 1000, height: 812 }, ...GRID, pane: { left: 0, top: 0, right: 99, bottom: 19 } });
    expect(foot.top).toBe(400);
  });

  test("the keyboard's copy is answered by the bar itself", () => {
    /* No toast over a terminal, and nothing typed into the shell — that would
       be a line in somebody's command history. The bar comes up with a green
       tick, so what you are told is WHICH branch was copied. */
    const src = readFileSync(new URL("../src/components/terminal/PaneBar.tsx", import.meta.url), "utf8");
    expect(src).toContain("const on = want || linger || shout;");
    expect(src).toContain("setTimeout(() => setShout(false), 1500)");
    expect(src).toContain("color: copied || shout ?");
    const term = readFileSync(new URL("../src/components/TerminalPanel.tsx", import.meta.url), "utf8");
    // A stamp, not a boolean: two copies in a row are two answers.
    expect(term).toContain("setCopyFlash(Date.now());");
  });

  test("the seam follows the focused pane, and stands down under a popup", () => {
    /* Two ways this feature has disappeared, and they pull in opposite
       directions. It was drawn only under the pointer, so moving the pointer
       off the terminal took it off the screen — that one is fixed by following
       the focused pane. And it kept being drawn under a tmux popup, a line
       across somebody's scratch: "from the scratch, that bar of the panes
       underneath gets activated". A popup is painted INTO this screen, so the only
       right answer there is to stand down. */
    const term = readFileSync(new URL("../src/components/TerminalPanel.tsx", import.meta.url), "utf8");
    expect(term).toContain("const idx = actionsIdx ?? focusIdx;");
    // A popup stops the bar from OPENING; it does not take the seam away. The
    // seam is 3px at the pane's edge and the only thing on screen that says the
    // pane has a bar at all, and the popup signal can be true with nothing on
    // screen — measured on his machine, twice.
    /* Nothing of ours is drawn while a popup is up — seam included. A popup is
       painted INTO this screen, so a 3px line "at the pane's edge" is a line
       across somebody's scratch: reported twice, the second time with the
       gradient running through the popup's own text. */
    const bar = readFileSync(new URL("../src/components/terminal/PaneBar.tsx", import.meta.url), "utf8");
    expect(bar).toContain("if (p.blocked) return null;");
    expect(term).toContain("blocked={!!sess?.tmuxPopup}");
  });

  test("\"Reading this pane…\" cannot outlive the read", () => {
    /* It said so for twenty minutes on a pane that had been read long before:
       the scan of the pane's buffer is outside the try that guarded the
       server call, and a throw there skipped the one line that takes the
       spinner down. */
    const term = readFileSync(new URL("../src/components/TerminalPanel.tsx", import.meta.url), "utf8");
    expect(term).toContain("try { await readOnce(); } finally { if (!stopped) setWtDetecting(false); }");
    // And it says which of the two states it is in, rather than "reading" for
    // a read that came back empty — or, worse, nothing at all.
    expect(term).toContain('note={wtDetecting');
    // And a pane in a checkout nobody scanned says WHERE it is, rather than
    // claiming there is nothing behind it.
    expect(term).toContain("no repo scanned here");
  });

  test("the bar cannot widen the document, and nothing has to be clipped", () => {
    /* Two bugs, one shape. The plate used to BE the positioned box, centred
       with a -50% transform — which moves pixels, not the layout box, so its
       right edge sat half a pane past where it looked and every view in the app
       grew a horizontal scrollbar. Clipping the grid fixed that and cut the
       last line of every terminal pane, because xterm's viewport overhangs its
       box by the remainder of a cell. A wrapper as wide as the pane needs
       neither trick. */
    const up = draw({ near: true });
    expect(up).toContain(`left:${FOOT.left}px;width:${FOOT.width}px`);
    expect(up).toContain("translateY(0)");
    expect(up).not.toContain("translate(-50%");
    const term = readFileSync(new URL("../src/components/TerminalPanel.tsx", import.meta.url), "utf8");
    expect(term).toContain('ref={wrapRef} className="flex-1 min-h-0 relative"');
  });

  test("a pane with no room to give is left alone", () => {
    // The bar plus a gap plus enough prompt to still be reading.
    expect(BAR_MIN_H).toBeGreaterThan(60);
    expect(BAR_MIN_W).toBeGreaterThan(200);
  });
});
