import { beforeAll, describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DESKTOP, OUR_RULE, TEST_APP, TEST_GATE_KEY, TEST_KINDS, deliveryFor, routeLabel, testNoteShape, testOutcome, testRoute, whereItShows,
  type AppRule, type PolicyState, type Screen, type TestKind,
} from "../src/lib/notePolicy.ts";
import type { PendingGate } from "../../shared/types.ts";
import { NOTIFY_TEST_KINDS } from "../../shared/uiActions.ts";
import { TEST_GAP_MS, askTestNote, refuseTest, type DoorState } from "../src/lib/notifyTestDoor.ts";

const stubGlobal = globalStubs();
const cell = new Map<string, string>();
let gateForNote: typeof import("../src/lib/gateStore.ts")["gateForNote"];
beforeAll(async () => {
  stubGlobal("localStorage", {
    getItem: (k: string) => cell.get(k) ?? null,
    setItem: (k: string, v: string) => { cell.set(k, v); },
    removeItem: (k: string) => { cell.delete(k); },
  });
  stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000" });
  ({ gateForNote } = await import("../src/lib/gateStore.ts"));
});

// A test notification is only worth sending if it lands where a real one would.
// So the routing of each test kind is held to a real note of the same kind
// (the fields the real callers send) across every combination of the settings
// and the screen that routing reads.

const REAL: Record<TestKind, Parameters<typeof deliveryFor>[0] & { key?: string }> = {
  // useLive.ts, a green check: recordNote({ app: "agentglass", source: "ci", urgency: 1 })
  news: { app: "agentglass", source: "ci", urgency: 1 },
  // gateStore.ts announce: app "gate", no source, urgency 2, keyed `gate:<id>`
  waits: { app: "gate", urgency: 2, key: "gate:abc123" },
  // sysNotify.ts receiveMirrored: the source is `desktop:<app>`
  other: { app: TEST_APP, source: `${DESKTOP}${TEST_APP}`, urgency: 1 },
};

const bools = [false, true];
function* policies(): Generator<PolicyState> {
  const ruleSets: Record<string, AppRule>[] = [{}, { [OUR_RULE]: "bell" }, { [`${DESKTOP}${TEST_APP}`]: "bell" }, { [OUR_RULE]: "popup", [`${DESKTOP}${TEST_APP}`]: "popup" }];
  const muteSets = [new Set<string>(), new Set([`${DESKTOP}${TEST_APP}`]), new Set(["ci"]), new Set(["gate"])];
  for (const quiet of bools) for (const silence of bools) for (const rules of ruleSets) for (const muted of muteSets) {
    yield { quiet, silence, rules, muted };
  }
}
function* screens(): Generator<Screen> {
  for (const dnd of bools) for (const visible of bools) for (const breakThrough of bools) yield { dnd, visible, breakThrough };
}

describe("a test note routes as a real one", () => {
  it("for every kind, every pref combination and every screen", () => {
    let n = 0;
    for (const kind of TEST_KINDS) for (const p of policies()) for (const s of screens()) {
      const real = REAL[kind];
      const d = deliveryFor(real, p);
      expect(testRoute(kind, p, s), `${kind} ${JSON.stringify({ ...p, muted: [...p.muted] })} ${JSON.stringify(s)}`)
        .toEqual({ ...d, ...whereItShows(real, d, s) });
      n++;
    }
    expect(n).toBe(3 * 2 * 2 * 4 * 4 * 8);
  });

  it("the waiting kind always reaches the person, as a held agent does", () => {
    for (const p of policies()) for (const s of screens()) {
      const r = testRoute("waits", p, s);
      expect(r.interrupt).toBe(true);
      expect(r.card || r.desktop || (s.dnd && !s.visible && !s.breakThrough)).toBe(true);
    }
  });

  it("says where it went in words", () => {
    const quietOff: PolicyState = { quiet: false, muted: new Set() };
    expect(routeLabel("news", testRoute("news", quietOff, { dnd: false, visible: true, breakThrough: false }), { dnd: false })).toBe("agentglass card");
    expect(routeLabel("news", testRoute("news", quietOff, { dnd: false, visible: false, breakThrough: false }), { dnd: false })).toBe("desktop popup");
    expect(routeLabel("other", testRoute("other", quietOff, { dnd: false, visible: true, breakThrough: false }), { dnd: false })).toBe("bell only (a real app's note also gets the desktop's own popup)");
    expect(routeLabel("other", testRoute("other", quietOff, { dnd: true, visible: false, breakThrough: false }), { dnd: true })).toBe("bell only");
    const muted: PolicyState = { quiet: false, muted: new Set([`${DESKTOP}${TEST_APP}`]) };
    expect(routeLabel("other", testRoute("other", muted, { dnd: true, visible: true, breakThrough: false }), { dnd: true })).toBe("muted: not kept");
  });

  it("the door and the policy name the same kinds", () => {
    expect([...NOTIFY_TEST_KINDS]).toEqual([...TEST_KINDS]);
  });
});

describe("the test gate card never creates a real hold", () => {
  it("its key matches no hold the gate store could have", () => {
    const gates = ["abc", "test:gate", "1", ""].map((id) => ({ id }) as PendingGate);
    expect(testNoteShape("waits").key).toBe(TEST_GATE_KEY);
    expect(gateForNote({ key: `${TEST_GATE_KEY}:7` }, gates)).toBeNull();
    expect(gateForNote({ key: TEST_GATE_KEY }, gates)).toBeNull();
  });

  it("sending one writes a row and a card, and nothing to the gate store", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "lib", "sysNotify.ts"), "utf8");
    const a = src.indexOf("export function sendTestNote(");
    expect(a).toBeGreaterThan(-1);
    const body = src.slice(a, src.indexOf("\nfunction attach()", a));
    expect(body).toContain("TEST_GATE_KEY");
    expect(body).not.toMatch(/gateStore|answerGate|announce|reconcile|pollGates/);
    expect(src).not.toMatch(/from "\.\/gateStore\.ts"/);
  });
});

// Contract (notifications v2): with News pop-ups on and agentglass away, a PR
// check is a desktop popup, unless the agentglass rule says Bell only.
describe("a real PR check follows the news row of the table", () => {
  const check = REAL.news;
  const route = (p: PolicyState, s: Screen) => { const d = deliveryFor(check, p); return { ...d, ...whereItShows(check, d, s) }; };
  const away: Screen = { dnd: false, visible: false, breakThrough: false };
  const here: Screen = { dnd: false, visible: true, breakThrough: false };
  const newsOn: PolicyState = { quiet: false, muted: new Set() };

  it("News on, window hidden: a desktop popup", () => {
    expect(route(newsOn, away)).toMatchObject({ keep: true, interrupt: true, card: false, desktop: true });
  });
  it("News on, window focused: a card", () => {
    expect(route(newsOn, here)).toMatchObject({ keep: true, interrupt: true, card: true, desktop: false });
  });
  it("News off: bell only", () => {
    for (const s of [away, here]) expect(route({ quiet: true, muted: new Set() }, s)).toMatchObject({ keep: true, interrupt: false, card: false, desktop: false });
  });
  it("rule Bell only: bell only", () => {
    for (const s of [away, here]) expect(route({ ...newsOn, rules: { [OUR_RULE]: "bell" } }, s)).toMatchObject({ keep: true, badge: true, interrupt: false, card: false, desktop: false });
  });
  it("the real caller raises the popup the route asks for", () => {
    const live = readFileSync(join(import.meta.dir, "..", "src", "lib", "useLive.ts"), "utf8");
    const ci = live.slice(live.indexOf('if (frame.type === "ci")'), live.indexOf('if (frame.type === "gate")'));
    expect(ci).toContain("recordNews({");
    expect(ci).not.toContain("recordNote({");
    const src = readFileSync(join(import.meta.dir, "..", "src", "lib", "sysNotify.ts"), "utf8");
    const fn = src.slice(src.indexOf("export function recordNews("), src.indexOf("\n}\n", src.indexOf("export function recordNews(")));
    expect(fn).toMatch(/said\.desktop[\s\S]*popup\(/);
    const test = src.slice(src.indexOf("export function sendTestNote("), src.indexOf("\nfunction attach()"));
    expect(test).toContain("recordNews({");
    expect(test).not.toContain("raises no desktop popup today");
  });
});

// Contract: only an agent that waits on you breaks through. A red check is
// news (urgency 2 from useLive, not asked), unless a "Tell me when" watch armed it.
describe("a red PR check is news, not an agent waiting", () => {
  const red = { app: "agentglass", source: "ci", urgency: 2 as const };
  const watched = { ...red, asked: true };
  const route = (n: typeof red & { asked?: boolean }, p: PolicyState, s: Screen) => { const d = deliveryFor(n, p); return { ...d, ...whereItShows(n, d, s) }; };
  const newsOn: PolicyState = { quiet: false, muted: new Set() };
  const away: Screen = { dnd: false, visible: false, breakThrough: true };

  it("News off, window hidden: bell only", () => {
    expect(route(red, { quiet: true, muted: new Set() }, away)).toMatchObject({ keep: true, interrupt: false, card: false, desktop: false });
  });
  it("rule Bell only: bell only", () => {
    expect(route(red, { ...newsOn, rules: { [OUR_RULE]: "bell" } }, away)).toMatchObject({ keep: true, badge: true, interrupt: false, card: false, desktop: false });
  });
  it("Desktop DND on: no popup, even with break through on", () => {
    expect(route(red, newsOn, { ...away, dnd: true })).toMatchObject({ card: false, desktop: false });
  });
  it("an armed watch: pops up as the watch says, through News off and DND", () => {
    expect(route(watched, { quiet: true, muted: new Set() }, { ...away, dnd: true })).toMatchObject({ keep: true, interrupt: true, card: false, desktop: true });
    expect(route(watched, newsOn, { ...away, visible: true })).toMatchObject({ interrupt: true, card: true, desktop: false });
  });
  it("recordNews re-reads Desktop DND when the window is not in front", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "lib", "sysNotify.ts"), "utf8");
    const fn = src.slice(src.indexOf("export function recordNews("), src.indexOf("\n}\n", src.indexOf("export function recordNews(")));
    expect(fn).toMatch(/!windowFocused\(\)\) void refreshDesktopDnd\(\)\.then\(go\)/);
  });
});

// Review findings: the agent door cannot flood or break through, and the
// words say only what the send does.
describe("the agent door", () => {
  const fresh = (): DoorState => ({ pending: new Set(), last: new Map() });

  it("holds one test of each kind at a time, and one per 10 s per kind", () => {
    const st = fresh();
    expect(refuseTest(st, "waits", 0)).toBeNull();
    askTestNote("waits", 60, st, 0);
    expect(refuseTest(st, "waits", 1)).toContain("already waiting");
    expect(() => askTestNote("waits", 0, st, 1)).toThrow("already waiting");
    expect(refuseTest(st, "news", 1)).toBeNull();
    st.pending.delete("waits"); // as the timer does when it fires
    expect(refuseTest(st, "waits", TEST_GAP_MS - 1)).toContain("per 10 s");
    expect(refuseTest(st, "waits", TEST_GAP_MS)).toBeNull();
  });

  it("an agent's waits test never breaks through DND, Silence all or News off; the person's does", () => {
    const hiddenDnd: Screen = { dnd: true, visible: false, breakThrough: true };
    const on: PolicyState = { quiet: false, muted: new Set() };
    expect(testRoute("waits", on, hiddenDnd).desktop).toBe(true);
    expect(testRoute("waits", on, hiddenDnd, "agent").desktop).toBe(false);
    for (const p of policies()) for (const s of screens()) {
      const r = testRoute("waits", p, s, "agent");
      if (s.dnd && !s.visible) expect(r.desktop).toBe(false);
      if (p.silence || p.quiet) expect(r.interrupt).toBe(false);
    }
  });
});

describe("the label says only what the send does", () => {
  const on: PolicyState = { quiet: false, muted: new Set() };
  const hidden: Screen = { dnd: false, visible: false, breakThrough: false };

  it("Other app with DND off says bell only: no popup is drawn for a test", () => {
    const o = testOutcome("other", on, { dnd: false, visible: true, breakThrough: false }, { bell: true, desktop: true });
    expect(o.route.desktop).toBe(false);
    expect(o.label.startsWith("bell only")).toBe(true);
  });

  it("waits with blocked desktop off: no popup, and the label says bell only", () => {
    const o = testOutcome("waits", on, hidden, { bell: true, desktop: false });
    expect(o.route.desktop).toBe(false);
    expect(o.label).toBe("bell only");
    const up = testOutcome("waits", on, hidden, { bell: true, desktop: true });
    expect(up.route.desktop).toBe(true);
    expect(up.label).toBe("desktop popup");
    expect(testOutcome("waits", on, hidden, { bell: false, desktop: true }).sent).toBe(false);
  });

  it("the send raises the popup from the same route the label is built from", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "lib", "sysNotify.ts"), "utf8");
    const fn = src.slice(src.indexOf("export function sendTestNote("), src.indexOf("\nfunction attach()"));
    expect(fn).toContain("testOutcome(");
    expect(fn).toMatch(/if \(route\.desktop\) popupOf\(/);
    expect(fn).not.toMatch(/routeLabel\(|said\.desktop/);
  });
});
