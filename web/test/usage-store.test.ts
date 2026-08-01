/*
 * The labels the gauges put on screen.
 *
 * Only the pure functions are tested here — the poll itself is a timer and a
 * fetch, and the interesting decisions are all in how a reading is DESCRIBED.
 * `ageLabel` carries the most weight: it is the whole reason a Codex reading is
 * honest rather than merely present.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";

let usageStore: typeof import("../src/lib/usageStore.ts");
let api: typeof import("../src/lib/api.ts");
let demo: typeof import("../src/lib/demo.ts");

// Store the original providerUsage so we can restore it
let originalProviderUsage: any;
// Track clearInterval calls for verification
let clearIntervalCalls: number[] = [];
// Track how many times the patched providerUsage was called
let providerUsageCallCount = 0;

beforeAll(async () => {
  (globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };

  // Import modules in order
  demo = await import("../src/lib/demo.ts");
  api = await import("../src/lib/api.ts");

  // Save the original and create the patched version
  originalProviderUsage = api.api.providerUsage;
  (api.api as any).providerUsage = () => {
    providerUsageCallCount++;
    return Promise.resolve(demo.providerUsage());
  };

  // Patch clearInterval to track calls
  const originalClearInterval = globalThis.clearInterval;
  (globalThis as any).clearInterval = (id: number) => {
    clearIntervalCalls.push(id);
    return originalClearInterval(id);
  };

  // Now import usageStore - it will use the patched api
  usageStore = await import("../src/lib/usageStore.ts");
});

afterAll(async () => {
  // Restore the original api.providerUsage
  (api.api as any).providerUsage = originalProviderUsage;
});

beforeEach(() => {
  // Reset counters before each test
  clearIntervalCalls = [];
  providerUsageCallCount = 0;
});

const NOW = Date.parse("2026-07-31T12:00:00Z");

describe("usedColor", () => {
  test("escalates with consumption", () => {
    expect(usageStore.usedColor(10)).toBe("var(--success)");
    expect(usageStore.usedColor(70)).toBe("var(--warning)");
    expect(usageStore.usedColor(90)).toBe("var(--error)");
  });

  test("changes exactly at the thresholds", () => {
    expect(usageStore.usedColor(59)).toBe("var(--success)");
    expect(usageStore.usedColor(60)).toBe("var(--warning)");
    expect(usageStore.usedColor(84)).toBe("var(--warning)");
    expect(usageStore.usedColor(85)).toBe("var(--error)");
  });
});

describe("ageLabel", () => {
  test("a reading from moments ago does not nag", () => {
    expect(usageStore.ageLabel(NOW - 30_000, NOW)).toBe("just now");
  });

  test("says how old a stale reading is", () => {
    expect(usageStore.ageLabel(NOW - 45 * 60_000, NOW)).toBe("45m ago");
    expect(usageStore.ageLabel(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(usageStore.ageLabel(NOW - 50 * 3_600_000, NOW)).toBe("2d ago");
  });

  test("no reading is not an age", () => {
    expect(usageStore.ageLabel(undefined, NOW)).toBe("");
  });
});

describe("resetLabel", () => {
  test("counts down when the reset is near", () => {
    expect(usageStore.resetLabel(new Date(NOW + 104 * 60_000).toISOString(), NOW)).toBe("in 1h 44m");
    expect(usageStore.resetLabel(new Date(NOW + 20 * 60_000).toISOString(), NOW)).toBe("in 20m");
  });

  test("a reset in the past is now, not a negative countdown", () => {
    expect(usageStore.resetLabel(new Date(NOW - 60_000).toISOString(), NOW)).toBe("now");
  });

  test("nothing to say about a null reset", () => {
    expect(usageStore.resetLabel(null, NOW)).toBe("");
  });
});

describe("subscribeProviderUsage", () => {
  test("during fetch, the store reports loading; after resolution, loaded with data", async () => {
    usageStore.__resetUsageStore();

    // Track when the callback fires
    const calls: number[] = [];
    const startTime = Date.now();

    // Create a controlled promise that we resolve ourselves
    let resolveProviderUsage: ((data: any) => void) | null = null;
    const controlledPromise = new Promise((resolve) => {
      resolveProviderUsage = resolve;
    });

    // Temporarily replace the api with our controlled version
    const originalPatch = api.api.providerUsage;
    (api.api as any).providerUsage = () => controlledPromise;

    try {
      // Subscribe before the promise resolves
      const unsub = usageStore.subscribeProviderUsage(() => {
        calls.push(Date.now() - startTime);
      });

      // At this point, the promise is still in flight
      await new Promise(resolve => setTimeout(resolve, 10));

      // Store should report not-loaded while fetch is pending
      expect(usageStore.usageLoaded()).toBe(false);
      expect(usageStore.providerUsage()).toBe(null);

      // Now resolve the promise
      resolveProviderUsage?.(demo.providerUsage());

      // Wait for the promise to resolve and callback to fire
      await new Promise(resolve => setTimeout(resolve, 50));

      // Now the store should report loaded with data
      expect(usageStore.usageLoaded()).toBe(true);
      const usage = usageStore.providerUsage();
      expect(usage).not.toBe(null);
      expect(usage?.length).toBe(3);
      expect(usage?.[0]?.provider).toBe("anthropic");
      expect(usage?.[1]?.provider).toBe("codex");
      expect(usage?.[2]?.provider).toBe("antigravity");

      // Callback should have fired at least once after resolution
      expect(calls.length).toBeGreaterThan(0);

      unsub();
    } finally {
      // Restore the original patch
      (api.api as any).providerUsage = originalPatch;
    }
  });

  test("unsubscribing the last listener clears the timer", async () => {
    usageStore.__resetUsageStore();
    const initialCallCount = providerUsageCallCount;

    const unsub = usageStore.subscribeProviderUsage(() => {});

    // Wait for the first fetch to complete
    await new Promise(resolve => setTimeout(resolve, 50));

    // First fetch should have happened
    expect(providerUsageCallCount).toBeGreaterThan(initialCallCount);

    // Now unsubscribe
    const clearIntervalCallCountBefore = clearIntervalCalls.length;
    unsub();
    const clearIntervalCallCountAfter = clearIntervalCalls.length;

    // clearInterval should have been called exactly once
    expect(clearIntervalCallCountAfter).toBe(clearIntervalCallCountBefore + 1);

    // Wait to verify no more calls happen (timer should be cleared)
    const callCountBeforeWait = providerUsageCallCount;
    await new Promise(resolve => setTimeout(resolve, 100));
    const callCountAfterWait = providerUsageCallCount;

    // No new calls should have been made after unsubscribe
    expect(callCountAfterWait).toBe(callCountBeforeWait);
  });
});
