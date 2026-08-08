/*
 * How late a card is.
 *
 * The wire carries a LOCAL CALENDAR DATE — `2026-08-31`, already converted from
 * the provider's epoch by the server — and the trap is treating it as an
 * instant. `Date.parse("2026-08-31")` is midnight UTC, so subtracting `now`
 * puts a card due today into "1d late" for anybody west of UTC from mid-morning
 * onwards, and into "tomorrow" for anybody east of it late at night. Both are
 * wrong every single day, quietly, in a number people plan around.
 *
 * So this compares dates: the card's calendar date against the phone's, both
 * normalised the same way. The tests run the clock around a whole day to say so.
 */
import { describe, expect, test } from "bun:test";
import { dueIn } from "../src/lib/dates.ts";

/** A local date-time, built the way the device's own clock reports one. */
const at = (iso: string): Date => new Date(iso);

describe("a due date, read as a distance", () => {
  test("the plain cases", () => {
    const today = at("2026-08-06T09:00:00");
    expect(dueIn("2026-08-06", today)).toEqual({ text: "today", late: true });
    expect(dueIn("2026-08-07", today)).toEqual({ text: "tomorrow", late: false });
    expect(dueIn("2026-08-09", today)).toEqual({ text: "in 3d", late: false });
    expect(dueIn("2026-08-04", today)).toEqual({ text: "2d late", late: true });
  });

  test("today is today whatever time it is", () => {
    /*
     * The assertion the timezone bug fails. Same card, same day, every hour of
     * it: one minute past midnight and one minute to it must both say "today",
     * because the answer is about a calendar and not about elapsed hours.
     */
    for (const hour of [0, 1, 6, 9, 13, 18, 22, 23]) {
      const clock = at(`2026-08-06T${String(hour).padStart(2, "0")}:30:00`);
      expect(dueIn("2026-08-06", clock), `at ${hour}:30`).toEqual({ text: "today", late: true });
    }
  });

  test("and a month boundary is not a special case", () => {
    expect(dueIn("2026-09-01", at("2026-08-31T20:00:00"))).toEqual({ text: "tomorrow", late: false });
    expect(dueIn("2026-08-31", at("2026-09-01T08:00:00"))).toEqual({ text: "1d late", late: true });
  });

  test("today counts as late, because it is the last day it is not", () => {
    // A card due today at 09:00 has hours left and is still the one to look at
    // first. Colouring it like next week's is how a board stops being read.
    expect(dueIn("2026-08-06", at("2026-08-06T09:00:00"))?.late).toBe(true);
  });

  test("nothing at all for a card with no date, or a date that is not one", () => {
    for (const bad of [null, undefined, "", "someday", "2026-13-45x", "31/08/2026"]) {
      expect(dueIn(bad, at("2026-08-06T09:00:00")), String(bad)).toBeNull();
    }
  });
});
