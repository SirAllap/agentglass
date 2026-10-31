import { describe, expect, it } from "bun:test";
import { commitDayLabel } from "../src/lib/commitDay.ts";

// Local noon, so the zone the test runs in cannot move a commit across midnight.
const noon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0);
const now = noon(2026, 10, 29);
const iso = (d: Date) => d.toISOString();

describe("the heading over a day's commits", () => {
  it("says today, yesterday and the days after in words", () => {
    expect(commitDayLabel(iso(noon(2026, 10, 29)), now, "Oct 29, 2026")).toBe("Today");
    expect(commitDayLabel(iso(noon(2026, 10, 28)), now, "Oct 28, 2026")).toBe("Yesterday");
    expect(commitDayLabel(iso(noon(2026, 10, 27)), now, "Oct 27, 2026")).toBe("Two days ago");
    expect(commitDayLabel(iso(noon(2026, 10, 23)), now, "Oct 23, 2026")).toBe("Six days ago");
  });
  it("counts calendar days, not 24-hour blocks", () => {
    const justAfterMidnight = new Date(2026, 9, 29, 0, 10);
    expect(commitDayLabel(iso(new Date(2026, 9, 28, 23, 50)), justAfterMidnight, "Oct 28, 2026")).toBe("Yesterday");
  });
  it("falls back to the date past a week, for a missing time and for a future one", () => {
    expect(commitDayLabel(iso(noon(2026, 10, 20)), now, "Oct 20, 2026")).toBe("Oct 20, 2026");
    expect(commitDayLabel(null, now, "Undated")).toBe("Undated");
    expect(commitDayLabel("not a date", now, "Undated")).toBe("Undated");
    expect(commitDayLabel(iso(noon(2026, 10, 30)), now, "Oct 30, 2026")).toBe("Oct 30, 2026");
  });
});
