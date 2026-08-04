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

let listener: ((pane?: SettingsPane) => void) | null = null;

/** App installs this. Only one, because there is only one Settings modal. */
export function onOpenSettings(fn: ((pane?: SettingsPane) => void) | null): () => void {
  listener = fn;
  return () => { if (listener === fn) listener = null; };
}

/** Open Settings, optionally on a named pane. A no-op when nothing is
 *  listening — which is the case in tests and in the demo, and is not an
 *  error worth a throw. */
export function openSettings(pane?: SettingsPane): void {
  listener?.(pane);
}
