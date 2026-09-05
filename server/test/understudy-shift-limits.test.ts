/*
 * A shift is the only thing that bounds the whole feature, and it could be
 * opened without one.
 *
 * `Number("abc")` is NaN. `Math.min(MAX, NaN)` is NaN. `Math.max(60_000, NaN)`
 * is NaN. So a request body of `{"minutes": "abc"}` produced `endsAt = NaN`,
 * `msLeft = NaN`, and every stop rule asks `msLeft <= 0` — which is FALSE for
 * NaN. Same arithmetic, same result, for the action budget.
 *
 * The result was a shift with no wall and no ceiling: it never ran out of time
 * and never ran out of tasks. The two limits the loop is built around, removed
 * by a string.
 *
 * Clamping is not validating. A number that is not a number has to be replaced
 * before it reaches arithmetic that assumes it is one.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let S: typeof import("../src/understudy-shift.ts");
let U: typeof import("../src/understudy.ts");

beforeAll(async () => {
  process.env.AGENTGLASS_DB = join(mkdtempSync(join(tmpdir(), "agx-shift-")), "t.db");
  S = await import("../src/understudy-shift.ts");
  U = await import("../src/understudy.ts");
  U.setEnabled(true);
});

/** A fresh shift, whatever the last test left open. */
function open(minutes: unknown, maxActions: unknown) {
  const cur = S.current();
  if (cur) S.stop(cur.id, "next test");
  const r = S.start("t", Number(minutes), Number(maxActions));
  if (!r.ok) throw new Error(`a shift should have opened: ${r.error}`);
  return r.shift;
}

describe("a shift always has a wall and a ceiling", () => {
  test("a value that is not a number falls back rather than through", () => {
    const shift = open("abc", "abc");
    expect(Number.isFinite(shift.msLeft), "msLeft must be a number").toBe(true);
    expect(Number.isFinite(shift.actionsLeft), "actionsLeft must be a number").toBe(true);
    expect(shift.msLeft).toBeGreaterThan(0);
    expect(shift.actionsLeft).toBeGreaterThan(0);
  });

  test("and the stop rules can therefore answer", () => {
    /*
     * The actual failure. `NaN <= 0` is false, so a shift with NaN limits
     * reported "keep going" for ever — the rules were being asked and were
     * answering, wrongly, which is worse than not being asked.
     */
    const shift = open("abc", "abc");
    const stop = S.shouldStop(shift, { lastFailed: false });
    expect(stop.stop).toBe(false);          // fresh shift, so it should continue…
    const spent = { ...shift, msLeft: 0 };
    expect(S.shouldStop(spent, { lastFailed: false }).stop, "a spent shift must stop").toBe(true);
  });

  test("infinity is clamped to the maximum, not passed on", () => {
    const shift = open(Infinity, Infinity);
    expect(shift.msLeft).toBeLessThanOrEqual(S.MAX_SHIFT_MS);
    expect(shift.actionsLeft).toBeLessThanOrEqual(S.MAX_SHIFT_ACTIONS);
  });

  test("a negative is floored, so nobody opens a shift that is already over", () => {
    const shift = open(-5000, -5000);
    expect(shift.msLeft).toBeGreaterThan(0);
    expect(shift.actionsLeft).toBeGreaterThanOrEqual(1);
  });
});

describe("an expired shift does not block the next one for ever", () => {
  /*
   * MEASURED ON THE RUNNING SERVER, and it was a dead end.
   *
   * `current()` closes a shift that has run out and RETURNS IT — deliberately,
   * so the screen can say why it ended instead of showing nothing. `start()`
   * asked `if (current())` and read that as "one is already running".
   *
   * So the first time a shift expired, no shift could ever be opened again:
   * the loop refuses to run without one, and the tab offers nothing to stop
   * because nothing is running. Three stopped shifts in the table, none live,
   * and every handover answering "stop that one first".
   *
   * This is almost certainly the failure a previous change described as "the
   * handover failed because a shift was already open" and attributed to a
   * missing guard elsewhere.
   */
  test("a shift that ran out of time lets another open", () => {
    const first = open(30, 3);
    expect(first.state).toBe("running");

    // Wind it past its end the way time does, then ask — which is what closes
    // it and hands the closed row back.
    S.__endShiftAt(first.id, Date.now() - 1000);
    const closed = S.current();
    expect(closed?.state, "current() closes it and returns it").not.toBe("running");

    const second = S.start("after", 30, 3);
    expect(second.ok, second.ok ? "" : second.error).toBe(true);
  });

  test("but a live one still blocks, which is the rule that matters", () => {
    const live = open(30, 3);
    expect(live.state).toBe("running");
    const again = S.start("second", 30, 3);
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.error).toContain("already running");
  });
});
