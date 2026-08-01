/*
 * The panel-level state decision in UsageBox, extracted into `panelState` so
 * the fourth blank state — server unreachable on the first poll — has a test
 * instead of relying on eyeballing the rendered panel.
 *
 * `usageStore` marks `firstFetchDone` true in a `.finally()`, so it becomes
 * true whether the poll succeeded or failed, while a failed poll leaves
 * `snapshot` at null (the last-good-reading policy). `loaded === true` with
 * `rows === null` is that failure, and it must read as "unreachable", not
 * fall through both branches into a blank panel.
 *
 * UsageBox.tsx imports usageStore.ts, which reads `location` at module load
 * (to build the API base URL) — the same reason usage-store.test.ts stubs
 * `location` before importing anything that pulls that chain in.
 */
import { describe, expect, test, beforeAll } from "bun:test";

let panelState: typeof import("../src/components/UsageBox.tsx")["panelState"];

import type { ProviderUsage } from "../../shared/types.ts";

const sample: ProviderUsage[] = [
  { provider: "anthropic", label: "Claude Code", available: true, windows: [] },
];

beforeAll(async () => {
  (globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };
  ({ panelState } = await import("../src/components/UsageBox.tsx"));
});

describe("panelState", () => {
  test("not loaded, no rows yet -> loading", () => {
    expect(panelState(false, null)).toBe("loading");
  });

  test("loaded, no rows -> unreachable (the failed-first-poll case)", () => {
    expect(panelState(true, null)).toBe("unreachable");
  });

  test("loaded, with rows -> rows", () => {
    expect(panelState(true, sample)).toBe("rows");
  });

  test("rows already cached before the poll reports loaded -> rows", () => {
    // Reachable once a later subscriber mounts after the first fetch already
    // populated the snapshot but before its own loaded flag microtask fires.
    expect(panelState(false, sample)).toBe("rows");
  });
});
