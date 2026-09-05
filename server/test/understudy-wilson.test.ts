/*
 * The number that decides whether the understudy is ever offered a promotion.
 *
 * A class is only put forward as guided when three things hold at once: at
 * least 80 scored decisions, a raw agreement of at least 0.70, and a Wilson
 * lower bound of at least 0.60. The first two are arithmetic anybody can check
 * by eye; the third is the one that can be wrong in the fourth decimal and look
 * right, which is why the boundary rows below are pinned to four places rather
 * than merely compared against the threshold.
 *
 * The pair at 80 is the whole argument for using the bound at all. 56 of 80 is
 * exactly 0.70 raw — it passes the ratio gate — and its bound is 0.5923, so it
 * is refused. One more agreement, 57 of 80, and the bound clears 0.60. If these
 * two ever swap sides, a class gets promoted on a sample that has not earned
 * it, and nothing else in the feature would notice.
 */
import { describe, expect, test } from "bun:test";
import { wilsonLower } from "../../shared/wilson.ts";

/** Four places is the precision the thresholds are argued at. */
const at4 = (x: number) => Number(x.toFixed(4));

describe("the promotion boundary", () => {
  test("56 of 80 passes the raw ratio and still fails the bound", () => {
    expect(56 / 80).toBeGreaterThanOrEqual(0.7); // the gate it clears
    expect(at4(wilsonLower(56, 80))).toBe(0.5923);
    expect(wilsonLower(56, 80)).toBeLessThan(0.6); // the gate it does not
  });

  test("57 of 80 is the first row that clears 0.60", () => {
    expect(at4(wilsonLower(57, 80))).toBe(0.6054);
    expect(wilsonLower(57, 80)).toBeGreaterThanOrEqual(0.6);
  });

  test("120 of 150 is 0.7289", () => {
    // A sample well past the threshold, kept as a third fixed point so a change
    // that shifted the whole curve while preserving the boundary would fail.
    expect(at4(wilsonLower(120, 150))).toBe(0.7289);
  });
});

describe("what the bound is for", () => {
  test("a tiny perfect record loses to a large imperfect one", () => {
    // Three for three is 1.00 raw and means nothing. This is the entire reason
    // the scorecard's gate is the bound and not the ratio.
    expect(wilsonLower(3, 3)).toBeLessThan(wilsonLower(120, 150));
    expect(at4(wilsonLower(3, 3))).toBe(0.4385);
  });

  test("the same ratio earns more as the sample grows", () => {
    const ratio = [wilsonLower(7, 10), wilsonLower(70, 100), wilsonLower(700, 1000)];
    expect(ratio[0]!).toBeLessThan(ratio[1]!);
    expect(ratio[1]!).toBeLessThan(ratio[2]!);
    // …and never reaches the ratio itself, however large it gets.
    for (const lb of ratio) expect(lb).toBeLessThan(0.7);
  });

  test("a wider z is more pessimistic, not less", () => {
    // The default 1.96 is the two-sided 95% interval. If z ever stopped moving
    // the bound downward, the argument would be inverted somewhere.
    expect(wilsonLower(120, 150, 3)).toBeLessThan(wilsonLower(120, 150));
    expect(at4(wilsonLower(120, 150, 3))).toBe(0.6863);
  });

  test("nothing observed has earned nothing", () => {
    // 0/0 is the one input where the arithmetic is NaN rather than pessimistic,
    // and a NaN compared against a threshold is false whichever way the caller
    // wrote the comparison — so it would pass or fail silently by accident.
    expect(wilsonLower(0, 0)).toBe(0);
    expect(Number.isNaN(wilsonLower(0, 0))).toBe(false);
    expect(wilsonLower(5, 0)).toBe(0);
    expect(wilsonLower(1, -3)).toBe(0);
    // A watched class that agreed with nothing is 0 too, but by arithmetic.
    expect(wilsonLower(0, 50)).toBe(0);
  });
});
