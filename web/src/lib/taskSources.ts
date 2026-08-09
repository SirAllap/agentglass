/*
 * Which task sources appear in the Tasks view, and in what order.
 *
 * Three things decide whether a tab is on the bar, and they are deliberately
 * not one thing:
 *
 *   the catalogue    every source that exists — TASK_SOURCES
 *   this preference  the ones you have not switched off, in the order you put
 *                    them, which is what this file owns
 *   what is set up   whether the thing is connected at all — taskConnected.ts,
 *                    because that answer comes from the server and this file
 *                    is synchronous by design
 *
 * The switch is for the person who is never connecting ClickUp and is tired of
 * a tab for it. The ORDER is for the opposite person: somebody who works out of
 * one source all day and wants it first, or first-and-default — see
 * taskLanding.ts, which is the other half of that same complaint.
 *
 * "All" is not in here. It is not a source, it is the absence of a filter, and
 * hiding it would leave somebody with two sources and no way to see both. It is
 * also never reordered: it is the leftmost thing or it is nothing, because a
 * filter that sits in the middle of the things it filters reads as one of them.
 */

export type TaskSourceId = "github" | "local" | "clickup";

/**
 * The catalogue, in the order a fresh install gets.
 *
 * This is a DEFAULT now rather than the running order — `orderedTaskSources`
 * is what the bar is built from. Adding a source here still works with no
 * further thought: one that nobody has an opinion about lands at the end of
 * everybody's order, which is where a thing you have never seen belongs.
 */
export const TASK_SOURCES: { id: TaskSourceId; label: string; what: string }[] = [
  { id: "github", label: "GitHub", what: "Issues from the repository you are in, and a button that starts work on one." },
  { id: "local", label: "Local", what: "Your own list, read from the Taskwarrior store you already write to." },
  { id: "clickup", label: "ClickUp", what: "The boards you work from, and every card assigned to you." },
];

const ALL_IDS = (): TaskSourceId[] => TASK_SOURCES.map((s) => s.id);

const KEY = "agentglass.tasks.hidden";
const ORDER_KEY = "agentglass.tasks.order";

const hiddenSet = (): Set<string> => {
  try {
    const raw = localStorage.getItem(KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch { return new Set(); }
};

export const taskSourceShown = (id: TaskSourceId): boolean => !hiddenSet().has(id);

/**
 * Every source, hidden ones included, in the order this person put them.
 *
 * Reconciled against the catalogue on every read rather than trusted, because
 * what is on disk was written by an older version of this app: an id that no
 * longer exists is dropped, and one the stored order has never heard of is
 * appended. That second rule is what lets a new source ship without a
 * migration — and appending rather than prepending is the honest default,
 * since a tab you have never seen has not earned the front.
 *
 * Both halves matter. Without the drop, a removed source keeps a slot forever;
 * without the append, adding one to TASK_SOURCES would make it invisible to
 * everybody who has ever reordered.
 */
export const orderedTaskSources = (): TaskSourceId[] => (ordered ??= reconcile());

function reconcile(): TaskSourceId[] {
  const all = ALL_IDS();
  let stored: unknown = [];
  try { stored = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]"); } catch { /* private mode */ }
  const kept = (Array.isArray(stored) ? stored : [])
    .filter((x): x is TaskSourceId => all.includes(x as TaskSourceId));
  // Deduplicated: a half-written file, or two tabs racing, must not put a
  // source on the bar twice — React would then see duplicate keys.
  const seen = new Set<TaskSourceId>();
  const out = kept.filter((x) => !seen.has(x) && (seen.add(x), true));
  return [...out, ...all.filter((x) => !seen.has(x))];
}

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
let ordered: TaskSourceId[] | null = null;
export const shownTaskSources = (): TaskSourceId[] =>
  (cached ??= orderedTaskSources().filter(taskSourceShown));

const listeners = new Set<() => void>();

/** One place to forget both caches and tell everybody, so no writer can update
 *  one and leave the other stale. */
function changed(): void {
  cached = null;
  ordered = null;
  for (const fn of listeners) fn();
}

/** Returns what actually happened, which is not always what was asked: the last
 *  visible source stays visible. */
export function setTaskSourceShown(id: TaskSourceId, shown: boolean): boolean {
  const hidden = hiddenSet();
  if (!shown && shownTaskSources().length <= 1 && !hidden.has(id)) return true;
  if (shown) hidden.delete(id); else hidden.add(id);
  try { localStorage.setItem(KEY, JSON.stringify([...hidden])); } catch { /* private mode */ }
  changed();
  return shown;
}

/**
 * Move a source one place along the bar.
 *
 * A step rather than a drop target, and that is a considered trade: this is a
 * list of three, it is edited in a settings pane rather than on the bar itself,
 * and a pair of arrows works from the keyboard and on a phone without a single
 * pointer event. Drag-and-drop would be prettier and would also be the only
 * control in this pane that a screen reader could not operate.
 *
 * The move happens in the FULL order, hidden sources included. Stepping over
 * something you cannot see would otherwise look like a press that did nothing —
 * and turning that source back on afterwards would reveal an order you never
 * asked for.
 *
 * Returns whether anything moved, so a caller can leave the button dead at the
 * ends rather than pretending.
 */
export function moveTaskSource(id: TaskSourceId, by: -1 | 1): boolean {
  const order = [...orderedTaskSources()];
  const at = order.indexOf(id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= order.length) return false;
  [order[at], order[to]] = [order[to]!, order[at]!];
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(order)); } catch { /* private mode */ }
  changed();
  return true;
}

/** Back to the catalogue's own order — the escape hatch for somebody who has
 *  shuffled themselves into something they no longer want to reason about. */
export function resetTaskSourceOrder(): void {
  try { localStorage.removeItem(ORDER_KEY); } catch { /* private mode */ }
  changed();
}

export function subscribeTaskSources(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** For a test that writes to the store behind this module's back — the caches
 *  are only dropped by this module's own writers, which is exactly right in the
 *  app and exactly wrong in a fixture. */
export function __forgetTaskSources(): void { changed(); }
