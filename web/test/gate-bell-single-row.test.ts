import { test, expect, beforeAll, beforeEach, describe } from "bun:test";
import { readFileSync } from "node:fs";
import type { PendingGate } from "../../shared/types.ts";

/*
 * One bell row per gate hold, retired when it resolves.
 *
 * Two producers used to write an urgency-2 row for the same hold: gateStore's
 * own announce() (keyed by nothing) and useLive.ts's `{type:"alert"}` handler,
 * which ran fireDesktopAlert on the server's push for the same hold and
 * recordNote'd it a second time — a comment right above that call claimed
 * otherwise ("this does not also recordNote"). Urgency 2 never folds
 * (notePolicy.ts), so the second row sat there for as long as the first, and
 * nothing ever cleared either one when the hold resolved.
 */

const cell = new Map<string, string>();
let gateStore: typeof import("../src/lib/gateStore.ts");
let sysNotify: typeof import("../src/lib/sysNotify.ts");

let permission: NotificationPermission = "granted";
class FakeNotification {
  static get permission(): NotificationPermission { return permission; }
  static requestPermission(): Promise<NotificationPermission> { return Promise.resolve(permission); }
  onclick: (() => void) | null = null;
  constructor(_title: string, _opts?: unknown) { /* not counted here */ }
  close() { /* nothing to tear down */ }
}

beforeAll(async () => {
  (globalThis as any).localStorage = {
    getItem: (k: string) => cell.get(k) ?? null,
    setItem: (k: string, v: string) => { cell.set(k, v); },
    removeItem: (k: string) => { cell.delete(k); },
  };
  (globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };
  (globalThis as any).Notification = FakeNotification;
  gateStore = await import("../src/lib/gateStore.ts");
  sysNotify = await import("../src/lib/sysNotify.ts");
});

beforeEach(() => {
  gateStore.__resetGateStore();
  sysNotify.clearNotes();
});

const gate = (id: string, over: Partial<PendingGate> = {}): PendingGate => ({
  id, source_app: "claude", session_id: "abcdef0123456789",
  tool_name: "Bash", summary: "rm -rf build", created: 1_700_000_000_000, ...over,
});

const urgent = () => sysNotify.notifyHistory().filter((n) => n.urgency === 2);

/*
 * The other half of the fix is wiring, not behaviour: useLive.ts's
 * `{type:"alert"}` handler has no seam a store test can drive (it lives
 * inside the socket's onmessage closure), so it is read between landmarks —
 * same idiom as browser-bench-tab-verbs.test.ts.
 */
const live = readFileSync(new URL("../src/lib/useLive.ts", import.meta.url), "utf8");
const between = (from: string, to: string): string => {
  const a = live.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = live.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return live.slice(a, b);
};

describe("the gate push does not write a second bell row", () => {
  test('a gate-sourced alert frame skips recordNote — only the popup fires', () => {
    const block = between('if (frame.type === "alert") {', "return;\n      }\n      if (frame.type === \"card\")");
    expect(block).toContain('frame.data.source === "gate"');
    expect(block).toContain("firePopupOnly(");
    // And the gate branch returns before the unconditional fireDesktopAlert —
    // the ordinary case (permission wait, tool error) is untouched.
    expect(block.indexOf('source === "gate"')).toBeLessThan(block.indexOf("fireDesktopAlert(frame.data)"));
  });
});

test("gateStore alone keeps its row unique and clears it when the hold goes", () => {
  gateStore.ingestGates([]); // the baseline read — nothing waiting yet
  gateStore.ingestGates([gate("g1")]); // now one arrives
  expect(urgent()).toHaveLength(1);
  expect(urgent()[0]!.key).toBe("gate:g1");

  gateStore.ingestGates([]); // resolved — timed out, decided elsewhere, whatever
  expect(urgent()).toHaveLength(0);
});
