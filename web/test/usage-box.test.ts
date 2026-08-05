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
let tightestWindow: typeof import("../src/components/UsageBox.tsx")["tightestWindow"];

import type { ProviderUsage, QuotaWindow } from "../../shared/types.ts";

const sample: ProviderUsage[] = [
  { provider: "anthropic", label: "Claude Code", available: true, windows: [] },
];

const win = (label: string, usedPercent: number): QuotaWindow =>
  ({ label, minutes: 300, usedPercent, resetsAt: null });

beforeAll(async () => {
  (globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };
  ({ panelState, tightestWindow } = await import("../src/components/UsageBox.tsx"));
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

  test("an empty array is its own state, not 'rows'", () => {
    // Every quota-reporting agent disconnected in Settings › Agents. Mapping
    // this onto "rows" renders a panel with nothing in it, which reads as "you
    // have used nothing" rather than "you asked not to be shown this".
    expect(panelState(true, [])).toBe("empty");
  });

  test("and empty does not depend on the loaded flag", () => {
    expect(panelState(false, [])).toBe("empty");
  });

  test("rows already cached before the poll reports loaded -> rows", () => {
    // Reachable once a later subscriber mounts after the first fetch already
    // populated the snapshot but before its own loaded flag microtask fires.
    expect(panelState(false, sample)).toBe("rows");
  });
});

/*
 * The panel's headline — the window closest to running out — is the one claim
 * the box makes in full size, so the ways it could lie are worth pinning: a
 * provider that cannot report must not be read as 0% and win by silence, and
 * "nothing to headline" must be null rather than a fabricated row.
 */
describe("tightestWindow", () => {
  test("picks the highest usedPercent across providers, not within one", () => {
    const top = tightestWindow([
      { provider: "anthropic", label: "Claude", available: true, windows: [win("5h", 34), win("weekly", 61)] },
      { provider: "codex", label: "Codex", available: true, windows: [win("weekly", 88)] },
    ]);
    expect(top?.provider).toBe("Codex");
    expect(top?.window.usedPercent).toBe(88);
  });

  test("skips providers that cannot report", () => {
    // The bug this guards: an unavailable provider treated as 0% used still
    // loses, but one treated as *the* answer would headline a number nobody
    // reported. Only real readings are eligible.
    const top = tightestWindow([
      { provider: "antigravity", label: "Antigravity", available: false, windows: [win("weekly", 99)] },
      { provider: "codex", label: "Codex", available: true, windows: [win("weekly", 12)] },
    ]);
    expect(top?.provider).toBe("Codex");
  });

  test("no readings at all -> null, so the headline is skipped rather than faked", () => {
    expect(tightestWindow(null)).toBeNull();
    expect(tightestWindow([])).toBeNull();
    expect(tightestWindow([
      { provider: "antigravity", label: "Antigravity", available: false, windows: [] },
    ])).toBeNull();
    // Available but with nothing in it is the same nothing.
    expect(tightestWindow(sample)).toBeNull();
  });

  test("keeps the first of two equally-consumed windows", () => {
    // Ordering is the provider's (short window before long); a tie must not
    // let the later, coarser window displace the one already shown.
    const top = tightestWindow([
      { provider: "anthropic", label: "Claude", available: true, windows: [win("5h", 50), win("weekly", 50)] },
    ]);
    expect(top?.window.label).toBe("5h");
  });

  test("0% everywhere still headlines — a real reading of zero is not nothing", () => {
    const top = tightestWindow([
      { provider: "codex", label: "Codex", available: true, windows: [win("weekly", 0)] },
    ]);
    expect(top?.window.usedPercent).toBe(0);
  });
});
