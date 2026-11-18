import { describe, expect, test } from "bun:test";
import { deliveryFor, whereItShows, migrateAppRules, ruleFor, defaultRule, waitsOnYou, RULES_KEY, type Screen } from "../src/lib/notePolicy.ts";

// Notifications v2: one model. deliveryFor says whether a note may take the
// screen; whereItShows says where — an agentglass card or one desktop popup,
// never both. These are the "Where it shows" table in Settings, cell by cell.

const none = new Set<string>();
const on = { muted: none, quiet: false };
const scr = (dnd: boolean, visible: boolean, breakThrough = true): Screen => ({ dnd, visible, breakThrough });

const slack = { app: "Slack", source: "desktop:slack", urgency: 1 as const };
const news = { app: "agentglass", source: "ci", urgency: 1 as const };
const gate = { app: "gate", source: "gate", urgency: 2 as const, key: "gate:h1" };
const asked = { app: "agentglass", source: "ci", urgency: 1 as const, asked: true };

const where = (n: Parameters<typeof whereItShows>[0], s: Screen, p = on) => whereItShows(n, deliveryFor(n, p), s);

describe("other apps", () => {
  test("DND off: the desktop shows its own popup, agentglass only keeps the row", () => {
    expect(where(slack, scr(false, true))).toEqual({ card: false, desktop: false });
    expect(deliveryFor(slack, on).keep).toBe(true);
  });
  test("DND on and the window visible: an agentglass card", () => {
    expect(where(slack, scr(true, true))).toEqual({ card: true, desktop: false });
  });
  test("never a desktop popup from us, hidden or not", () => {
    expect(where(slack, scr(true, false))).toEqual({ card: false, desktop: false });
    expect(where(slack, scr(false, false))).toEqual({ card: false, desktop: false });
  });
});

describe("agentglass news", () => {
  test("window visible: a card, DND on or off", () => {
    expect(where(news, scr(false, true))).toEqual({ card: true, desktop: false });
    expect(where(news, scr(true, true))).toEqual({ card: true, desktop: false });
  });
  test("window hidden: a desktop popup only with DND off", () => {
    expect(where(news, scr(false, false))).toEqual({ card: false, desktop: true });
    expect(where(news, scr(true, false))).toEqual({ card: false, desktop: false });
  });
  test("the break-through switch is only for an agent that waits", () => {
    expect(where(news, scr(true, false, true))).toEqual({ card: false, desktop: false });
  });
});

describe("an agent that waits on you (decided: option A)", () => {
  test("visible: a card under any DND", () => {
    expect(where(gate, scr(false, true))).toEqual({ card: true, desktop: false });
    expect(where(gate, scr(true, true))).toEqual({ card: true, desktop: false });
  });
  test("hidden, DND on: ONE desktop popup while 'break through DND' is on", () => {
    expect(where(gate, scr(true, false, true))).toEqual({ card: false, desktop: true });
  });
  test("hidden, DND on, break-through off (option B): it waits in the bell", () => {
    expect(where(gate, scr(true, false, false))).toEqual({ card: false, desktop: false });
    expect(deliveryFor(gate, on)).toMatchObject({ keep: true, badge: true });
  });
  test("hidden, DND off: a desktop popup", () => {
    expect(where(gate, scr(false, false, false))).toEqual({ card: false, desktop: true });
  });
  test("News pop-ups off, Silence all, Bell only and a mute do not reach it", () => {
    const hard = { muted: new Set(["gate", "agentglass"]), quiet: true, silence: true, rules: { agentglass: "bell" as const } };
    expect(where(gate, scr(true, true), hard)).toEqual({ card: true, desktop: false });
    expect(where(asked, scr(true, true), hard)).toEqual({ card: true, desktop: false });
  });
  test("an asked-for watch counts as waiting; a desktop note marked critical does not", () => {
    expect(waitsOnYou(asked)).toBe(true);
    expect(waitsOnYou({ ...slack, urgency: 2 })).toBe(false);
  });
  test("an open hold waits; a gate note with no hold behind it does not break through DND", () => {
    expect(waitsOnYou(gate)).toBe(true);
    const didNotTake = { app: "gate", source: "gate", urgency: 2 as const };
    expect(waitsOnYou(didNotTake)).toBe(false);
    expect(where(didNotTake, scr(true, false, true))).toEqual({ card: false, desktop: false });
  });
});

describe("the two switches and the per-app rule", () => {
  test("News pop-ups off: news goes to the bell only, still badged", () => {
    const quiet = { muted: none, quiet: true };
    expect(where(news, scr(true, true), quiet)).toEqual({ card: false, desktop: false });
    expect(deliveryFor(news, quiet)).toEqual({ keep: true, badge: true, interrupt: false });
  });
  test("Silence all: kept, no badge, no pop-up", () => {
    expect(deliveryFor(news, { ...on, silence: true })).toEqual({ keep: true, badge: false, interrupt: false });
    expect(deliveryFor(slack, { ...on, silence: true })).toEqual({ keep: true, badge: false, interrupt: false });
  });
  test("Bell only for one app: kept and badged, no pop-up; other apps still pop", () => {
    const p = { ...on, rules: { "desktop:slack": "bell" as const } };
    expect(deliveryFor(slack, p)).toEqual({ keep: true, badge: true, interrupt: false });
    expect(deliveryFor({ ...slack, source: "desktop:mail" }, p).interrupt).toBe(true);
  });
  test("agentglass's own sources share the one 'agentglass' rule", () => {
    expect(ruleFor("ci", { agentglass: "bell" })).toBe("bell");
    expect(ruleFor("lantern", { agentglass: "bell" })).toBe("bell");
    expect(ruleFor("desktop:agentglass", { agentglass: "bell" })).toBe("popup");
  });
  test("screenshot tools and music players are Bell only by default; a rule wins", () => {
    expect(defaultRule("desktop:hyprshot")).toBe("bell");
    expect(defaultRule("desktop:spotify")).toBe("bell");
    expect(defaultRule("desktop:slack")).toBe("popup");
    expect(ruleFor("desktop:spotify", { "desktop:spotify": "popup" })).toBe("popup");
  });
});

describe("migration of the old Volume switches", () => {
  const store = (init: Record<string, string>) => {
    const m = new Map(Object.entries(init));
    return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
  };
  test("Normal (quiet off, own alerts off) becomes 'agentglass news: Bell only'", () => {
    const st = store({ "agentglass.sysNotify.quiet": "0", "agentglass.appNotify": "0" });
    expect(migrateAppRules(st)).toEqual({ agentglass: "bell" });
    expect(JSON.parse(st.m.get(RULES_KEY)!)).toEqual({ agentglass: "bell" });
    expect(st.m.has("agentglass.appNotify")).toBe(false);
    // News pop-ups is the quiet flag read the other way up: untouched.
    expect(st.m.get("agentglass.sysNotify.quiet")).toBe("0");
  });
  test("Loud (quiet off, own alerts on) adds no rule", () => {
    const st = store({ "agentglass.sysNotify.quiet": "0", "agentglass.appNotify": "1" });
    expect(migrateAppRules(st)).toEqual({});
    expect(st.m.has("agentglass.appNotify")).toBe(false);
  });
  test("Quiet (the default) adds no rule and keeps News pop-ups off", () => {
    const st = store({ "agentglass.appNotify": "0" });
    expect(migrateAppRules(st)).toEqual({});
    expect(st.m.has("agentglass.sysNotify.quiet")).toBe(false);
  });
  test("Quiet picked after Normal: the leftover own-alerts-off adds no rule", () => {
    const st = store({ "agentglass.sysNotify.quiet": "1", "agentglass.appNotify": "0" });
    expect(migrateAppRules(st)).toEqual({});
    expect(st.m.has("agentglass.appNotify")).toBe(false);
    expect(st.m.get("agentglass.sysNotify.quiet")).toBe("1");
  });
  test("a rule the person already set is kept, and a second read changes nothing", () => {
    const st = store({ [RULES_KEY]: JSON.stringify({ agentglass: "popup", "desktop:slack": "bell", junk: 3 }), "agentglass.sysNotify.quiet": "0", "agentglass.appNotify": "0" });
    expect(migrateAppRules(st)).toEqual({ agentglass: "popup", "desktop:slack": "bell" });
    expect(migrateAppRules(st)).toEqual({ agentglass: "popup", "desktop:slack": "bell" });
  });
  test("a broken stored value reads as no rules, not a crash", () => {
    expect(migrateAppRules(store({ [RULES_KEY]: "{not json" }))).toEqual({});
  });
});

describe("the Apps list", () => {
  test("agentglass news first, then each app seen, by name; muted reads as Mute; defaults are marked", async () => {
    const { appRows } = await import("../src/lib/notePolicy.ts");
    const rows = appRows(["desktop:slack", "ci", "desktop:hyprshot", "desktop:slack"], { "desktop:mail": "bell" }, new Set(["desktop:weather"]));
    expect(rows.map((r) => [r.source, r.choice, r.byDefault])).toEqual([
      ["agentglass", "popup", false],
      ["desktop:hyprshot", "bell", true],
      ["desktop:mail", "bell", false],
      ["desktop:slack", "popup", false],
      ["desktop:weather", "mute", false],
    ]);
  });
});
