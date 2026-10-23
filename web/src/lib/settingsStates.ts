/*
 * The three states a settings page has besides "all fine", decided with no
 * React in them so they can be asserted without mounting anything.
 *
 *   saving   a write is out: the control or card says so, and says "Saved"
 *            for a moment after, so a write is never silent
 *   problem  the page could not read or reach what it shows (see PageProblem
 *            in settingsNav.ts): the shell turns the nav dot and the header chip red
 *   empty    a list with nothing in it: one sentence, and the action that fills it
 */

import type { PageProblem } from "./settingsNav.ts";

export type SavePhase = "idle" | "saving" | "saved";

/** How long "Saved" stays after a write lands. */
export const SAVED_MS = 2500;

/**
 * The next phase for a write that is `busy` or not. A write that FAILED goes
 * back to idle, not to "Saved": the page's own error line says what happened,
 * and a green chip beside it would contradict that.
 */
export function nextSavePhase(prev: SavePhase, busy: boolean, failed: boolean): SavePhase {
  if (busy) return "saving";
  if (prev === "saving") return failed ? "idle" : "saved";
  return prev;
}

/** The words of the red header chip for a read that failed. A 401 is not "unreachable". */
export function problemChip(why: { unauthorised?: boolean; throttled?: boolean } = {}): string {
  return why.unauthorised ? "Token refused" : why.throttled ? "Rate limited" : "Not reachable";
}

/** The shell's list of pages in trouble after one page reports (or clears): the same object when nothing changed, so React does not draw again. */
export function applyProblem(cur: Readonly<Record<string, PageProblem>>, page: string, p: PageProblem | null): Record<string, PageProblem> {
  const old = cur[page];
  if (p ? old !== undefined && old.chip === p.chip && old.title === p.title : old === undefined) return cur as Record<string, PageProblem>;
  const next = { ...cur };
  if (p) next[page] = p; else delete next[page];
  return next;
}
