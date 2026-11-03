import { afterEach, describe, expect, test } from "bun:test";
import { clearRefreshing, forgetRefreshing, markRefreshing, onRefreshing, refreshingSince } from "../src/lib/prRefreshingStore.ts";

/* The ceiling is 45 s, so the store's own timer is captured and fired by hand.
   Only the timer this test fires is stubbed, and it is put back at once. */
const timers: (() => void)[] = [];
const realSet = globalThis.setTimeout;
const realClear = globalThis.clearTimeout;
const captureTimers = <T,>(fn: () => T): T => {
  (globalThis as unknown as { setTimeout: unknown }).setTimeout = (cb: () => void) => { timers.push(cb); return 0; };
  (globalThis as unknown as { clearTimeout: unknown }).clearTimeout = () => {};
  try { return fn(); } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
};

afterEach(() => { timers.length = 0; forgetRefreshing(); });

describe("the ceiling after an update", () => {
  test("it takes the marker away, so no card keeps saying a read is coming", () => {
    let told = 0;
    const off = onRefreshing(() => told++);
    captureTimers(() => markRefreshing("acme/orbit", 7));
    expect(refreshingSince("acme/orbit", 7)).toBeDefined();
    expect(told).toBe(1);
    timers.pop()!();
    expect(refreshingSince("acme/orbit", 7)).toBeUndefined();
    expect(told).toBe(2);
    off();
  });

  test("a read that answered nothing clears it too, without waiting for the ceiling", () => {
    captureTimers(() => markRefreshing("acme/orbit", 8));
    clearRefreshing("acme/orbit", 8);
    expect(refreshingSince("acme/orbit", 8)).toBeUndefined();
  });

  test("a timer left over from a cleared marker takes nothing else with it", () => {
    captureTimers(() => { markRefreshing("acme/orbit", 9); markRefreshing("acme/orbit", 10); });
    const fire9 = timers[0]!;
    clearRefreshing("acme/orbit", 9);
    fire9();
    expect(refreshingSince("acme/orbit", 9)).toBeUndefined();
    expect(refreshingSince("acme/orbit", 10)).toBeDefined();
  });
});
