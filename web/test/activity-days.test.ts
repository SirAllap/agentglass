/*
 * A day heading counts that day, and nothing from the day above it.
 *
 * The Activity page folds a run of identical neighbours into one row with a
 * count, and groups the result under day headings. Done in that order — fold,
 * then group — a run is allowed to span local midnight: the fold keeps the
 * timestamp of its FIRST member and carries the whole count there, so one
 * heading is credited with events that belong to the other, and the day it
 * borrowed from can vanish from the page entirely.
 *
 * Not a hypothesis. Measured against his own database, 200 rows, one fold of
 * `/prs/pending-review` with two members on one side of midnight and three on
 * the other:
 *
 *     day            SQL   the page said
 *     2026-08-27      64      67   (+3)
 *     2026-08-26      68      65   (-3)
 *
 * The two errors summed to zero, which is exactly why nothing caught it: the
 * page's total was right, every day it showed was plausible, and only a count
 * over the same rows in SQL disagreed. `activityDays` exists so the order
 * cannot be written backwards again — it is the only export the page calls.
 *
 * Times are built from the reader's OWN local midnight rather than from fixed
 * ISO strings: `dayName` asks the browser what day it is, so a fixture pinned
 * to a UTC instant tests a different boundary in every timezone this runs in.
 */
import { describe, expect, test } from "bun:test";
import { activityDays, mergeActivity } from "../src/lib/activity.ts";
import type { ActionRecord } from "../../shared/types.ts";

const midnight = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
const MIN = 60_000;

let seq = 0;
const act = (at: number, o: Partial<ActionRecord> = {}): ActionRecord => ({
  id: ++seq, at, actor: "someone", action: "/prs/pending-review",
  target: "", ok: true, detail: null, ...o,
});

/** Every row the page draws, as {day, count} — the numbers a reader adds up. */
const shown = (actions: ActionRecord[]) =>
  activityDays(mergeActivity(actions, [])).map(({ day, runs }) => ({
    day, total: runs.reduce((n, r) => n + r.times, 0),
  }));

describe("a run that spans midnight", () => {
  /* Two this morning, three last night, all identical and consecutive: the
     exact shape found in his data, minimised. */
  const rows = [
    act(midnight + 10 * MIN), act(midnight + 5 * MIN),
    act(midnight - 5 * MIN), act(midnight - 10 * MIN), act(midnight - 15 * MIN),
  ];

  test("is counted on both days, not on one of them", () => {
    expect(shown(rows)).toEqual([
      { day: "Today", total: 2 },
      { day: "Yesterday", total: 3 },
    ]);
  });

  test("and yesterday still appears at all", () => {
    // The louder half of the same bug: folded away, the heading it belonged to
    // has nothing left to draw and the day is simply missing from the page.
    expect(shown(rows).map((d) => d.day)).toContain("Yesterday");
  });

  test("so no day is credited with more rows than happened in it", () => {
    for (const { day, total } of shown(rows)) {
      const real = rows.filter((r) => (r.at >= midnight) === (day === "Today")).length;
      expect(total, `${day} drew ${total} of ${real}`).toBe(real);
    }
  });
});

describe("folding itself still works", () => {
  test("identical neighbours within one day collapse to one row", () => {
    const runs = activityDays(mergeActivity(
      [act(midnight + 30 * MIN), act(midnight + 20 * MIN), act(midnight + 10 * MIN)], [],
    ))[0]!.runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.times).toBe(3);
  });

  test("and a failure is never one of a crowd", () => {
    // Unchanged from the original fold, and worth a line here because the
    // rewrite passes the rows through a different path to reach it.
    const runs = activityDays(mergeActivity([
      act(midnight + 30 * MIN), act(midnight + 20 * MIN, { ok: false, detail: "no" }),
      act(midnight + 10 * MIN),
    ], []))[0]!.runs;
    expect(runs.map((r) => r.times)).toEqual([1, 1, 1]);
  });
});
