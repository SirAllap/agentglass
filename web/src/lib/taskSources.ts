/*
 * Which task sources appear in the Tasks view.
 *
 * All of them do by default, and that default is load-bearing: an unconnected
 * source is shown on purpose, because a tab that only appears once you have
 * found Settings is a feature nobody discovers. It says what to do and links to
 * the pane that does it.
 *
 * The switch is for the opposite person — the one who has read that sentence,
 * decided they are never connecting ClickUp, and is tired of a tab for it. That
 * is a preference, and it is theirs.
 *
 * "All" is not in here. It is not a source, it is the absence of a filter, and
 * hiding it would leave somebody with two sources and no way to see both.
 */

export type TaskSourceId = "github" | "local" | "clickup";

export const TASK_SOURCES: { id: TaskSourceId; label: string; what: string }[] = [
  { id: "github", label: "GitHub", what: "Issues from the repository you are in, and a button that starts work on one." },
  { id: "local", label: "Local", what: "Your own list, read from the Taskwarrior store you already write to." },
  { id: "clickup", label: "ClickUp", what: "The boards you work from, and every card assigned to you." },
];

const KEY = "agentglass.tasks.hidden";

const hiddenSet = (): Set<string> => {
  try {
    const raw = localStorage.getItem(KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch { return new Set(); }
};

export const taskSourceShown = (id: TaskSourceId): boolean => !hiddenSet().has(id);

/**
 * Every source that is still on. Never empty: hiding the last one would leave
 * the view with nothing but its own header, so the last one cannot be hidden —
 * see `setTaskSourceShown`.
 *
 * The array is CACHED, and that is not a micro-optimisation. This is read
 * through `useSyncExternalStore`, which compares the snapshot it gets with the
 * one it had by identity: a fresh array every call is a snapshot that never
 * matches, which React answers with an infinite re-render. Rebuilt only when
 * the preference actually changes.
 */
let cached: TaskSourceId[] | null = null;
export const shownTaskSources = (): TaskSourceId[] =>
  (cached ??= TASK_SOURCES.map((s) => s.id).filter(taskSourceShown));

const listeners = new Set<() => void>();

/** Returns what actually happened, which is not always what was asked: the last
 *  visible source stays visible. */
export function setTaskSourceShown(id: TaskSourceId, shown: boolean): boolean {
  const hidden = hiddenSet();
  if (!shown && shownTaskSources().length <= 1 && !hidden.has(id)) return true;
  if (shown) hidden.delete(id); else hidden.add(id);
  try { localStorage.setItem(KEY, JSON.stringify([...hidden])); } catch { /* private mode */ }
  cached = null;
  for (const fn of listeners) fn();
  return shown;
}

export function subscribeTaskSources(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
