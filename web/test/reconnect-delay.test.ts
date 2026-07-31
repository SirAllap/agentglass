import { test, expect, describe, beforeAll } from "bun:test";

// A tab that was watched through an outage stopped reconnecting and never
// started again. The give-up was real and deliberate — don't hammer a server
// that isn't coming back — but its only recovery was `visibilitychange`, which
// the foreground tab is precisely the one that never receives. So the tab being
// looked at was the one that stayed dead.

let live: typeof import("../src/lib/useLive.ts");
beforeAll(async () => {
  (globalThis as any).location ??= new URL("http://localhost:5173/");
  (globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  live = await import("../src/lib/useLive.ts");
});

const MIN = 60_000;

describe("reconnectDelay", () => {
  test("backs off fast at first, capped at 8s", () => {
    expect(live.reconnectDelay(0, 0)).toBe(500);
    expect(live.reconnectDelay(1_000, 1)).toBe(1000);
    expect(live.reconnectDelay(5_000, 3)).toBe(4000);
    // The cap: a restart should be noticed within seconds, not minutes.
    expect(live.reconnectDelay(30_000, 8)).toBe(8000);
    expect(live.reconnectDelay(60_000, 40)).toBe(8000);
  });

  test("slows down past the give-up window instead of stopping", () => {
    // This is the fix. It used to return nothing and schedule nothing here.
    expect(live.reconnectDelay(2 * MIN + 1, 50)).toBe(MIN);
    expect(live.reconnectDelay(60 * MIN, 5000)).toBe(MIN);
  });

  test("always answers with a delay, however long it has been failing", () => {
    // The invariant that matters is the absence of a "stop" answer: a tab left
    // open overnight against a dead server must still be trying in the morning,
    // because nothing else will restart it.
    for (const failingFor of [0, 1, MIN, 2 * MIN, 10 * MIN, 24 * 60 * MIN]) {
      const d = live.reconnectDelay(failingFor, 999);
      expect(Number.isFinite(d), `no delay at ${failingFor}ms`).toBe(true);
      expect(d).toBeGreaterThan(0);
    }
  });

  test("never retries faster than twice a second, and never slower than a minute", () => {
    // Two bounds worth holding: the first keeps a broken server from being
    // hammered, the second keeps a recovered one from going unnoticed.
    for (let retry = 0; retry < 40; retry++) {
      for (const failingFor of [0, 30_000, 3 * MIN]) {
        const d = live.reconnectDelay(failingFor, retry);
        expect(d).toBeGreaterThanOrEqual(500);
        expect(d).toBeLessThanOrEqual(MIN);
      }
    }
  });
});
