/*
 * Approve and Decline answer on a one-second hold, never on a click or a key tap:
 * the thing this guards is that a slip of the pointer, or Enter pressed next to
 * the card, cannot change a setting. The clock is injected because bun's runner
 * has no fake timers.
 */
import { describe, expect, test } from "bun:test";
import { createHold, holdKey, HOLD_MS } from "../src/lib/holdToAnswer.ts";

function manualClock() {
  let last = 0;
  const jobs = new Map<number, () => void>();
  return {
    clock: {
      start(fn: () => void) { jobs.set(++last, fn); return last; },
      stop(id: number) { jobs.delete(id); },
    },
    /** A second passes: every armed timer fires. */
    pass() { const due = [...jobs.values()]; jobs.clear(); for (const fn of due) fn(); },
    armed: () => jobs.size,
  };
}

describe("the hold", () => {
  test("it waits a full second", () => {
    const c = manualClock();
    const calls: boolean[] = [];
    const hold = createHold({ onAnswer: () => calls.push(true), clock: c.clock });
    hold.press();
    expect(c.armed()).toBe(1);
    expect(calls).toEqual([]);
    expect(HOLD_MS).toBe(1000);
  });

  test("held for a second, it answers once", () => {
    const c = manualClock();
    const calls: string[] = [];
    const hold = createHold({ onAnswer: () => calls.push("answer"), clock: c.clock });
    hold.press();
    c.pass();
    expect(calls).toEqual(["answer"]);
    expect(hold.holding()).toBe(false);
    // The timer that answered is gone, so nothing fires twice.
    c.pass();
    expect(calls).toEqual(["answer"]);
  });

  test("let go early and nothing happens, and the timer is not left armed", () => {
    const c = manualClock();
    const calls: string[] = [];
    const hold = createHold({ onAnswer: () => calls.push("answer"), clock: c.clock });
    hold.press();
    hold.release();
    expect(c.armed()).toBe(0);
    c.pass();
    expect(calls).toEqual([]);
  });

  test("a second press while holding does not restart or arm another timer", () => {
    const c = manualClock();
    let calls = 0;
    const hold = createHold({ onAnswer: () => { calls++; }, clock: c.clock });
    hold.press();
    hold.press();
    expect(c.armed()).toBe(1);
    c.pass();
    expect(calls).toBe(1);
  });

  test("the button is told when the hold starts and stops, which is what fills it", () => {
    const c = manualClock();
    const seen: boolean[] = [];
    const hold = createHold({ onAnswer: () => {}, clock: c.clock, onChange: (h) => seen.push(h) });
    hold.press();
    hold.release();
    hold.press();
    c.pass();
    expect(seen).toEqual([true, false, true, false]);
  });
});

describe("the keys", () => {
  test("a key press alone does not answer: Enter down and up cancels", () => {
    const c = manualClock();
    let calls = 0;
    const hold = createHold({ onAnswer: () => { calls++; }, clock: c.clock });
    const down = holdKey("Enter", "down");
    expect(down).toBe("press");
    hold.press();
    expect(holdKey("Enter", "up")).toBe("release");
    hold.release();
    c.pass();
    expect(calls).toBe(0);
  });

  test("Escape is never an answer, and never a release either", () => {
    expect(holdKey("Escape", "down")).toBeNull();
    expect(holdKey("Escape", "up")).toBeNull();
    expect(holdKey("Esc", "down")).toBeNull();
  });

  test("Space and Enter hold; a repeat is not a new press; other keys do nothing", () => {
    expect(holdKey(" ", "down")).toBe("press");
    expect(holdKey("Enter", "down")).toBe("press");
    expect(holdKey(" ", "down", true)).toBeNull();
    expect(holdKey("a", "down")).toBeNull();
    expect(holdKey("Tab", "up")).toBeNull();
  });
});
