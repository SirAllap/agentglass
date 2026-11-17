/*
 * The address box's geometry: centred on the page, capped, kept off the edges.
 */
import { describe, expect, it } from "bun:test";
import { OMNI_GUTTER, OMNI_MAX, omniBox } from "../src/lib/omniBox.ts";

describe("omniBox", () => {
  it("caps at the max width and centres on a wide pane", () => {
    expect(omniBox(1600, 0)).toEqual({ left: (1600 - OMNI_MAX) / 2, width: OMNI_MAX });
  });

  it("centres on the page part, not under the side column", () => {
    const b = omniBox(1200, 300);
    expect(b.width).toBe(OMNI_MAX);
    expect(b.left + b.width / 2).toBe(450);
    expect(b.left + b.width).toBeLessThanOrEqual(900 - OMNI_GUTTER);
  });

  it("keeps the gutter on both sides of a narrow pane", () => {
    expect(omniBox(400, 0)).toEqual({ left: OMNI_GUTTER, width: 400 - 2 * OMNI_GUTTER });
  });

  it("never goes negative when the pane is smaller than the gutters", () => {
    expect(omniBox(20, 0).width).toBe(0);
    expect(omniBox(100, 300)).toEqual({ left: 0, width: 0 });
  });
});
