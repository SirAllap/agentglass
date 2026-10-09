/*
 * The settings registry: the one definition a Settings row and an agent's
 * `settings.set` both go through.
 *
 * "Both go through" is the claim, so the first tests compare a def's write with
 * the pref module's own setter on a fresh store and expect the same bytes. The
 * rest are the properties that make an agent write safe to leave on: a bad value
 * is refused, a secret is never read or written, a def with no level is not
 * writable, and every write can be taken back.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();

const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage);
stubGlobal("location", new URL("http://localhost:5173/"));
// The theme paints the root element; a map is enough to read back what was set.
const attrs = new Map<string, string>();
stubGlobal("document", {
  documentElement: {
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    style: { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => "" },
  },
});
stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
stubGlobal("navigator", { webdriver: true, userAgent: "Linux" });
stubGlobal("window", new EventTarget());

const R = await import("../src/lib/settingsRegistry.ts");
const diffPrefs = await import("../src/lib/diffPrefs.ts");
const termPrefs = await import("../src/lib/termPrefs.ts");
const termRenderer = await import("../src/lib/termRenderer.ts");
const views = await import("../src/components/workspace/views.ts");

const def = (id: string) => R.SETTING_DEFS.find((d) => d.id === id)!;
const snapshot = () => JSON.stringify([...store].sort());
const fresh = (fn: () => void) => { store.clear(); fn(); return snapshot(); };

beforeEach(() => { store.clear(); attrs.clear(); attrs.set("data-theme", "graphite"); views.resetRail(); });

describe("a def writes what the pref module's own setter writes", () => {
  // value to hand the def, and the call the Settings row used before it was bound.
  const cases: [string, unknown, () => void][] = [
    ["diff.wrap", true, () => diffPrefs.setDiffWrap(true)],
    ["diff.split", "inline", () => diffPrefs.setDiffSplit(false)],
    ["diff.syntaxTheme", "github-dark", () => diffPrefs.setDiffThemePref("github-dark")],
    ["terminal.renderer", "canvas", () => termRenderer.setRendererPref("canvas")],
    ["terminal.font", "fira", () => termPrefs.setTermFont("fira")],
    ["terminal.fontSize", 16, () => termPrefs.setTermSize(16)],
    ["terminal.lineHeight", 1.25, () => termPrefs.setTermLineHeight(1.25)],
    ["terminal.cursor", "bar", () => termPrefs.setTermCursor("bar")],
    ["rail.place.docker", "hidden", () => views.moveView("docker", "hidden", 0)],
  ];
  for (const [id, value, legacy] of cases) {
    it(id, () => {
      const viaDef = fresh(() => { expect(def(id).set(value).ok).toBe(true); });
      const viaSetter = fresh(legacy);
      expect(viaDef).toBe(viaSetter);
      expect(def(id).get()).toBe(value as never);
    });
  }

  it("the same defaults the row shows as its dot", () => {
    expect(def("diff.wrap").default).toBe(diffPrefs.DEFAULT_WRAP);
    expect(def("terminal.fontSize").default).toBe(termPrefs.DEFAULT_SIZE);
    expect(def("terminal.lineHeight").default).toBe(termPrefs.DEFAULT_LINE_HEIGHT);
    for (const d of R.SETTING_DEFS.filter((x) => x.id.startsWith("rail.place."))) {
      expect(d.get(), d.id).toBe(d.default);
    }
  });
});

describe("a value that is not valid is refused and stores nothing", () => {
  const bad: [string, unknown[]][] = [
    ["diff.wrap", ["true", 1, null, undefined, {}]],
    ["diff.split", ["both", true, ""]],
    ["diff.syntaxTheme", ["not-a-theme", 3, null]],
    ["terminal.renderer", ["webgl2", "OFF", 0]],
    ["terminal.font", ["comic-sans", 3, null]],
    ["terminal.fontSize", [8, 23, 13.5, "13", NaN, Infinity]],
    ["terminal.lineHeight", [0.9, 2.5, "1.2", NaN]],
    ["terminal.cursor", ["beam", 1, ""]],
    ["appearance.mode", ["custom", "sepia", 1, ""]],
    ["appearance.theme", ["no-such-palette", 4, null]],
    ["appearance.accent", ["magenta-ish", 7, null]],
    ["rail.place.docker", ["middle", "work ", 0, null]],
  ];
  for (const [id, values] of bad) {
    it(id, () => {
      for (const v of values) {
        const before = snapshot();
        const r = def(id).set(v);
        expect(r.ok, `${id} accepted ${String(v)}`).toBe(false);
        expect(snapshot()).toBe(before);
      }
    });
  }

  it("the desktop mode is only valid where a desktop palette exists", () => {
    expect(def("appearance.mode").set("desktop").ok).toBe(false);
  });
});

describe("migrations inside the pref module still apply", () => {
  it("a legacy renderer value reads as its new name, through the def", () => {
    store.set(termRenderer.RENDERER_KEY, "off");
    expect(def("terminal.renderer").get()).toBe("dom");
  });
  it("a hand-edited line height is clamped on read, so the agent reads what xterm gets", () => {
    store.set("agentglass-term-line-height", "9");
    expect(def("terminal.lineHeight").get()).toBe(termPrefs.LINE_HEIGHT_MAX);
  });
  it("the default is stored as an absent key, as the setter does it", () => {
    def("diff.wrap").set(true);
    expect(store.has("agentglass.diff.wrap")).toBe(true);
    def("diff.wrap").set(false);
    expect(store.has("agentglass.diff.wrap")).toBe(false);
  });
});

describe("the agent's side", () => {
  const api = () => R.makeSettings(R.SETTING_DEFS);

  it("an id that has no def is not exposed, for a read and for a write", () => {
    const s = api();
    expect(s.get("notifications.sound")).toEqual({ ok: false, error: "not exposed" });
    expect(s.set("notifications.sound", true)).toEqual({ ok: false, error: "not exposed" });
    expect(s.get(42)).toEqual({ ok: false, error: "not exposed" });
    expect(s.set("__proto__", 1)).toEqual({ ok: false, error: "not exposed" });
  });

  it("a write returns what it replaced and a handle that puts it back", () => {
    const s = api();
    const r = s.set("diff.wrap", true);
    expect(r).toMatchObject({ ok: true, id: "diff.wrap", prev: false, value: true });
    expect(def("diff.wrap").get()).toBe(true);
    expect(s.undo((r as { undo: string }).undo)).toBe(true);
    expect(def("diff.wrap").get()).toBe(false);
    // Once.
    expect(s.undo((r as { undo: string }).undo)).toBe(false);
  });

  it("undoing a rail move puts the whole drawer back, not just the one view", () => {
    const s = api();
    const before = JSON.stringify(views.railIds(views.loadRail()));
    const r = s.set("rail.place.docker", "hidden") as { undo: string };
    expect(JSON.stringify(views.railIds(views.loadRail()))).not.toBe(before);
    s.undo(r.undo);
    expect(JSON.stringify(views.railIds(views.loadRail()))).toBe(before);
  });

  it("undoing a palette pick puts the mode back as well, custom included", () => {
    const s = api();
    // A custom palette first (what a grid pick leaves behind).
    expect(def("appearance.theme").set("nord").ok).toBe(true);
    expect(def("appearance.mode").get()).toBe("custom");
    const r = s.set("appearance.mode", "light") as { undo: string };
    expect(def("appearance.mode").get()).toBe("light");
    s.undo(r.undo);
    expect(def("appearance.mode").get()).toBe("custom");
    expect(attrs.get("data-theme")).toBe("nord");
  });

  it("a write of the value it already has changes nothing, shows no chip and has no handle", () => {
    const s = api();
    const r = s.set("diff.wrap", false);
    expect(r).toMatchObject({ ok: true, prev: false, value: false, undo: "", unchanged: true });
    expect(s.changes()).toHaveLength(0);
    expect(s.undo("")).toBe(false);
  });

  it("a refused write leaves no chip and no handle", () => {
    const s = api();
    expect(s.set("terminal.fontSize", 99).ok).toBe(false);
    expect(s.changes()).toHaveLength(0);
  });

  it("the chip shows the newest change still on offer, and each is taken once", () => {
    const s = api();
    const a = s.set("diff.wrap", true) as { undo: string };
    const b = s.set("terminal.cursor", "bar") as { undo: string };
    expect(R.shownChange(s.changes())?.handle).toBe(b.undo);
    s.dismiss(b.undo);
    expect(R.shownChange(s.changes())?.handle).toBe(a.undo);
    s.undo(a.undo);
    expect(R.shownChange(s.changes())).toBeNull();
  });

  it("only the last twenty writes are remembered", () => {
    const s = api();
    for (let i = 0; i < R.AGENT_CHANGES_KEPT + 5; i++) s.set("diff.wrap", i % 2 === 0);
    expect(s.changes()).toHaveLength(R.AGENT_CHANGES_KEPT);
  });

  it("changes are announced with who made them: a row, an agent, an undo", () => {
    const s = api();
    const seen: string[] = [];
    const off = R.subscribeSettings((c) => seen.push(`${c.id}:${c.by}`));
    def("diff.wrap").set(true);
    const r = s.set("diff.wrap", false) as { undo: string };
    s.undo(r.undo);
    off();
    expect(seen).toEqual(["diff.wrap:row", "diff.wrap:agent", "diff.wrap:undo"]);
  });

  it("list shows what is exposed and whether an agent may write it", () => {
    const l = api().list();
    expect(l.map((x) => x.id)).toContain("terminal.fontSize");
    expect(l.every((x) => x.writable)).toBe(true);
    expect(l.find((x) => x.id === "diff.wrap")).toMatchObject({ page: "diff", value: false });
  });
});

describe("deny by default", () => {
  const stub = (over: Partial<import("../src/lib/settingsRegistry.ts").SettingDef>) => {
    let v: string | number | boolean = "stored";
    const d: import("../src/lib/settingsRegistry.ts").SettingDef = {
      id: "x.thing", page: "x", section: "", label: "Thing", default: "", get: () => v,
      validate: (raw) => (typeof raw === "string" ? raw : null),
      set: (raw) => { if (typeof raw !== "string") return { ok: false, error: "bad" }; const prev = v; v = raw; return { ok: true, prev, value: raw, revert: () => { v = prev; } }; },
      ...over,
    };
    return d;
  };

  it("a def with no level is level 3 and an agent cannot write it", () => {
    const s = R.makeSettings([stub({})]);
    const r = s.set("x.thing", "new");
    expect(r.ok).toBe(false);
    expect(s.get("x.thing")).toMatchObject({ ok: true, value: "stored" });
  });

  it("level 3 is refused here as well, level 2 is allowed", () => {
    expect(R.makeSettings([stub({ level: 3 })]).set("x.thing", "n").ok).toBe(false);
    expect(R.makeSettings([stub({ level: 2 })]).set("x.thing", "n").ok).toBe(true);
    expect(R.AGENT_MAX_LEVEL).toBe(2);
  });

  it("a secret answers only that it is set, is listed without a value, and cannot be written", () => {
    const s = R.makeSettings([stub({ id: "connections.apiToken", secret: true, level: 2 })]);
    const g = s.get("connections.apiToken");
    expect(g).toEqual({ ok: true, id: "connections.apiToken", set: true });
    expect(JSON.stringify(g)).not.toContain("stored");
    const l = s.list()[0]!;
    expect(l).toMatchObject({ secret: true, writable: false });
    expect("value" in l).toBe(false);
    const w = s.set("connections.apiToken", "leak");
    expect(w.ok).toBe(false);
    expect(s.get("connections.apiToken")).toEqual({ ok: true, id: "connections.apiToken", set: true });
  });
});

describe("no def hides a secret by accident", () => {
  const SENSITIVE = /token|key|secret|password|credential/i;
  it("an id that looks sensitive is marked secret", () => {
    const bad = R.SETTING_DEFS.filter((d) => SENSITIVE.test(d.id) && !d.secret).map((d) => d.id);
    expect(bad).toEqual([]);
  });
  it("the check sees an id written in the source, not only the ones that are built", async () => {
    const src = await Bun.file(new URL("../src/lib/settingsRegistry.ts", import.meta.url)).text();
    const lines = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    const ids = lines.join("\n").match(/\bid: "([^"]+)"/g) ?? [];
    expect(ids.length).toBeGreaterThan(8);
    const offenders = ids.filter((i) => SENSITIVE.test(i));
    // A sensitive-looking literal must sit next to `secret: true` on the same def.
    for (const o of offenders) expect(lines.join("\n")).toMatch(new RegExp(`${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*secret: true`));
  });
});
