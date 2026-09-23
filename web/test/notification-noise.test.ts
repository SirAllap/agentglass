import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SystemNote } from "../src/lib/sysNotify.ts";

// The bell's half of the noise policy — see src/lib/notePolicy.ts for the
// rules and server/test/notification-noise.test.ts for what the server no
// longer sends. These hold what a note may do once it arrives: be kept, count
// on the badge, take the screen; and what a mute and a key do to the list.

const cell = new Map<string, string>();
let policy: typeof import("../src/lib/notePolicy.ts");
let sysNotify: typeof import("../src/lib/sysNotify.ts");
let storage0: unknown;

beforeAll(async () => {
  storage0 = (globalThis as any).localStorage;
  (globalThis as any).localStorage = {
    getItem: (k: string) => cell.get(k) ?? null,
    setItem: (k: string, v: string) => { cell.set(k, v); },
    removeItem: (k: string) => { cell.delete(k); },
  };
  (globalThis as any).location ??= { hostname: "localhost", origin: "http://localhost:4000" };
  policy = await import("../src/lib/notePolicy.ts");
  sysNotify = await import("../src/lib/sysNotify.ts");
  policy.__resetMuted();
});

afterAll(() => {
  for (const s of policy.mutedSources()) policy.setMuted(s, false);
  policy.__resetMuted();
  sysNotify.clearNotes();
  sysNotify.setNotifyQuiet(true);
  (globalThis as any).localStorage = storage0;
});

const none = new Set<string>();
const at = (urgency: 0 | 1 | 2, source?: string, app = "agentglass") => ({ app, urgency, ...(source ? { source } : {}) });

describe("levels", () => {
  test("urgent always interrupts; Quiet reaches only news", () => {
    for (const quiet of [true, false]) {
      expect(policy.deliveryFor(at(2, "gate"), { muted: none, quiet })).toEqual({ keep: true, badge: true, interrupt: true });
      expect(policy.deliveryFor(at(0, "agents"), { muted: none, quiet })).toEqual({ keep: true, badge: false, interrupt: false });
    }
    expect(policy.deliveryFor(at(1, "lantern"), { muted: none, quiet: true })).toEqual({ keep: true, badge: true, interrupt: false });
    expect(policy.deliveryFor(at(1, "lantern"), { muted: none, quiet: false })).toEqual({ keep: true, badge: true, interrupt: true });
  });

  test("a desktop app is never louder than news, and with Quiet on is only a row", () => {
    const slack = at(2, "desktop:slack", "Slack");
    expect(policy.deliveryFor(slack, { muted: none, quiet: true })).toEqual({ keep: true, badge: false, interrupt: false });
    expect(policy.deliveryFor(slack, { muted: none, quiet: false })).toEqual({ keep: true, badge: true, interrupt: true });
  });
});

describe("mutes", () => {
  test("a muted source is not kept; something urgent from it still is", () => {
    const muted = new Set(["agents", "desktop:omarchy-action"]);
    expect(policy.deliveryFor(at(1, "agents"), { muted, quiet: false }).keep).toBe(false);
    expect(policy.deliveryFor(at(1, "desktop:omarchy-action"), { muted, quiet: false }).keep).toBe(false);
    expect(policy.deliveryFor(at(2, "agents"), { muted, quiet: false }).interrupt).toBe(true);
  });

  test("what stops an agent cannot be muted at all", () => {
    for (const s of ["gate", "understudy", "reminder"]) {
      expect(policy.canMute(s)).toBe(false);
      policy.setMuted(s, true);
      expect(policy.mutedSources().has(s)).toBe(false);
    }
  });

  test("a mute persists across a reload and undoes cleanly", () => {
    policy.setMuted("lantern", true);
    policy.setMuted("desktop:omarchy-action", true);
    expect(JSON.parse(cell.get("agentglass.notes.muted")!)).toEqual(["desktop:omarchy-action", "lantern"]);
    policy.__resetMuted(); // what a restart does: the cache is gone, storage is not
    expect([...policy.mutedSources()].sort()).toEqual(["desktop:omarchy-action", "lantern"]);
    policy.setMuted("lantern", false);
    policy.setMuted("desktop:omarchy-action", false);
    policy.__resetMuted();
    expect(policy.mutedSources().size).toBe(0);
  });

  test("a stored list somebody edited by hand cannot mute the gate", () => {
    cell.set("agentglass.notes.muted", JSON.stringify(["gate", "errors", 7]));
    policy.__resetMuted();
    expect([...policy.mutedSources()]).toEqual(["errors"]);
    policy.setMuted("errors", false);
  });
});

describe("grouping", () => {
  const note = (id: string, source: string, urgency: 0 | 1 | 2 = 1): SystemNote =>
    ({ id, app: "agentglass", source, summary: id, body: "", urgency, at: 0 });

  test("one entry per source, newest leading, older folded under it", () => {
    const g = policy.groupNotes([note("a3", "errors"), note("l1", "lantern"), note("a2", "errors"), note("a1", "errors")]);
    expect(g.map((x) => [x.lead.id, x.more.map((m) => m.id)])).toEqual([["a3", ["a2", "a1"]], ["l1", []]]);
  });

  test("urgent rows are never folded behind a count", () => {
    const g = policy.groupNotes([note("p2", "agents", 2), note("w1", "agents"), note("p1", "agents", 2), note("w0", "agents")]);
    expect(g.map((x) => [x.lead.id, x.more.length])).toEqual([["p2", 0], ["w1", 1], ["p1", 0]]);
  });

  test("lanes", () => {
    expect(policy.laneOf("lantern")).toBe("agents");
    expect(policy.laneOf("ci")).toBe("work");
    expect(policy.laneOf("desktop:slack")).toBe("desktop");
    expect(policy.sourceLabel("desktop:omarchy-action")).toBe("Omarchy-action");
  });
});

describe("the list", () => {
  const rows = (key: string) => sysNotify.notifyHistory().filter((n) => n.key === key);

  test("a keyed card is one row, redrawn in place without a badge, and removed when resolved", () => {
    sysNotify.clearNotes();
    sysNotify.fireDesktopAlert({ title: "🔦 Lantern: 2 need you", body: "a\nb", urgency: 2, key: "lantern", source: "lantern" });
    expect(rows("lantern")).toHaveLength(1);
    expect(sysNotify.notifyUnread()).toBe(1);
    sysNotify.fireDesktopAlert({ title: "🔦 Lantern: 1 needs you", body: "a", urgency: 1, key: "lantern", source: "lantern", update: true });
    expect(rows("lantern").map((n) => n.summary)).toEqual(["🔦 Lantern: 1 needs you"]);
    expect(sysNotify.notifyUnread(), "a redraw is not news").toBe(1);
    sysNotify.fireDesktopAlert({ title: "🔦 Lantern: 3 need you", body: "a\nb\nc", urgency: 2, key: "lantern", source: "lantern" });
    expect(rows("lantern")).toHaveLength(1);
    sysNotify.fireDesktopAlert({ title: "", body: "", urgency: 0, key: "lantern", clear: true });
    expect(rows("lantern")).toHaveLength(0);
  });

  test("the badge goes with its row: a cleared card or a muted source leaves no lit bell", () => {
    sysNotify.clearNotes();
    sysNotify.fireDesktopAlert({ title: "🔦 Lantern: 1 looks forgotten", body: "a", urgency: 1, key: "lantern", source: "lantern" });
    expect(sysNotify.notifyUnread()).toBe(1);
    sysNotify.fireDesktopAlert({ title: "", body: "", urgency: 0, key: "lantern", clear: true });
    expect(sysNotify.notifyUnread()).toBe(0);
    sysNotify.fireDesktopAlert({ title: "t", body: "b", urgency: 1, key: "lantern", source: "lantern" });
    policy.setMuted("lantern", true);
    expect(sysNotify.notifyUnread(), "a muted row does not light the bell").toBe(0);
    policy.setMuted("lantern", false);
    expect(sysNotify.notifyUnread()).toBe(1);
    sysNotify.markNotifyRead();
    expect(sysNotify.notifyUnread()).toBe(0);
  });

  test("a redraw carries the card's standing level, both ways", () => {
    sysNotify.clearNotes();
    sysNotify.fireDesktopAlert({ title: "1 needs you", body: "a", urgency: 2, key: "lantern", source: "lantern", pane: "%1" });
    sysNotify.fireDesktopAlert({ title: "1 looks forgotten", body: "b", urgency: 1, key: "lantern", source: "lantern", update: true });
    expect(rows("lantern")[0]).toMatchObject({ urgency: 1, summary: "1 looks forgotten" });
    expect(rows("lantern")[0]!.goto, "a resolved pane is not a destination").toBeUndefined();
    sysNotify.fireDesktopAlert({ title: "1 needs you", body: "c", urgency: 2, key: "lantern", source: "lantern", update: true });
    expect(rows("lantern")[0]).toMatchObject({ urgency: 2 });
  });

  test("a client that missed the announcement gets the card from the snapshot, silently", () => {
    sysNotify.clearNotes();
    // clearNotes counts as dismissing; a fresh session has no dismissed keys,
    // which news restores.
    sysNotify.fireDesktopAlert({ title: "x", body: "", urgency: 1, key: "lantern", source: "lantern" });
    sysNotify.fireDesktopAlert({ title: "", body: "", urgency: 0, key: "lantern", clear: true });
    sysNotify.markNotifyRead();
    sysNotify.fireDesktopAlert({ title: "🔦 Lantern: 1 needs you", body: "a", urgency: 2, key: "lantern", source: "lantern", update: true });
    expect(rows("lantern")).toHaveLength(1);
    expect(sysNotify.notifyUnread(), "a snapshot is not news").toBe(0);
  });

  test("a redraw does not bring back a card somebody dismissed", () => {
    sysNotify.clearNotes();
    sysNotify.fireDesktopAlert({ title: "t", body: "b", urgency: 1, key: "lantern", source: "lantern" });
    sysNotify.dismissNote(rows("lantern")[0]!.id);
    sysNotify.fireDesktopAlert({ title: "t2", body: "b2", urgency: 1, key: "lantern", source: "lantern", update: true });
    expect(rows("lantern")).toHaveLength(0);
  });

  test("a muted source is not recorded; unmuted, it is again", () => {
    sysNotify.clearNotes();
    policy.setMuted("errors", true);
    sysNotify.fireDesktopAlert({ title: "❌ Keeps failing", body: "x", urgency: 1, key: "errors:s1", source: "errors" });
    expect(sysNotify.notifyHistory()).toHaveLength(0);
    policy.setMuted("errors", false);
    sysNotify.fireDesktopAlert({ title: "❌ Keeps failing", body: "x", urgency: 1, key: "errors:s1", source: "errors" });
    expect(sysNotify.notifyHistory()).toHaveLength(1);
  });

  test("the same desktop note again is one row with a count; with Quiet on it never interrupts", () => {
    sysNotify.clearNotes();
    sysNotify.setNotifyQuiet(true);
    const cards: string[] = [];
    const off = sysNotify.subscribeSystemNotes((n) => cards.push(n.summary));
    for (let i = 0; i < 4; i++) {
      sysNotify.receiveMirrored({ id: `m${i}`, app: "omarchy-action", summary: "Screenshot saved to clipboard and file", body: "", urgency: 1, at: i });
    }
    off();
    const h = sysNotify.notifyHistory();
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ count: 4, source: "desktop:omarchy-action" });
    expect(cards, "no card over the work").toEqual([]);
    expect(sysNotify.notifyUnread(), "no badge for a mirrored note in Quiet").toBe(0);
  });

  test("a muted desktop app is not recorded at all", () => {
    sysNotify.clearNotes();
    policy.setMuted("desktop:omarchy-action", true);
    sysNotify.receiveMirrored({ id: "m9", app: "omarchy-action", summary: "Screenshot saved", body: "", urgency: 1, at: 9 });
    expect(sysNotify.notifyHistory()).toHaveLength(0);
    policy.setMuted("desktop:omarchy-action", false);
  });
});
