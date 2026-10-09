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
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { UI_ACTIONS, VIEW_IDS, SETTINGS_PAGE_IDS, type UiActionDef } from "../../shared/uiActions.ts";
import { globalStubs } from "./stubGlobal.ts";

// uiActions reaches the settings registry, which reaches pref modules that read
// localStorage when they load: this file starts from a stub, like the registry's own tests.
const stubGlobal = globalStubs();
stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 } as unknown as Storage);
stubGlobal("location", new URL("http://localhost:5173/"));
stubGlobal("window", new EventTarget());
stubGlobal("document", { documentElement: { getAttribute: () => "graphite", setAttribute: () => {}, style: { setProperty: () => {}, getPropertyValue: () => "" } } });
const { UI_HANDLERS } = await import("../src/lib/uiActions.ts");

const ROOT = join(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** What is deliberately not an agent door, by surface kind, with the reason. */
const POPOVER = "a menu, picker or popover inside a panel that is already a door: it opens from a click on that panel's own subject and chooses among its rows";
const OUTPUT = "output the app draws to the owner (a toast, a banner, a chip), not a place the owner goes: there is nothing to open";
const NOT_AGENT_DOOR: {
  views: Record<string, string>; settingsPages: Record<string, string>; chords: Record<string, string>;
  /** Component files that draw through a Portal and are not an entry's `modals`. */
  dialogs: Record<string, string>;
} = {
  views: {},
  settingsPages: {},
  chords: {},
  dialogs: {
    "Portal.tsx": "the portal primitive every dialog draws through, not a dialog itself",
    "AgentChangeChip.tsx": OUTPUT,
    "AskedBanners.tsx": OUTPUT,
    "NoteToasts.tsx": OUTPUT,
    "ZoomToast.tsx": OUTPUT,
    "TopBarNotes.tsx": OUTPUT,
    "NeedsPopover.tsx": "the popover under the Waiting-on-you chip: output about what needs the owner, read through ui.read gates",
    "Feed.tsx": POPOVER,
    "BasePicker.tsx": POPOVER,
    "ContextMenu.tsx": POPOVER,
    "AnchoredMenu.tsx": POPOVER,
    "FacetMenu.tsx": POPOVER,
    "Select.tsx": POPOVER,
    "FilterPresets.tsx": POPOVER,
    "tasks/FilterBuilder.tsx": POPOVER,
    "tasks/EmojiPicker.tsx": POPOVER,
    "diff/PresetDiff.tsx": POPOVER,
    "StatusPanel.tsx": POPOVER,
    "StackMarks.tsx": POPOVER,
    "CardFiles.tsx": POPOVER,
    "TopBar.tsx": POPOVER,
    "BrowserPanel.tsx": POPOVER,
    "PrPanel.tsx": POPOVER,
    "TasksPanel.tsx": POPOVER,
    "workspace/Workspace.tsx": POPOVER,
    "ConfirmDialog.tsx": "a question an action asks the owner before it runs: it exists only while that action waits, and the answer is the owner's",
    "MergeDialog.tsx": "a promise settled inside the merge flow of a loaded pull request, behind a guard dialog: a door would stage a merge, which is level 3 and waits for the stage-only model",
    "PeoplePick.tsx": "choosing a person writes an assignment or a reviewer request, and it opens only from a card or a pull request it is about: there is no state of its own to show",
    "RescueModal.tsx": "the end of the worktree-removal flow, a promise that flow settles: opened alone it has nothing to settle, and opening it means starting the removal",
    "CommitModal.tsx": "no mount site outside itself (measured): dead code, not a surface",
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
/** Every component file that draws through a Portal or says role="dialog". */
const dialogFiles = (() => {
  const out: string[] = [];
  const base = join(ROOT, "web/src/components");
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.endsWith(".tsx") && /<Portal\b|createPortal|role="dialog"/.test(readFileSync(join(dir, e.name), "utf8"))) out.push(relative(base, join(dir, e.name)));
    }
  };
  walk(base);
  return out.sort();
})();
const modalsInRegistry = new Set(Object.values(UI_ACTIONS as Record<string, UiActionDef>).flatMap((d) => d.modals ?? []));
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

  it("every dialog the app draws is an entry's `modals` or a decided exception", () => {
    expect(dialogFiles.length, "the scan found no dialogs: it is reading the wrong folder").toBeGreaterThanOrEqual(40);
    const missing = dialogFiles.filter((f) => !modalsInRegistry.has(f) && !(f in NOT_AGENT_DOOR.dialogs));
    expect(missing, "give an entry `modals: [file]` in shared/uiActions.ts, or add the file to NOT_AGENT_DOOR.dialogs with a reason").toEqual([]);
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

  it("no `modals` entry names a file that does not draw a dialog", () => {
    expect([...modalsInRegistry].filter((f) => !dialogFiles.includes(f))).toEqual([]);
  });

  it("an exception names a surface that exists and is not already a door", () => {
    for (const f of Object.keys(NOT_AGENT_DOOR.dialogs)) {
      expect(existsSync(join(ROOT, "web/src/components", f)), `${f} is gone; drop the exception`).toBe(true);
      expect(modalsInRegistry.has(f), `${f} is a door now; drop the exception`).toBe(false);
    }
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
