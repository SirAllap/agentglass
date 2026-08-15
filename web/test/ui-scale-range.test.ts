/*
 * How far the window's own zoom goes, and how it gets there.
 *
 * Asked for after a day on a big screen: up to 200%, and down to 70%. The old
 * ladder stopped at 150% because the 12-column grid folds below 1280 CSS px and
 * the ceiling kept a maximised window on the wide layout always. That is a real
 * trade and it is his to make — at 200% on a 2560px screen the layout folds,
 * which is the layout doing its job.
 */
import { describe, expect, it } from "bun:test";
import { SCALES, DEFAULT_SCALE, fmtScale } from "../src/lib/uiScale.ts";

describe("the rungs the window zooms through", () => {
  it("reaches 200% and 70%, which is what was asked for", () => {
    expect(SCALES[SCALES.length - 1]).toBe(2);
    expect(SCALES[0]).toBe(0.7);
  });

  it("is sorted, because nudging walks it by index", () => {
    // `nudgeScale` moves one position, so an unsorted ladder would step to a
    // smaller scale on the way up.
    expect([...SCALES].sort((a, b) => a - b)).toEqual(SCALES);
  });

  it("has no duplicates, or a rung would take two presses to leave", () => {
    expect(new Set(SCALES).size).toBe(SCALES.length);
  });

  it("still contains 100%, which is where reset goes", () => {
    // `resetScale` snaps to DEFAULT_SCALE; a default off the ladder would land
    // somewhere else entirely.
    expect(SCALES).toContain(DEFAULT_SCALE);
  });

  it("steps small near 100% and coarse at the ends", () => {
    /* Where you actually live is 90–125%, and a step there should be a nudge;
       past 150% you are making a deliberate jump. Checked as a rule rather than
       as a list, so a future rung has to obey it too. */
    const gaps = SCALES.slice(1).map((s, i) => Math.round((s - SCALES[i]!) * 100) / 100);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(0.25);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(0.1);
  });

  it("reads as a percentage a person recognises", () => {
    expect(SCALES.map(fmtScale)).toEqual(["70%", "80%", "90%", "100%", "110%", "125%", "140%", "150%", "175%", "200%"]);
  });
});
