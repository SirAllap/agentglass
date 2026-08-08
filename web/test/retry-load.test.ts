/*
 * A read that is allowed to be too early.
 *
 * Reported from a cold start: the pinned recipe chips read `recipe:rmsh8muud0`
 * and `recipe:rmsg3pkhn0` instead of `tmux` and `wtserve`, and opening the
 * Commands dropdown fixed them — because opening it re-ran the same fetch. The
 * window comes up before the sidecar is listening, the first read fails, and a
 * `.catch(() => {})` turned that into a blank nobody would ever retry.
 *
 * What is pinned here is the shape of the retry, not the timings: it stops on
 * the first success, it gives up rather than polling forever, a thrown error
 * counts as a failure, and an effect that has been cleaned up runs nothing
 * more.
 */
import { describe, expect, it } from "bun:test";
import { retryLoad } from "../src/lib/retryLoad.ts";

/** Fires every wait immediately, and records how long each one asked for. */
function fakeClock() {
  const asked: number[] = [];
  const pending: (() => void)[] = [];
  return {
    asked,
    opts: {
      delays: [10, 20, 30],
      wait: (ms: number, fn: () => void) => { asked.push(ms); pending.push(fn); return asked.length; },
      clear: () => { pending.length = 0; },
    },
    /** Let every scheduled retry run, and the promises behind it settle. */
    async flush() {
      for (let i = 0; i < 10 && pending.length; i++) {
        const next = pending.shift()!;
        next();
        await settle();
      }
    },
  };
}

/** A macrotask: everything queued as a microtask has run by the time this
 *  resolves, whatever the promise chain's depth. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("a load that works first time", () => {
  it("runs once and schedules nothing", async () => {
    const c = fakeClock();
    let calls = 0;
    retryLoad(async () => { calls++; return true; }, c.opts);
    await settle();
    expect(calls).toBe(1);
    expect(c.asked).toEqual([]);
  });
});

describe("a load that is early", () => {
  it("keeps going until it works, then stops", async () => {
    const c = fakeClock();
    let calls = 0;
    retryLoad(async () => { calls++; return calls >= 3; }, c.opts);
    await settle();
    await c.flush();
    expect(calls).toBe(3);
    // Two gaps for two failures — and nothing after the success.
    expect(c.asked).toEqual([10, 20]);
  });

  it("counts a thrown error as a failure rather than escaping", async () => {
    const c = fakeClock();
    let calls = 0;
    retryLoad(async () => { calls++; if (calls === 1) throw new Error("connection refused"); return true; }, c.opts);
    await settle();
    await c.flush();
    expect(calls).toBe(2);
  });
});

describe("a load that never works", () => {
  it("gives up instead of becoming a poll", async () => {
    const c = fakeClock();
    let calls = 0;
    retryLoad(async () => { calls++; return false; }, c.opts);
    await settle();
    await c.flush();
    // One go plus one per gap, and then it is done: a read failing for a
    // reason that is not "too early" must not turn into traffic forever.
    expect(calls).toBe(4);
    expect(c.asked).toEqual([10, 20, 30]);
  });
});

describe("cancelling", () => {
  it("runs nothing more once the effect has been cleaned up", async () => {
    const c = fakeClock();
    let calls = 0;
    const stop = retryLoad(async () => { calls++; return false; }, c.opts);
    await settle();
    expect(calls).toBe(1);
    stop();
    await c.flush();
    expect(calls).toBe(1);
  });
});
