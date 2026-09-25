import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_NOTIFY_PREFS } from "../../shared/notifyPrefs.ts";
import type { PaceAlert } from "../../shared/types.ts";

/*
 * The client half of the plan-pace alert: the server decides once per window
 * (server/test/pace-review-fixes.test.ts); this words what it sent, quietly.
 */

const cell = new Map<string, string>();
let alert: typeof import("../src/lib/paceAlert.ts");
let prefs: typeof import("../src/lib/notifyPrefsStore.ts");
let sysNotify: typeof import("../src/lib/sysNotify.ts");
const g = globalThis as any;
const saved = { localStorage: g.localStorage, location: g.location, Notification: g.Notification };

beforeAll(async () => {
  g.localStorage = {
    getItem: (k: string) => cell.get(k) ?? null,
    setItem: (k: string, v: string) => { cell.set(k, v); },
    removeItem: (k: string) => { cell.delete(k); },
  };
  g.location = { hostname: "localhost", origin: "http://localhost:4000" };
  g.Notification = class { static permission = "denied"; };
  alert = await import("../src/lib/paceAlert.ts");
  prefs = await import("../src/lib/notifyPrefsStore.ts");
  sysNotify = await import("../src/lib/sysNotify.ts");
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; }
});

describe("showPaceAlert", () => {
  const reset = Date.UTC(2026, 8, 30, 13, 0);
  const now = Date.UTC(2026, 8, 28, 10, 0);
  const a: PaceAlert = { provider: "anthropic", providerLabel: "Claude", label: "weekly", usedPercent: 96, minutes: 10080, resetsAt: reset, alertAt: 90 };
  const paceRows = () => sysNotify.notifyHistory().filter((n) => n.key?.startsWith("pace:"));

  test("one quiet row, keyed by the window, never sticky", () => {
    prefs.receiveNotifyPrefs({ ...DEFAULT_NOTIFY_PREFS, kinds: { ...DEFAULT_NOTIFY_PREFS.kinds, usage: true } });
    try {
      alert.showPaceAlert(a, now);
      expect(paceRows()).toHaveLength(1);
      expect(paceRows()[0]!.key).toBe("pace:anthropic|weekly");
      expect(paceRows()[0]!.urgency).toBe(1);
      expect(paceRows()[0]!.summary).toContain("96% used");
      // The same window said again replaces its row rather than stacking one.
      alert.showPaceAlert({ ...a, usedPercent: 97 }, now);
      expect(paceRows()).toHaveLength(1);
    } finally {
      prefs.receiveNotifyPrefs(DEFAULT_NOTIFY_PREFS);
      sysNotify.clearNotes();
    }
  });

  test("the Usage kind off keeps it out of the bell", () => {
    alert.showPaceAlert(a, now);
    expect(paceRows()).toHaveLength(0);
  });
});
