/*
 * The two headers on this panel start on the same line and must end on it.
 *
 * The rail's filter box and the table's column titles sit side by side, so a
 * few pixels between the rules under them runs the whole width of the panel.
 * They took their heights from different places and drifted.
 *
 * This file exists because of HOW that was got wrong the first time, not
 * because the alignment is hard: the edit that was supposed to set the table's
 * height used a plain string replace, the string had already been changed by
 * the edit before it, and the replace did nothing — silently. Shipped, and
 * reported back with a screenshot. A test that counts both ends is what turns
 * that class of miss into a red suite.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();

describe("the rail header and the table header", () => {
  it("both take their height from the same constant", () => {
    // Two uses, not one. One is the miss that got shipped.
    expect(src.match(/height: HEAD_H/g)?.length).toBe(2);
  });

  it("declares that constant once", () => {
    expect(src.match(/^const HEAD_H = \d+;$/m)?.length).toBe(1);
  });

  it("gives neither of them padding that would fight it", () => {
    /* `py-1` plus a fixed height is a box that is one of the two depending on
       box-sizing, and it is the shape the table header had while it was
       drifting. */
    const head = src.slice(src.indexOf('uppercase tracking-[0.16em] sticky top-0'), src.indexOf("agx-stick-head"));
    expect(head).not.toContain("py-1");
    expect(head).toContain('alignItems: "center"');
  });

  it("stops the table header carrying a rule the rail does not", () => {
    // A top border on one of two side-by-side headers is a line that starts
    // halfway across the panel.
    const head = src.slice(src.indexOf('uppercase tracking-[0.16em] sticky top-0'), src.indexOf("agx-stick-head"));
    expect(head).not.toContain("borderTop");
    expect(head).toContain("borderBottom");
  });
});
