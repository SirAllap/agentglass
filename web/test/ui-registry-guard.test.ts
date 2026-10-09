/*
 * A door the app grows must be a door an agent has, or a recorded decision that
 * it should not.
 *
 * agentglass is agent first: the owner opens a panel with a click or a chord,
 * and the same panel must open for an agent through /control, by the same
 * handler. Nothing can be made to notice that a NEW panel was added without its
 * registry entry, except a test that reads the places the app enumerates its own
 * surfaces and holds them against the registry. Three are enumerable by text:
 * the rail's views, Settings' pages and the app chords. An arbitrary onClick is
 * not (handlers cannot be listed by grep), and this does not pretend to cover
 * one; see docs/EXTENDING.md for the rule that does.
 *
 * Read as source for the same reason mutating-routes-guard.test.ts does:
 * importing Settings or the rail would want a DOM and nine panels to answer a
 * question about a list.
 *
 * To satisfy it a new surface gets an entry in shared/uiActions.ts (and a
 * handler, which tsc demands) or a line in NOT_AGENT_DOOR below with the reason
 * it is not one. A reason is a sentence; "later" is not one.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UI_ACTIONS, VIEW_IDS, SETTINGS_PAGE_IDS, type UiActionDef } from "../../shared/uiActions.ts";
import { UI_HANDLERS } from "../src/lib/uiActions.ts";

const ROOT = join(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** What is deliberately not an agent door, by surface kind, with the reason. */
const NOT_AGENT_DOOR: { views: Record<string, string>; settingsPages: Record<string, string>; chords: Record<string, string> } = {
  views: {},
  settingsPages: {},
  chords: {
    "pane.git": "acts on the focused terminal pane, which only the window knows; it needs a state read first (slice 2) and then a pane-addressed door",
    "pane.diff": "acts on the focused terminal pane, which only the window knows; it needs a state read first (slice 2) and then a pane-addressed door",
    "pane.pr": "acts on the focused terminal pane, which only the window knows; it needs a state read first (slice 2) and then a pane-addressed door",
    "pane.card": "acts on the focused terminal pane, which only the window knows; it needs a state read first (slice 2) and then a pane-addressed door",
  },
};

/* ── the places the app enumerates its own surfaces ─────────────────────── */

const viewsSrc = read("web/src/components/workspace/views.ts");
const railIds = (() => {
  const from = viewsSrc.indexOf("export const VIEWS");
  const to = viewsSrc.indexOf("export const VIEW_IDS");
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return [...viewsSrc.slice(from, to).matchAll(/\bid:\s*"([a-z]+)"/g)].map((x) => x[1]!);
})();

const settingsSrc = read("web/src/components/SettingsModal.tsx");
const settingsPageIds = (() => {
  const from = settingsSrc.indexOf("const TABS: {");
  expect(from, "SettingsModal no longer has a TABS list; this guard is reading the wrong code").toBeGreaterThan(-1);
  // The list ends at the first line that is only `];`, which no row of it is.
  const to = settingsSrc.indexOf("\n];", from);
  expect(to).toBeGreaterThan(from);
  return [...settingsSrc.slice(from, to).matchAll(/\{ id: "([a-z-]+)"/g)].map((x) => x[1]!);
})();

const keysSrc = read("web/src/lib/keybindings.ts");
const chordIds = (() => {
  const m = /export type AppChordId =([^;]+);/.exec(keysSrc);
  expect(m, "AppChordId moved; this guard is reading the wrong code").not.toBeNull();
  return [...m![1].matchAll(/"([a-z.]+)"/g)].map((x) => x[1]!);
})();

/** Every value an entry's enum argument accepts, per argument name. */
const enumValues = (id: keyof typeof UI_ACTIONS, arg: string): readonly string[] => {
  const a = (UI_ACTIONS[id] as UiActionDef).args[arg];
  return a && a.t === "enum" ? a.values : [];
};
const chordsInRegistry = new Set(Object.values(UI_ACTIONS as Record<string, UiActionDef>).flatMap((d) => d.chords ?? []));

describe("every surface the app enumerates is an agent door or a decided exception", () => {
  it("the guard reads what it thinks it reads", () => {
    expect(railIds.length).toBeGreaterThanOrEqual(13);
    expect(settingsPageIds.length).toBeGreaterThanOrEqual(23);
    expect(chordIds.length).toBeGreaterThanOrEqual(7);
  });

  it("every rail view opens through view.open", () => {
    const missing = railIds.filter((id) => !enumValues("view.open", "to").includes(id) && !(id in NOT_AGENT_DOOR.views));
    expect(missing, "add the view to VIEW_IDS in shared/uiActions.ts, or to NOT_AGENT_DOOR.views with a reason").toEqual([]);
  });

  it("every Settings page opens through settings.open", () => {
    const missing = settingsPageIds.filter((id) => !enumValues("settings.open", "page").includes(id) && !(id in NOT_AGENT_DOOR.settingsPages));
    expect(missing, "add the page to SETTINGS_PAGE_IDS in shared/uiActions.ts, or to NOT_AGENT_DOOR.settingsPages with a reason").toEqual([]);
  });

  it("every app chord is an entry's `chords` or a decided exception", () => {
    const missing = chordIds.filter((id) => !chordsInRegistry.has(id) && !(id in NOT_AGENT_DOOR.chords));
    expect(missing, "give an entry `chords: [id]` in shared/uiActions.ts, or add the chord to NOT_AGENT_DOOR.chords with a reason").toEqual([]);
  });
});

describe("the registry names only things that exist, and the exceptions are not stale", () => {
  it("no view id in the registry is one the rail does not have", () => {
    expect(VIEW_IDS.filter((id) => !railIds.includes(id))).toEqual([]);
  });

  it("no Settings page id in the registry is one Settings does not have", () => {
    expect(SETTINGS_PAGE_IDS.filter((id) => !settingsPageIds.includes(id))).toEqual([]);
  });

  it("no `chords` entry names a chord that does not exist", () => {
    expect([...chordsInRegistry].filter((id) => !chordIds.includes(id))).toEqual([]);
  });

  it("an exception names a surface that exists and is not already a door", () => {
    for (const id of Object.keys(NOT_AGENT_DOOR.views)) expect(railIds, id).toContain(id);
    for (const id of Object.keys(NOT_AGENT_DOOR.settingsPages)) expect(settingsPageIds, id).toContain(id);
    for (const id of Object.keys(NOT_AGENT_DOOR.chords)) { expect(chordIds, id).toContain(id); expect(chordsInRegistry.has(id), `${id} is a door now; drop the exception`).toBe(false); }
  });

  it("every exception carries a reason of a sentence's length", () => {
    for (const group of Object.values(NOT_AGENT_DOOR)) for (const [id, why] of Object.entries(group)) expect(why.length, id).toBeGreaterThan(30);
  });
});

describe("a handler for every door", () => {
  // tsc already refuses a missing or extra key (UI_HANDLERS is a mapped type
  // over the registry's ids). This is the runtime half, for a cast that hides it.
  it("the handler table and the registry hold the same ids", () => {
    expect(Object.keys(UI_HANDLERS).sort()).toEqual(Object.keys(UI_ACTIONS).sort());
  });
});
