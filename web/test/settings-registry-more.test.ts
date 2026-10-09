/*
 * The second batch of settings defs: the rest of Terminal, the safe part of
 * Notifications, the search engine, what Tasks shows, and the single-key
 * shortcuts.
 *
 * Same promises as settings-registry.test.ts, for the new ids: a def stores the
 * bytes the pref module's own setter stores, a bad value stores nothing, and a
 * refusal by the pref module itself (a key already bound, the last task source)
 * reaches the caller in the module's words. The second half is the other side
 * of the ledger: what is NOT a def, held so that adding one is a decision.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
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
stubGlobal("document", { documentElement: { setAttribute: () => {}, getAttribute: () => null, style: { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => "" } } });
stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
stubGlobal("navigator", { webdriver: true, userAgent: "Linux" });
stubGlobal("window", new EventTarget());

const R = await import("../src/lib/settingsRegistry.ts");
const termPrefs = await import("../src/lib/termPrefs.ts");
const focusPref = await import("../src/lib/termFocusPref.ts");
const paneActions = await import("../src/lib/paneActionsPref.ts");
const tabGroups = await import("../src/lib/tabGroups.ts");
const sysNotify = await import("../src/lib/sysNotify.ts");
const ci = await import("../src/lib/ciNotifyPref.ts");
const talk = await import("../src/lib/talkNotify.ts");
const browserPrefs = await import("../src/lib/browserPrefs.ts");
const landing = await import("../src/lib/taskLanding.ts");
const sources = await import("../src/lib/taskSources.ts");
const keybindings = await import("../src/lib/keybindings.ts");

const def = (id: string) => R.SETTING_DEFS.find((d) => d.id === id)!;
const snapshot = () => JSON.stringify([...store].sort());
const fresh = (fn: () => void) => { store.clear(); fn(); return snapshot(); };
const NEW = ["terminal.focusFollowsMouse", "terminal.paneBar", "terminal.copyOnSelect", "terminal.noteEditor", "terminal.tabGroups", "terminal.tabGroupRules", "terminal.scrollback", "terminal.wordSeparators", "notifications.quiet", "notifications.ciOnlyApproved", "notifications.talk", "browser.searchEngine", "tasks.landing", "tasks.source.github", "tasks.source.local", "tasks.source.clickup"];

beforeEach(() => { store.clear(); sources.__forgetTaskSources(); keybindings.resetBindings(); });
// The shared keybindings module keeps the rebound key past this file.
afterAll(() => { keybindings.resetBindings(); });

describe("a def stores what the pref module's own setter stores", () => {
  const cases: [string, unknown, () => void][] = [
    ["terminal.focusFollowsMouse", true, () => focusPref.setFocusFollowsMouse(true)],
    ["terminal.paneBar", false, () => paneActions.setPaneActionsMode("off")],
    ["terminal.copyOnSelect", false, () => termPrefs.setCopyOnSelect(false)],
    ["terminal.noteEditor", "nvim", () => termPrefs.setNoteEditor("nvim")],
    ["terminal.tabGroups", false, () => tabGroups.setTabGroupsOn(false)],
    ["terminal.tabGroupRules", "orb=orbit, ops=infra", () => tabGroups.setTabGroupRulesText("orb=orbit, ops=infra")],
    ["terminal.scrollback", 25000, () => termPrefs.setScrollback(25000)],
    ["terminal.wordSeparators", " ()[]", () => termPrefs.setWordSeparators(" ()[]")],
    ["notifications.quiet", false, () => sysNotify.setNotifyQuiet(false)],
    ["notifications.ciOnlyApproved", false, () => ci.setCiOnlyApproved(false)],
    ["notifications.talk", "reviews", () => talk.setTalkNotify("reviews")],
    ["browser.searchEngine", "bing", () => browserPrefs.setSearchEngine("bing")],
    ["tasks.landing", "github", () => landing.setTaskLanding("github")],
    ["tasks.source.clickup", false, () => sources.setTaskSourceShown("clickup", false)],
    ["keys.binding.view.git", "q", () => keybindings.rebind("view.git", "q")],
  ];
  for (const [id, value, legacy] of cases) {
    it(id, () => {
      const viaDef = fresh(() => { expect(def(id).set(value).ok).toBe(true); });
      sources.__forgetTaskSources(); keybindings.resetBindings();
      const viaSetter = fresh(legacy);
      expect(viaDef).toBe(viaSetter);
      expect(def(id).get()).toBe(value as never);
    });
  }

  it("every default is what a fresh machine reads", () => {
    for (const id of NEW) expect(def(id).get(), id).toBe(def(id).default);
    for (const d of R.SETTING_DEFS.filter((x) => x.id.startsWith("keys.binding."))) expect(d.get(), d.id).toBe(d.default);
  });
});

describe("a value that is not valid is refused and stores nothing", () => {
  const bad: [string, unknown[]][] = [
    ["terminal.focusFollowsMouse", ["true", 1, null]],
    ["terminal.paneBar", ["hover", "off", 0]],
    ["terminal.noteEditor", ["emacs", true, ""]],
    ["terminal.scrollback", [5000, "4000", 0, null]],
    ["terminal.wordSeparators", ["x".repeat(201), 5, null]],
    ["terminal.tabGroupRules", ["x".repeat(201), false, null]],
    ["notifications.talk", ["all", true, ""]],
    ["notifications.quiet", ["off", 0]],
    ["browser.searchEngine", ["yahoo", "DuckDuckGo", 1, "https://evil.example/?q="]],
    ["tasks.landing", ["jira", "", 1]],
    ["keys.binding.view.git", ["", 7, null, "x".repeat(17)]],
  ];
  for (const [id, values] of bad) {
    it(id, () => {
      for (const v of values) {
        const before = snapshot();
        expect(def(id).set(v).ok, `${id} accepted ${String(v)}`).toBe(false);
        expect(snapshot()).toBe(before);
      }
    });
  }
});

describe("a refusal by the pref module itself reaches the caller in its words", () => {
  it("a key another action holds is refused and nothing moves", () => {
    const held = keybindings.bindings()["view.diff"];
    const r = def("keys.binding.view.git").set(held);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("already bound");
    expect(keybindings.bindings()["view.git"]).toBe(keybindings.DEFAULTS["view.git"]);
  });

  it("a reserved key and a multi-character key are refused in the module's words", () => {
    expect((def("keys.binding.view.git").set("Enter") as { error: string }).error).toContain("single character");
    expect((def("keys.binding.view.git").set("1") as { error: string }).error).toContain("reserved");
  });

  it("the last visible task source stays visible, and the caller hears it", () => {
    expect(def("tasks.source.github").set(false).ok).toBe(true);
    expect(def("tasks.source.local").set(false).ok).toBe(true);
    const before = snapshot();
    const r = def("tasks.source.clickup").set(false);
    expect(r).toEqual({ ok: false, error: "at least one task source stays shown" });
    expect(snapshot()).toBe(before);
    expect(sources.taskSourceShown("clickup")).toBe(true);
  });
});

describe("the agent's side, for the new ids", () => {
  const api = () => R.makeSettings(R.SETTING_DEFS);

  it("every new def is level 2 and none is a secret", () => {
    for (const id of NEW) { expect(def(id).level, id).toBe(2); expect(def(id).secret, id).toBeUndefined(); }
  });

  it("a write reports what it replaced and the undo puts it back", () => {
    const s = api();
    const w = s.set("browser.searchEngine", "bing");
    expect(w).toMatchObject({ ok: true, prev: def("browser.searchEngine").default, value: "bing" });
    expect(browserPrefs.searchEngine()).toBe("bing");
    expect(s.undo((w as { undo: string }).undo)).toBe(true);
    expect(browserPrefs.searchEngine()).toBe(def("browser.searchEngine").default as never);
  });

  it("undoing a rebind puts the old key back", () => {
    const s = api();
    const w = s.set("keys.binding.view.git", "q");
    expect(w.ok).toBe(true);
    expect(keybindings.bindings()["view.git"]).toBe("q");
    s.undo((w as { undo: string }).undo);
    expect(keybindings.bindings()["view.git"]).toBe(keybindings.DEFAULTS["view.git"]);
  });

  it("a value already set is unchanged and leaves no chip", () => {
    const r = api().set("notifications.quiet", true);
    expect(r).toMatchObject({ ok: true, unchanged: true });
  });

  it("settings.list shows them as writable", () => {
    const l = api().list();
    for (const id of NEW) expect(l.find((x) => x.id === id)?.writable, id).toBe(true);
  });
});

describe("what is NOT a def, held so that adding one is a decision", () => {
  const api = () => R.makeSettings(R.SETTING_DEFS);
  const NEVER = [
    "notifications.sound", "notifications.none", "notifications.kind.blocked", "notifications.channel.desktop", "notifications.voice",
    "notifications.alarmVoice", "notifications.own", "notifications.mirror", "notifications.mirrorDetail",
    "browser.homePage", "browser.importHistory", "browser.importBookmarks", "browser.cookies",
    "terminal.rightClickPaste", "terminal.runsOn",
    "keys.chord.git", "keys.appChord.files.palette",
    "lantern.nudge", "lantern.watch", "remote.exposed", "connections.apiToken", "clickup.token", "plugins.master", "hooks.gate", "understudy.level",
  ];
  it("each answers not exposed, for a read and for a write", () => {
    const s = api();
    for (const id of NEVER) {
      expect(s.get(id), id).toEqual({ ok: false, error: "not exposed" });
      expect(s.set(id, true), id).toEqual({ ok: false, error: "not exposed" });
    }
  });

  it("no def is on a page that is left out on purpose", () => {
    for (const page of Object.keys(R.NOT_EXPOSED_ON_PURPOSE)) expect(R.SETTING_DEFS.filter((d) => d.page === page).map((d) => d.id), page).toEqual([]);
  });

  it("the pages with defs are exactly the migrated ones", () => {
    const pages = new Set(R.SETTING_DEFS.map((d) => d.page));
    expect([...pages].sort()).toEqual(Object.keys(R.MIGRATED).sort());
  });
});
