/*
 * An alert from one of several computers: whose it is, whether it buzzes, and
 * where a tap on it lands. Pure functions and source checks — the sockets are
 * in watch-host.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AlertNote } from "../../shared/types.ts";
import { alertKey, remember, shouldNotify, SAME_ALERT_MS } from "../src/notifications/policy.ts";
import { alertHost, alertRoute } from "../src/notifications/target.ts";
import { alertTitle } from "../src/model/computers.ts";

const NOTE: AlertNote = { title: "fix-retry wants to run", body: "bun test", urgency: 2, pane: "%7" };
const ctx = (over: Record<string, unknown> = {}) => ({
  foreground: false, lastSeen: new Map<string, number>(), now: 1_000_000, ...over,
});

describe("the same words from two computers", () => {
  test("are two alerts, and both buzz", () => {
    // Broken on purpose: a key made of the text alone lets the second computer's
    // "wants to run" be swallowed as a repeat of the first one's.
    const seen = new Map<string, number>();
    remember(NOTE, { lastSeen: seen, now: 1_000_000, hostId: "a" });
    expect(shouldNotify(NOTE, ctx({ lastSeen: seen, hostId: "b" })).notify).toBe(true);
    expect(shouldNotify(NOTE, ctx({ lastSeen: seen, hostId: "a" }))).toEqual({ notify: false, because: "repeat" });
  });
  test("the key says which computer", () => {
    expect(alertKey(NOTE, "a")).not.toBe(alertKey(NOTE, "b"));
    expect(alertKey(NOTE)).toBe(alertKey(NOTE, ""));
  });
  test("a repeat on one computer still expires", () => {
    const seen = new Map<string, number>();
    remember(NOTE, { lastSeen: seen, now: 1_000_000, hostId: "a" });
    expect(shouldNotify(NOTE, ctx({ lastSeen: seen, hostId: "a", now: 1_000_000 + SAME_ALERT_MS + 1 })).notify).toBe(true);
  });
});

describe("what the notification says and carries", () => {
  test("the title names the computer only when there are two or more", () => {
    expect(alertTitle("fix-retry wants to run", "orbit desktop", 1)).toBe("fix-retry wants to run");
    expect(alertTitle("fix-retry wants to run", "orbit desktop", 2)).toBe("orbit desktop: fix-retry wants to run");
  });
  test("a tap carries the computer's id, shaped like one", () => {
    expect(alertHost({ kind: "alert", hostId: "k3j9x0abcd" })).toBe("k3j9x0abcd");
    expect(alertHost({ kind: "alert" })).toBeNull();
    expect(alertHost({ kind: "alert", hostId: "../etc" })).toBeNull();
    expect(alertHost({ kind: "alert", hostId: 7 })).toBeNull();
    expect(alertHost(null)).toBeNull();
  });
  test("the route is still the pane's, whichever computer it is on", () => {
    expect(alertRoute({ kind: "alert", pane: "%7", hostId: "a" })).toEqual({ pathname: "/terminal", params: { pane: "%7" } });
  });
  test("raise() puts the id in the notification's data", () => {
    const src = readFileSync(join(import.meta.dir, "../src/notifications/notify.ts"), "utf8");
    const from = src.indexOf("export async function raise(");
    const body = src.slice(from, src.indexOf("return record({ ok: true })", from));
    expect(body).toContain("hostId");
  });
});

describe("where the app handles a tap", () => {
  const root = readFileSync(join(import.meta.dir, "../app/_layout.tsx"), "utf8");
  test("switches to the computer first, then opens the route", () => {
    const tap = root.slice(root.indexOf("watchAlertTaps("), root.indexOf("[ready, host"));
    expect(tap).toContain("alertHost(data)");
    expect(tap.indexOf("switchTo(")).toBeGreaterThan(-1);
    expect(tap.indexOf("switchTo(")).toBeLessThan(tap.indexOf("router.navigate"));
  });
  test("a computer that is not on the list is ignored, not switched to", () => {
    expect(root).toMatch(/hosts\.some\(\(h\) => h\.id === (hostId|id)\)/);
  });
});

describe("the provider's sockets for the computers not in front", () => {
  const src = readFileSync(join(import.meta.dir, "../src/state/host-context.tsx"), "utf8");
  const a = src.indexOf("const restKey");
  const watchers = src.slice(a, src.indexOf("useEffect(() => {\n    const sub = AppState", a));
  test("start no timer of their own", () => {
    // Broken on purpose: a setInterval in this block is N computers asking on
    // a clock, for a badge. The only clocks stay in the effects keyed on `host`.
    expect(a).toBeGreaterThan(-1);
    expect(watchers).not.toMatch(/setInterval|setTimeout/);
    expect(watchers.length).toBeGreaterThan(200);
  });
  test("are rebuilt when the set of computers or a key changes, not when one is renamed", () => {
    expect(watchers).toMatch(/\[restKey, watching\]/);
    expect(src).toMatch(/const restKey = rest\.map\(\(h\) => `\$\{h\.id\}/);
  });
  test("an alert from one of them is never held back for being on screen", () => {
    expect(watchers).toMatch(/foreground: false/);
  });
  test("and the talk and check counters are fed by the computer in front only", () => {
    expect(watchers).not.toMatch(/noteTalk|noteChecks/);
  });
});
