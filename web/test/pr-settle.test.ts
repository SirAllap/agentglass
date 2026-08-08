/*
 * The masthead that said "Loading" for twenty seconds beside a finished board.
 *
 * Measured in the real bundle: at t=1.0s every row was up and correct, and the
 * label still read "Loading pull requests…" until t=20.1s. Neither half was
 * wrong on its own — the board fetches its own data and settles in about a
 * second, the label reports the LIST's state, and the list's state only changes
 * when a response replaces it. Nothing asked for another response until the
 * twenty-second poll, so nothing did.
 *
 * What is pinned here is the rule, not the numbers on the day: an unfinished
 * answer is collected far sooner than the poll, a finished one schedules
 * nothing at all, and a server that never settles is backed away from instead
 * of being asked every second and a half for as long as the view is open.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { POLL_MS, SETTLE_MS, settleAfter } from "../src/lib/prSettle.ts";

describe("collecting on an unfinished list", () => {
  it("asks again soon, not on the poll", () => {
    // The bug in one assertion. Anything at or near POLL_MS here would leave
    // the label lying for the same twenty seconds it always did.
    const { wait } = settleAfter({ loading: true });
    expect(wait).toBe(SETTLE_MS);
    expect(wait!).toBeLessThan(POLL_MS / 4);
  });

  it("counts check states as unfinished too", () => {
    // The same masthead renders "Loading check states…" from this one, and the
    // rows below it are just as complete.
    expect(settleAfter({ checksPending: true }).wait).toBe(SETTLE_MS);
  });

  it("schedules nothing once the answer is finished", () => {
    // null rather than a long delay: the caller CANCELS on null. A number here
    // would mean every settled response quietly booked another request.
    expect(settleAfter({}).wait).toBeNull();
    expect(settleAfter({ loading: false, checksPending: false }).wait).toBeNull();
  });

  it("goes back to the first delay after it settles", () => {
    // Otherwise one slow load leaves the view permanently slow to collect:
    // the backoff would still be at 12s when the next scope is fetched.
    expect(settleAfter({}, 12_000).next).toBe(SETTLE_MS);
  });
});

describe("a server that never settles", () => {
  it("is asked at a doubling interval, capped at the poll", () => {
    const seen: number[] = [];
    let d = SETTLE_MS;
    for (let i = 0; i < 8; i++) {
      const s = settleAfter({ loading: true }, d);
      seen.push(s.wait!);
      d = s.next;
    }
    expect(seen.slice(0, 4)).toEqual([1_500, 3_000, 6_000, 12_000]);
    // And never faster than it would have been polled anyway — the point of
    // the cap is that the pathological case costs no more than doing nothing.
    for (const w of seen) expect(w).toBeLessThanOrEqual(POLL_MS);
    expect(seen[seen.length - 1]).toBe(POLL_MS);
  });
});

describe("the panel wires it to both ends", () => {
  const PANEL = readFileSync(new URL("../src/components/PrPanel.tsx", import.meta.url), "utf8");

  it("cancels the pending collection when the view or the scope changes", () => {
    // A timer that outlives its scope lands a list nobody is looking at any
    // more, and its backoff goes on counting from the one before.
    expect(PANEL).toContain("clearTimeout(settleTimer.current)");
    expect(PANEL).toContain("settleDelay.current = SETTLE_MS");
  });

  it("keeps one source for the poll interval", () => {
    // Both numbers moved into lib/prSettle.ts precisely because the backoff
    // has to stop AT the poll, and two copies of 20_000 is how that stops
    // being true.
    expect(PANEL).not.toMatch(/const POLL_MS\s*=/);
    expect(PANEL).toContain('from "../lib/prSettle.ts"');
  });
});
