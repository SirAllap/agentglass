/*
 * The labels the gauges put on screen.
 *
 * Only the pure functions are tested here — the poll itself is a timer and a
 * fetch, and the interesting decisions are all in how a reading is DESCRIBED.
 * `ageLabel` carries the most weight: it is the whole reason a Codex reading is
 * honest rather than merely present.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { setUsageRefreshOn } from "../src/lib/usageRefreshPref.ts";

let usageStore: typeof import("../src/lib/usageStore.ts");
let api: typeof import("../src/lib/api.ts");
let demo: typeof import("../src/lib/demo.ts");

// Store the original providerUsage so we can restore it
let originalProviderUsage: any;
// Track clearInterval calls for verification
let clearIntervalCalls: number[] = [];
// Track how many times the patched providerUsage was called
let providerUsageCallCount = 0;

// A controllable localStorage, so the `maybeRefreshCodex` on/off tests below
// exercise the setting itself rather than an accident of the test
// environment. Bun has no browser localStorage, so a bare `localStorage.
// getItem` throws and usageRefreshOn()'s catch quietly returns false — that
// happened to keep this suite's poll from ever spending a (fake) request,
// but "happened to" is not a guarantee once someone adds a real
// localStorage shim to the harness for an unrelated reason.
const localStorageStore = new Map<string, string>();
let originalLocalStorage: unknown;

beforeAll(async () => {
  (globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };

  originalLocalStorage = (globalThis as any).localStorage;
  (globalThis as any).localStorage = {
    getItem: (k: string) => localStorageStore.get(k) ?? null,
    setItem: (k: string, v: string) => void localStorageStore.set(k, v),
    removeItem: (k: string) => void localStorageStore.delete(k),
    clear: () => localStorageStore.clear(),
    key: () => null,
    length: 0,
  } as Storage;

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
  // Restore the original localStorage (undefined, on this runtime)
  if (originalLocalStorage === undefined) delete (globalThis as any).localStorage;
  else (globalThis as any).localStorage = originalLocalStorage;
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

describe("maybeRefreshCodex", () => {
  /*
   * `maybeRefreshCodex` is the function that decides whether to spend the
   * user's own Codex quota to refresh the reading of it. `shouldRefresh`
   * (the floor) is covered on its own in usage-refresh.test.ts; what is
   * covered nowhere else is the *composition* — that the setting, the
   * floor, and the hourly cadence all have to agree before a ping goes out,
   * and that any one of them alone is enough to stop it.
   *
   * Driven the same way subscribeProviderUsage's own tests above drive the
   * poll: subscribe, let load() run, inspect what happened. A second "poll"
   * within one test is simulated by unsubscribing and resubscribing, which
   * clears and recreates the poller — exactly what the "clears the timer"
   * test above already established that does.
   */

  function codexSnapshot(observedAt: number | undefined): any[] {
    return [{ provider: "codex", label: "Codex", available: true, windows: [], observedAt }];
  }

  test("setting off, reading ancient → no ping", async () => {
    usageStore.__resetUsageStore();
    setUsageRefreshOn(false);
    let refreshCalls = 0;
    const priorRefresh = api.api.refreshCodexUsage;
    const priorProviderUsage = api.api.providerUsage;
    (api.api as any).refreshCodexUsage = () => { refreshCalls++; return Promise.resolve({ ok: true }); };
    // Hours old — if the setting were not the thing suppressing this, the
    // floor and cadence guards would both wave it through.
    (api.api as any).providerUsage = () => Promise.resolve(codexSnapshot(Date.now() - 3 * 3_600_000));
    try {
      const unsub = usageStore.subscribeProviderUsage(() => {});
      await new Promise((r) => setTimeout(r, 50));
      expect(refreshCalls).toBe(0);
      unsub();
    } finally {
      (api.api as any).refreshCodexUsage = priorRefresh;
      (api.api as any).providerUsage = priorProviderUsage;
    }
  });

  test("setting on, reading younger than the 15-minute floor → no ping", async () => {
    usageStore.__resetUsageStore();
    setUsageRefreshOn(true);
    let refreshCalls = 0;
    const priorRefresh = api.api.refreshCodexUsage;
    const priorProviderUsage = api.api.providerUsage;
    (api.api as any).refreshCodexUsage = () => { refreshCalls++; return Promise.resolve({ ok: true }); };
    (api.api as any).providerUsage = () => Promise.resolve(codexSnapshot(Date.now() - 5 * 60_000));
    try {
      const unsub = usageStore.subscribeProviderUsage(() => {});
      await new Promise((r) => setTimeout(r, 50));
      expect(refreshCalls).toBe(0);
      unsub();
    } finally {
      (api.api as any).refreshCodexUsage = priorRefresh;
      (api.api as any).providerUsage = priorProviderUsage;
      setUsageRefreshOn(false);
    }
  });

  test("setting on, reading stale, but a ping already went within the hour → the second ping is suppressed", async () => {
    usageStore.__resetUsageStore();
    setUsageRefreshOn(true);
    let refreshCalls = 0;
    const priorRefresh = api.api.refreshCodexUsage;
    const priorProviderUsage = api.api.providerUsage;
    const stale = Date.now() - 20 * 60_000;
    (api.api as any).refreshCodexUsage = () => { refreshCalls++; return Promise.resolve({ ok: true }); };
    (api.api as any).providerUsage = () => Promise.resolve(codexSnapshot(stale));
    try {
      // First poll: nothing has pinged yet and the reading is stale — one ping.
      let unsub = usageStore.subscribeProviderUsage(() => {});
      await new Promise((r) => setTimeout(r, 50));
      expect(refreshCalls).toBe(1);
      unsub();

      // Second poll, moments later: the reading is exactly as stale as
      // before, so the floor alone would wave this through again. Only the
      // hourly cadence guard — `lastPing` from the ping above — can be the
      // thing stopping it.
      unsub = usageStore.subscribeProviderUsage(() => {});
      await new Promise((r) => setTimeout(r, 50));
      expect(refreshCalls).toBe(1);
      unsub();
    } finally {
      (api.api as any).refreshCodexUsage = priorRefresh;
      (api.api as any).providerUsage = priorProviderUsage;
      setUsageRefreshOn(false);
    }
  });

  test("setting on, reading stale, no recent ping → exactly one ping, and the snapshot is re-fetched", async () => {
    usageStore.__resetUsageStore();
    setUsageRefreshOn(true);
    let refreshCalls = 0;
    let providerUsageCalls = 0;
    const priorRefresh = api.api.refreshCodexUsage;
    const priorProviderUsage = api.api.providerUsage;
    const stale = Date.now() - 20 * 60_000;
    (api.api as any).refreshCodexUsage = () => { refreshCalls++; return Promise.resolve({ ok: true }); };
    (api.api as any).providerUsage = () => { providerUsageCalls++; return Promise.resolve(codexSnapshot(stale)); };
    try {
      const unsub = usageStore.subscribeProviderUsage(() => {});
      await new Promise((r) => setTimeout(r, 50));
      expect(refreshCalls).toBe(1);
      // One call is the poll itself; a second is the re-fetch
      // `maybeRefreshCodex` does after a successful ping, to pick up the
      // fresh number the ping just caused Codex to write.
      expect(providerUsageCalls).toBeGreaterThanOrEqual(2);
      unsub();
    } finally {
      (api.api as any).refreshCodexUsage = priorRefresh;
      (api.api as any).providerUsage = priorProviderUsage;
      setUsageRefreshOn(false);
    }
  });
});
