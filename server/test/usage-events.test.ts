/*
 * The one-line calls that tell the orchestration policy a reading changed:
 * an accepted statusline post says so, a refused one does not, a listener that
 * throws cannot fail the post, and the held reading is available without a
 * request.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { __test_forgetEverything, ingestStatusline, peekUsage } from "../src/usage.ts";
import { onUsageReading, usageRead } from "../src/usageevents.ts";

const body = { rate_limits: { five_hour: { used_percentage: 42, resets_at: Math.floor(Date.now() / 1000) + 3600 } } };
let off: (() => void)[] = [];
afterEach(() => { off.forEach((f) => f()); off = []; __test_forgetEverything(); });

describe("usage events", () => {
  test("an accepted reading says so once, a refused one says nothing", () => {
    let n = 0;
    off.push(onUsageReading(() => { n++; }));
    expect(ingestStatusline({ nothing: true })).toBe(false);
    expect(n).toBe(0);
    expect(ingestStatusline(body)).toBe(true);
    expect(n).toBe(1);
  });

  test("a listener that throws does not fail the post, and the next listener still hears", () => {
    let heard = 0;
    const log = console.error; console.error = () => {};
    try {
      off.push(onUsageReading(() => { throw new Error("boom"); }));
      off.push(onUsageReading(() => { heard++; }));
      expect(ingestStatusline(body)).toBe(true);
    } finally { console.error = log; }
    expect(heard).toBe(1);
  });

  test("a listener that has left hears nothing", () => {
    let n = 0;
    const stop = onUsageReading(() => { n++; });
    stop();
    usageRead();
    expect(n).toBe(0);
  });

  test("the held reading is there to peek at without a request", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((...a: Parameters<typeof fetch>) => { calls++; return realFetch(...a); }) as typeof fetch;
    try {
      ingestStatusline(body);
      const u = await peekUsage();
      expect(u?.available).toBe(true);
      expect(u?.five_hour?.utilization).toBe(42);
      expect(calls).toBe(0);
    } finally { globalThis.fetch = realFetch; }
  });
});
