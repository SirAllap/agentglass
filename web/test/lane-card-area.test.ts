/**
 * A lane never scrolls sideways, and its first card's ring is not cut.
 *
 * Measured on the board: a lane is 359px (the 336px card, 8px of air each side and the 7px bar) and its card area
 * scrolls down. The 7px vertical bar takes its width out of the content box, so the area was 345px
 * wide holding 352px: it grew a horizontal bar under the cards and clipped the card. Only the board
 * scrolls sideways, lane to lane. The selected ring is 4px of spread drawn outside the card, and the
 * area's first child is that card, flush with the top edge: the top of the ring was cut.
 * Asserted on the stylesheet, since there is no renderer here.
 */
import { describe, expect, it } from "bun:test";
import { LANE_WIDTH_PX } from "../src/lib/prSearch.ts";

const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
const rule = (sel: string) => {
  const at = css.indexOf(`${sel} {`);
  expect(at).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
};
const num = (re: RegExp, s: string) => Number(s.match(re)?.[1]);

describe("the lane's card area", () => {
  const area = rule(".agx-pl > .overflow-y-auto");
  const lane = rule(".agx-pl");
  it("scrolls on Y only and keeps the bar's room, so the bar never takes the card's", () => {
    expect(area).toContain("overflow-x: hidden");
    expect(area).toContain("scrollbar-gutter: stable");
  });
  it("is as wide as card + air + the bar, by tokens", () => {
    const pad = num(/--lane-pad:\s*(\d+)px/, lane), sb = num(/--lane-sb:\s*(\d+)px/, lane);
    expect(area).toContain("padding-left: var(--lane-pad)");
    expect(area).toContain("padding-right: var(--lane-pad)");
    // content box = lane - left pad - right pad - gutter(sb)
    expect(LANE_WIDTH_PX - 2 * pad - sb).toBe(336);
    expect(sb).toBe(7);
    // The ring spreads 4px past the card: the air before the bar is that and 4px more.
    expect(pad).toBeGreaterThanOrEqual(4 + 4);
  });
  it("leaves room above the first card for its ring (4px spread) and halo", () => {
    const ring = num(/--lane-ring:\s*(\d+)px/, lane);
    const spread = num(/0 0 0 (\d+)px color-mix\(in srgb, var\(--st\) 20%/, css);
    expect(spread).toBe(4);
    expect(ring).toBeGreaterThanOrEqual(spread);
    expect(area).toContain("padding-top: var(--lane-ring)");
  });
});
