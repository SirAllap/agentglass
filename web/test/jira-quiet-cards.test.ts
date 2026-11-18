/*
 * An open card that has not changed in two weeks has stalled: the tile wears a clock and the Quiet filter keeps it.
 * A done card never counts, and neither does one with no date.
 */
import { describe, expect, test } from "bun:test";
import { quietDays, QUIET_DAYS } from "../src/components/jira/list/model.ts";
import { CLEARED, narrowedBy } from "../src/components/jira/list/laneModel.ts";
import { NO_FILTERS } from "../src/components/jira/list/model.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 9, 12);

describe("quiet cards", () => {
  test("open and untouched for the limit or more counts its days; under it, done, or undated is zero", () => {
    expect(quietDays({ updated: NOW - QUIET_DAYS * DAY, statusKind: "open" }, NOW)).toBe(QUIET_DAYS);
    expect(quietDays({ updated: NOW - 30 * DAY, statusKind: "open" }, NOW)).toBe(30);
    expect(quietDays({ updated: NOW - (QUIET_DAYS - 1) * DAY, statusKind: "open" }, NOW)).toBe(0);
    expect(quietDays({ updated: NOW - 90 * DAY, statusKind: "done" }, NOW)).toBe(0);
    expect(quietDays({ updated: 0, statusKind: "open" }, NOW)).toBe(0);
  });
  test("Clear filters takes the quick toggles off too, and the empty state names them", () => {
    const on = { ...NO_FILTERS, flaggedOnly: true, quietOnly: true, assigneePick: ["acc-1"], quick: ["q1"] };
    expect(narrowedBy(on)).toEqual(["Flagged", "Quiet 14 days", "1 person", "1 quick filter"]);
    expect(narrowedBy({ ...on, ...CLEARED })).toEqual([]);
  });
});
