/**
 * The run button, in every state somebody can land in.
 *
 * His words about the tab this replaces: "it is not intuitive at all... it is
 * very hard". Four ways to start, laid out above the box you type the task into,
 * and one empty setting that silently disabled all four while every button
 * still looked live.
 *
 * Measured over 108 runs: 107 were worked under a shift and exactly one was
 * not, and all 108 came from the hand-written list. That is why there is one
 * button and why it starts a shift.
 */
import { test, expect } from "bun:test";
import { runBar } from "../src/components/understudy/Work.tsx";

const base = {
  working: false, minsLeft: 0, tasksLeft: 0,
  queued: 0, hasNext: false, busy: false, allowed: 1,
};

test("the one control is named for what pressing it does", () => {
  /* "Release for construction" is the phrase a drawing set uses for the moment
     paper becomes building. This is the point where a machine starts writing
     files in a checkout, and "start" never said that. */
  const b = runBar({ ...base, queued: 3 });
  expect(b.does).toBe("Release for construction");
  expect(b.enabled).toBe(true);
  expect(b.stopping).toBe(false);
  // The promise stays on this line; the limits moved to the title block.
  expect(b.says).toContain("Nothing is ever pushed");
});

test("nothing queued disables the button and says why — it does not just sit there lit", () => {
  const b = runBar(base);
  expect(b.enabled, "THE OLD SCREEN LEFT EVERY BUTTON LIVE with nothing to work").toBe(false);
  expect(b.says).toBe("Nothing on the set yet.");
});

test("no checkout disables it too, and says that instead", () => {
  const b = runBar({ ...base, allowed: 0, queued: 4 });
  expect(b.enabled).toBe(false);
  expect(b.says).toContain("nowhere to cut");
});

test("a sheet from elsewhere is released even with an empty set", () => {
  const b = runBar({ ...base, hasNext: true });
  expect(b.does).toBe("Release for construction");
  expect(b.enabled).toBe(true);
});

test("while working there is NO primary button — stopping is never the blue one", () => {
  const b = runBar({ ...base, working: true, minsLeft: 38, tasksLeft: 3, queued: 3 });
  expect(b.does, "a blue button while it works would make stopping the main action").toBeNull();
  expect(b.stopping).toBe(true);
  /* The clock is in the title block now, so this line only says what pressing
     the one control would do. */
  expect(b.says).toContain("stops after the sheet");
});

test("the clock is not repeated here — it lives in the title block", () => {
  const b = runBar({ ...base, working: true, minsLeft: 9, tasksLeft: 1 });
  expect(b.says).not.toMatch(/\d+ min/);
});

test("work already in flight from a click does not offer a second click", () => {
  expect(runBar({ ...base, queued: 2, busy: true }).enabled).toBe(false);
});
