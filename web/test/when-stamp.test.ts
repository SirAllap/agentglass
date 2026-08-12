/*
 * The moment a board card is dated with.
 *
 * The card already said "3d", which is the right answer for scanning a lane and
 * a useless one for anything else: you cannot check "3d" against a deploy log
 * or quote it in a standup. Asked for on the line that says what the card is
 * waiting for, hard right — waiting, and since when, in one line.
 *
 * Built by hand rather than through `Intl` so the stamps line up in a column on
 * every machine. These tests are what stops somebody "simplifying" it back into
 * a locale-dependent formatter, which would look identical here and wrong on a
 * laptop set to another region.
 */
import { describe, expect, it } from "bun:test";
import { stamp } from "../src/lib/whenStamp.ts";

/* Built from local parts, never from a UTC string: a fixed instant renders as a
   different clock time in every timezone, and a test that only passes in Madrid
   is a test that fails in CI. */
const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m, d, h, min).toISOString();

describe("dating a card with the actual moment", () => {
  const now = new Date(2026, 7, 12, 17, 0); // 12 Aug 2026

  it("gives the day, the month and the clock", () => {
    expect(stamp(at(2026, 7, 12, 16, 57), now)).toBe("12 Aug 16:57");
  });

  it("pads the clock so a column of cards lines up", () => {
    // "9:5" against "16:57" is what makes a column look broken.
    expect(stamp(at(2026, 7, 3, 9, 5), now)).toBe("3 Aug 09:05");
  });

  it("keeps midnight as 00:00 rather than 12 of anything", () => {
    expect(stamp(at(2026, 7, 12, 0, 0), now)).toBe("12 Aug 00:00");
    expect(stamp(at(2026, 7, 12, 12, 0), now)).toBe("12 Aug 12:00");
    expect(stamp(at(2026, 7, 12, 23, 30), now)).toBe("12 Aug 23:30");
  });

  it("drops the year while it is this year", () => {
    // Four characters of noise on every card, when every card is from this
    // quarter.
    expect(stamp(at(2026, 0, 2, 8, 15), now)).toBe("2 Jan 08:15");
  });

  it("says the year on the one card that is not from this year", () => {
    expect(stamp(at(2025, 11, 20, 18, 4), now)).toBe("20 Dec 2025 18:04");
  });

  it("returns nothing rather than 'Invalid Date' when there is no date", () => {
    /* The card draws whatever comes back. `NaN` and the word "Invalid" are both
       worse than an empty corner, and a summary with no timestamp is a real
       shape — it is what a row looks like before the fetch lands. */
    for (const bad of ["", "   ", "not a date", "2026-13-45T99:99:99Z"]) {
      expect(stamp(bad, now), JSON.stringify(bad)).toBe("");
    }
  });

  it("uses the real clock when nobody passes one", () => {
    // The component calls it with one argument; the default must not throw.
    expect(stamp(new Date().toISOString())).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{2}:\d{2}$/);
  });
});
