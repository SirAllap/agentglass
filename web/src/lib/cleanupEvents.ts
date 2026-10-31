/*
 * What the several places that show one PR's cleanup tell each other. The PR
 * view's badge, the review dialog (opened from the badge, from the merge, or
 * from the toast's Details) and the toast are separate components; the badge
 * used to learn a run had ended only when it opened the dialog itself, so a run
 * started from the merge left it saying "Leftovers 6.4 GB" over a clean machine.
 * Now a run announces its end (with the server's own re-read of what is left)
 * and every view of that PR updates at once. No timer, no poll.
 *
 * Also the guard against two runs of one PR at once, and the toast's store.
 */
import type { CleanupNote, Report } from "./cleanupPr.ts";

export interface RunEvent { repo: string; pr: number; phase: "start" | "end"; report?: Report }
type Listener = (e: RunEvent) => void;

const listeners = new Set<Listener>();
const live = new Set<string>();
const keyOf = (repo: string, pr: number): string => `${repo}#${pr}`;

export const subscribeRuns = (fn: Listener): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const isRunning = (repo: string, pr: number): boolean => live.has(keyOf(repo, pr));

/** False when this PR is already being cleaned: the second run is refused, not queued behind a plan that no longer describes the machine. */
export function beginRun(repo: string, pr: number): boolean {
  const k = keyOf(repo, pr);
  if (live.has(k)) return false;
  live.add(k);
  listeners.forEach((l) => l({ repo, pr, phase: "start" }));
  return true;
}
/** The run ended, with its report, or without one when it could not be read. */
export function endRun(repo: string, pr: number, report?: Report): void {
  live.delete(keyOf(repo, pr));
  listeners.forEach((l) => l({ repo, pr, phase: "end", report }));
}

/* ---- the toast ---- */

let note: CleanupNote | null = null;
const noteListeners = new Set<() => void>();
export const showCleanupNote = (n: CleanupNote | null): void => { note = n; noteListeners.forEach((l) => l()); };
export const currentCleanupNote = (): CleanupNote | null => note;
export const subscribeCleanupNote = (fn: () => void): (() => void) => { noteListeners.add(fn); return () => { noteListeners.delete(fn); }; };
