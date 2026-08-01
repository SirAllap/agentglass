/*
 * The labels the gauges put on screen.
 *
 * Only the pure functions are tested here — the poll itself is a timer and a
 * fetch, and the interesting decisions are all in how a reading is DESCRIBED.
 * `ageLabel` carries the most weight: it is the whole reason a Codex reading is
 * honest rather than merely present.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import type { ProviderUsage } from "../../shared/types.ts";

let usageStore: typeof import("../src/lib/usageStore.ts");
let api: typeof import("../src/lib/api.ts");

// Demo data matching what web/src/lib/demo.ts exports
const demoProviderUsage = (): ProviderUsage[] => [
  { provider: "anthropic", label: "Claude", available: false, windows: [],
    note: "Plan usage is not available in the demo." },
  { provider: "codex", label: "Codex", available: false, windows: [],
    note: "Plan usage is not available in the demo." },
  { provider: "antigravity", label: "Antigravity", available: false, windows: [],
    note: "Antigravity's CLI does not report quota anywhere agentglass can read." },
];

beforeAll(async () => {
  (globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };

  // Import api first so we can patch it before usageStore imports it
  api = await import("../src/lib/api.ts");
  // Patch the providerUsage method to return demo data instead of hitting the network
  (api.api as any).providerUsage = () => Promise.resolve(demoProviderUsage());

  // Now import usageStore - it will use the patched api
  usageStore = await import("../src/lib/usageStore.ts");
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
  test("before first fetch resolves, the store reports not-loaded", () => {
    usageStore.__resetUsageStore();
    expect(usageStore.usageLoaded()).toBe(false);
    expect(usageStore.providerUsage()).toBe(null);
  });

  test("after first fetch resolves, usageLoaded() is true and providerUsage() has length 3", async () => {
    usageStore.__resetUsageStore();
    let callCount = 0;
    const unsub = usageStore.subscribeProviderUsage(() => { callCount++; });

    // Wait for the fetch to complete
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(usageStore.usageLoaded()).toBe(true);
    const usage = usageStore.providerUsage();
    expect(usage).not.toBe(null);
    expect(usage?.length).toBe(3);
    expect(usage?.[0]?.provider).toBe("anthropic");
    expect(usage?.[1]?.provider).toBe("codex");
    expect(usage?.[2]?.provider).toBe("antigravity");

    unsub();
  });

  test("unsubscribing the last listener clears the timer without throwing", async () => {
    usageStore.__resetUsageStore();
    const unsub = usageStore.subscribeProviderUsage(() => {});

    // Wait for the fetch to complete
    await new Promise(resolve => setTimeout(resolve, 50));

    // This should not throw
    expect(() => unsub()).not.toThrow();

    // After unsubscribing, the store should be reset for the next test
    usageStore.__resetUsageStore();
  });
});
