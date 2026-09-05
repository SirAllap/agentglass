/*
 * A run that is still going says how long it has been going.
 *
 * The row somebody is actually watching was the only one that did not: every
 * finished run showed "17 min" and the live one showed the word "running",
 * which the coloured state chip beside it was already saying. A task can take
 * three quarters of an hour, so that row is exactly where the number matters.
 *
 * Testable at all because `took` takes `now` as a parameter. Nothing passes it
 * — the tab re-renders every six seconds while work is in flight, so the
 * number moves on its own without a timer, and adding one would be idle cost
 * this application has already had to go and remove once.
 */
import { describe, expect, test } from "bun:test";
import { took } from "../src/components/understudy/Work.tsx";

const run = (startedAt: number, finishedAt: number | null) => ({
  id: 1, shiftId: null, source: "test", itemId: "t", title: "t",
  repo: "", worktree: "", branch: "", startedAt, finishedAt,
  state: (finishedAt ? "done" : "running") as "done" | "running", outcome: "",
});

describe("how long it has been at it", () => {
  const now = 1_700_000_000_000;

  test("a live run counts up instead of saying the word running", () => {
    expect(took(run(now - 40_000, null), now)).toBe("40s");
    expect(took(run(now - 22 * 60_000, null), now)).toBe("22 min");
  });

  test("in the same units a finished run uses, so two rows compare", () => {
    // The threshold is the point of the units: seconds while a person would
    // say seconds, minutes after that.
    expect(took(run(now - 89_000, null), now)).toBe("89s");
    expect(took(run(now - 91_000, null), now)).toBe("2 min");
    expect(took(run(0, 89_000))).toBe("89s");
  });

  test("a finished run ignores the clock entirely", () => {
    // Otherwise every completed row would grow for ever after the fact.
    expect(took(run(0, 60_000), now)).toBe("60s");
  });

  test("a clock that disagrees reads as zero, never as negative", () => {
    // Two machines and one database: the row's start can be marginally ahead
    // of this browser's idea of now, and "-3s" is a bug report waiting to
    // happen for something that is merely a clock.
    expect(took(run(now + 5_000, null), now)).toBe("0s");
  });
});
