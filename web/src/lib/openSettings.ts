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

/** Pages that were folded into another. A remembered pane or an old
 *  `openSettings(id)` caller lands on the new home instead of nowhere. */
const PANE_ALIAS: Record<string, string> = { open: "prefs", export: "privacy" };
export const resolvePane = (id: string): string => PANE_ALIAS[id] ?? id;

/** The ClickUp page exists only while ClickUp is connected; asked for without
 *  it, the way on is the page that connects it. Applied to a FRESH read: a
 *  stale "not connected" held from before the token was saved sent
 *  `openSettings("clickup")` back to Tools & services, an `applied: true` that
 *  changed nothing on screen. */
export const paneWhenClickupKnown = (pane: string, connected: boolean): string =>
  pane === "clickup" && !connected ? "connections" : pane;

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
