// One number, one rendering (#248 C3).
//
// The hero KPI was the only currency site in the app not routed through
// fmtUsd: it feeds a NumberFlow, which animates a number and takes Intl
// options rather than a formatted string, and it asked for
// minimumFractionDigits: 2. With style:"currency" that does not raise the
// maximum — Intl defaults it to the currency's two digits — so a window
// costing $0.004 rendered "Spend · this window $0.00" on the desktop hero
// while the mobile shell and the cost donut, reading the identical field,
// said "$0.004". The dashboard claimed you had spent nothing next to a panel
// saying you had.
//
// usdDigits is the shared decision. These pin it to fmtUsd so the two
// renderings cannot drift apart again.
import { test, expect, describe } from "bun:test";
import { fmtUsd, usdDigits } from "../src/lib/format.ts";

describe("usdDigits gives a figure enough decimals to be true", () => {
  test("a dollar or more needs two", () => {
    expect(usdDigits(1)).toBe(2);
    expect(usdDigits(362.72)).toBe(2);
  });
  test("cents need three", () => {
    expect(usdDigits(0.01)).toBe(3);
    expect(usdDigits(0.5)).toBe(3);
  });
  test("sub-cent needs four — the range the hero used to render as $0.00", () => {
    expect(usdDigits(0.004)).toBe(4);
    expect(usdDigits(0.0001)).toBe(4);
  });
  test("zero is two, so an empty window reads $0.00 and not $0.0000", () => {
    expect(usdDigits(0)).toBe(2);
  });
});

describe("fmtUsd and usdDigits agree — they are one decision", () => {
  for (const n of [0, 0.0001, 0.004, 0.0099, 0.01, 0.5, 0.999, 1, 362.72]) {
    test(`${n} formats to exactly usdDigits(${n}) decimals`, () => {
      const s = fmtUsd(n);
      const decimals = s.includes(".") ? s.split(".")[1].length : 0;
      expect(decimals).toBe(usdDigits(n));
    });
  }

  test("real spend too small for four digits says so instead of rounding to zero", () => {
    expect(fmtUsd(0.00001)).toBe("<$0.0001");
  });

  test("negatives keep their sign and their precision", () => {
    expect(fmtUsd(-0.004)).toBe("-$0.0040");
    expect(fmtUsd(-12.5)).toBe("-$12.50");
  });

  // The failure this whole thing is about: a number that is not zero must
  // never render as if it were.
  test("no non-zero spend renders as $0.00", () => {
    for (const n of [0.0001, 0.001, 0.004, 0.0099]) expect(fmtUsd(n)).not.toBe("$0.00");
  });
});
