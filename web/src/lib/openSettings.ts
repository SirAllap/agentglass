/*
 * "Take me to that setting."
 *
 * A panel three levels down from App needs to open Settings on one particular
 * pane — the ClickUp tab, unconnected, should be one click from the place that
 * connects it. Threading a callback down through Workspace and TasksView to get
 * there would put a prop on two components that have no interest in Settings,
 * which is how a codebase acquires plumbing nobody can delete later.
 *
 * So: the same one-slot bus idiom as termIssue.ts, and for the same reason —
 * the sender does not know whether the receiver is mounted, and does not have
 * to. A request left here is picked up by App, which owns the modal.
 */
import { SETTINGS_PAGE_ALIASES, SETTINGS_FOLD_SECTIONS, SETTINGS_TREE_PAGES } from "../../../shared/uiActions.ts";

export type SettingsPane = string;
/** A row's anchor — see settingsIndex.ts's rowId. Optional and additive: every
 *  one-argument `openSettings(pane)` caller keeps opening on the page with
 *  nothing further to do, exactly as before. */
export type SettingsRowId = string;

let listener: ((pane?: SettingsPane, row?: SettingsRowId) => void) | null = null;

/** App installs this. Only one, because there is only one Settings modal. */
export function onOpenSettings(fn: ((pane?: SettingsPane, row?: SettingsRowId) => void) | null): () => void {
  listener = fn;
  return () => { if (listener === fn) listener = null; };
}

/** Open Settings, optionally on a named pane and, on that pane, a named row
 *  — the modal scrolls to it and flashes it once mounted. A no-op when
 *  nothing is listening — which is the case in tests and in the demo, and is
 *  not an error worth a throw. */
export function openSettings(pane?: SettingsPane, row?: SettingsRowId): void {
  listener?.(pane, row);
}

/** `orchestration` + `section=refused`, written as a query, a hash or a path: that section is now part of Permissions. */
const REFUSED_LINK = /^orchestration(?:[?#:/&](?:section=)?)refused$/;
const ALIAS = SETTINGS_PAGE_ALIASES as Readonly<Record<string, string>>;
/** An old id, or another spelling of one, becomes the page it is part of now (the shared map, which the agent door
 *  validates against). A `plugin:<name>` link passes through. Runs before `paneWhenClickupKnown`. */
export const resolvePane = (id: string): string => (REFUSED_LINK.test(id) ? "perm" : ALIAS[id] ?? id);
/** Where an id lands, with the section of that page when the id was a folded page. */
export const aliasTarget = (id: string): { page: string; section?: string } => {
  const page = resolvePane(id);
  const section = SETTINGS_FOLD_SECTIONS[id];
  return section ? { page, section } : { page };
};

/** The page Settings opens on when an id is not one of ours: the first of the tree. */
export const FALLBACK_PAGE = SETTINGS_TREE_PAGES[0];
/** A remembered pane: through the map; an id that names no page of the tree opens the first one. */
export function restorePane(saved: string | null | undefined): string {
  if (!saved) return FALLBACK_PAGE;
  const page = resolvePane(saved);
  return page.startsWith("plugin:") || (SETTINGS_TREE_PAGES as readonly string[]).includes(page) ? page : FALLBACK_PAGE;
}

/** Folded old page -> its home, and the other way: until the pages are rebuilt a home draws the content of what was folded into it. */
export const FOLDED_INTO: Readonly<Record<string, readonly string[]>> = (() => {
  const out: Record<string, string[]> = {};
  for (const old of Object.keys(SETTINGS_FOLD_SECTIONS)) (out[ALIAS[old]!] ??= []).push(old);
  return out;
})();

/** The labels the old pages carried. The search box still finds them, on the page that took them in. */
export const OLD_LABELS: Readonly<Record<string, string>> = {
  prefs: "Window & startup", rail: "Sidebar", tmux: "Terminal engine",
  permMain: "Main agent", permWorkers: "Workers permissions", permBrowser: "Browser access", permOut: "Changes outside",
  budgets: "Usage & budgets", polaris: "Polaris", polarisPrs: "Polaris pull requests", "review-prompts": "Review prompts", "saved-replies": "Saved replies & views",
  connections: "Services & tools", tracker: "Card tracker", devices: "Paired devices", onboarding: "Get started Setup guide",
  perm: "Permissions", finder: "Finder", diff: "Diff", git: "Git and pull requests", engines: "Agent engines",
  hooks: "Hooks & watching", orchestration: "Flow & review", recipes: "Commands", remote: "Remote access",
};

const RANK: Record<string, number> = { err: 5, needs: 4, update: 3, on: 2, off: 1, none: 0 };
/** A folded page's nav mark is the home page's too: the worst state of the pages that live there. */
export function foldMarks<M extends { state: string }>(marks: Readonly<Record<string, M | undefined>>): Record<string, M | undefined> {
  const out: Record<string, M | undefined> = { ...marks };
  for (const old of Object.keys(SETTINGS_FOLD_SECTIONS)) {
    const m = marks[old];
    if (!m) continue;
    const home = out[ALIAS[old]!];
    if (!home || (RANK[m.state] ?? 0) > (RANK[home.state] ?? 0)) out[ALIAS[old]!] = m;
  }
  return out;
}

/** The ClickUp page exists only while ClickUp is connected; asked for without
 *  it, the way on is the Tasks page, where the trackers are connected. Applied to a FRESH read: a
 *  stale "not connected" held from before the token was saved sent
 *  `openSettings("clickup")` back to Tools & services, an `applied: true` that
 *  changed nothing on screen. */
export const paneWhenClickupKnown = (pane: string, connected: boolean): string =>
  pane === "clickup" && !connected ? "tasks" : pane;

/*
 * The other direction: a row inside Settings that switches the app to a view
 * underneath it — Plugins' "Open" button, taking you to the panel a plugin
 * just drew — has to close Settings too, the same way its own "Back to app"
 * button does, or the switch happens behind a modal that never moves. Same
 * one-slot idiom, same reason: the sender does not know, and should not have
 * to know, that a modal owned three levels up is even open.
 */
let closeListener: (() => void) | null = null;

/** App installs this alongside onOpenSettings. Only one, for the same modal. */
export function onCloseSettings(fn: (() => void) | null): () => void {
  closeListener = fn;
  return () => { if (closeListener === fn) closeListener = null; };
}

/** Closes Settings if it is open. A no-op otherwise — the button that calls
 *  this fires whether or not Settings happens to be the thing on top. */
export function closeSettings(): void {
  closeListener?.();
}

/** The same project picker the header's "Open project" button opens. Settings closes first (the picker sits
 *  under the modal otherwise). A no-op when nothing is listening (tests, the demo). */
export const OPEN_PROJECT_EVENT = "agentglass:open-project";
export function openProjectPicker(): void {
  closeSettings();
  if (typeof window !== "undefined") window.dispatchEvent(new Event(OPEN_PROJECT_EVENT));
}
