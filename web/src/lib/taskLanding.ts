/*
 * Which tab the Tasks view opens on.
 *
 * There was no answer to this before, which is not the same as there being a
 * default: the source was component state initialised to "all", so every visit
 * started over. Go to Tasks, open a card, look at a diff, come back — "All"
 * again, and "All" is the one view that does not include your ClickUp cards
 * (it draws the now band, the local strip and the repository's issues). So
 * somebody who works out of a board landed, every single time, on the tab
 * without their work in it.
 *
 * Two settings rather than one, because they answer different complaints:
 *
 *   "last"      pick up where you left off. The default, because it needs no
 *               configuration and is what a tab bar is expected to do.
 *   a source    always open here, whatever I did last. For somebody who dips
 *               into another tab constantly and still wants to come back to
 *               their own.
 *
 * What does NOT write the remembered tab is a jump — pressing a card id on a
 * pull request opens the ClickUp board, and that is an errand, not a change of
 * mind. Letting it stick would mean a single press from a pull request quietly
 * re-homing somebody's Tasks view.
 */
import type { TaskSourceId } from "./taskSources.ts";

/** "all" is a landing choice like any other even though it is not a source —
 *  it is a view of the bar, and it is the one this app has always opened on. */
export type TaskLanding = "last" | "all" | TaskSourceId;

const MODE_KEY = "agentglass.tasks.landing";
const LAST_KEY = "agentglass.tasks.last";

const MODES: TaskLanding[] = ["last", "all", "github", "local", "clickup", "jira"];

const read = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};

const write = (key: string, v: string): void => {
  try { localStorage.setItem(key, v); } catch { /* private mode */ }
};

export function taskLanding(): TaskLanding {
  const v = read(MODE_KEY);
  return MODES.includes(v as TaskLanding) ? (v as TaskLanding) : "last";
}

export function setTaskLanding(v: TaskLanding): void {
  write(MODE_KEY, v);
  for (const fn of listeners) fn();
}

/** The tab you were on when you last left, as a bare string. Validated by the
 *  caller against the tabs that actually exist — this file has no business
 *  knowing which sources are connected or switched on. */
export const lastTaskSource = (): string | null => read(LAST_KEY);

export const rememberTaskSource = (id: string): void => write(LAST_KEY, id);

/**
 * Where to open, given what the bar is offering right now.
 *
 * `available` is the real tab list — already ordered, filtered by preference
 * and by what is connected. Everything here is checked against it, because
 * every stored answer can name a tab that is no longer there: a source switched
 * off, a token removed, a provider that stopped existing between releases.
 *
 * The fallback is the first tab rather than "all", and that is the point of
 * taking `available` at all: on a bar with one source there IS no "all", and
 * landing on a tab that is not on the bar is how the view ends up blank.
 */
export function landingSource(available: string[], mode = taskLanding(), last = lastTaskSource()): string {
  return openTaskSource({ available, landing: mode, last, settled: true });
}

export interface TaskOpen {
  /** The bar as it stands, in its saved order. */
  available: readonly string[];
  /** The saved landing preference. */
  landing: TaskLanding;
  /** The tab on screen while the view stays mounted, so "last used" does not
   *  jump backwards to a tab saved by an earlier visit. */
  current?: string | null;
  /** The last tab a hand wrote. Read from the store unless given. */
  last?: string | null;
  /** A card or issue jump naming a source: an errand, not a change of mind. */
  explicit?: string | null;
  /**
   * Whether every source the preference names has had its chance to appear.
   * False while the server is still answering which sources are set up: the
   * bar then deliberately leaves optional sources off for a frame, and treating
   * that as "the tab is gone" is what landed a pinned Jira on "All".
   */
  settled?: boolean;
}

/**
 * Which tab the Tasks view opens on.
 *
 * Precedence, and why it is this order:
 *
 *  1. an explicit target (a chip click, a deep link naming a card or tracker)
 *     — somebody asked for that card, and it is not a statement about where
 *     they want to live between errands;
 *  2. the saved landing — a pinned source is a choice about every open that
 *     outranks the tab you happened to leave behind, so a stale last-visited
 *     tab never overrides it;
 *  3. otherwise the first tab on the bar (or "all" when there is no bar yet).
 *
 * The last-visited tab only decides anything when the landing itself is
 * "last", which is the default rather than an exception to rule 2.
 */
export function openTaskSource({ available, landing, current, last = lastTaskSource(), explicit, settled = true }: TaskOpen): string {
  const ok = (v: string | null | undefined): v is string => !!v && available.includes(v);
  if (explicit) return explicit;
  if (landing === "last") {
    if (ok(current)) return current;
    return ok(last) ? last : (available[0] ?? "all");
  }
  if (ok(landing)) return landing;
  // An unsettled bar is missing tabs it has not been told about yet, not tabs
  // that are gone. Hold the landing; the caller steps off once it settles.
  if (!settled) return landing;
  return available[0] ?? "all";
}


const listeners = new Set<() => void>();

export function subscribeTaskLanding(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
