// How the Review stage draws its people, as decisions rather than as markup.
//
// The stage used to be one short stub per reviewer, capped at 64px, so a lone
// approval filled a third of its cell and nobody on it had a face. The bar now
// takes the whole cell, split evenly, and each segment is line - face - line:
// the person sits inside their own stretch of the bar. What is decided here is
// the part with an edge case — how many faces fit — and there is no renderer in
// the tests, so that answer lives in a function that can be asserted on.
import type { ReviewerState } from "../../../shared/reviewRoster.ts";

/**
 * Faces drawn on one bar. A segment needs about 40px for a face and a stretch
 * of line either side, and the narrowest stage cell leaves ~168px: four faces
 * left each line 4px, which reads as a dot, so a fourth gets none. Past this
 * the people are still counted (one plain segment each, in the order the roster ranks them) and the tooltip
 * still names them; only the face is withheld. Nested groups of reviewers are
 * not here.
 */
export const BAR_FACES_MAX = 3;

export interface BarSegment {
  index: number;
  /** Draw the face inside this segment, or leave it a plain line. */
  face: boolean;
}

export function barLayout(count: number): BarSegment[] {
  const n = Math.max(0, Math.floor(count));
  return Array.from({ length: n }, (_, index) => ({ index, face: index < BAR_FACES_MAX }));
}

/** A tint at a given strength over nothing: the one spelling of it the merge box and the faces share. */
export const wash = (tint: string, pct: number) => `color-mix(in srgb, ${tint} ${pct}%, transparent)`;

/** Where a reviewer is, as a colour: the bar's line, the face's ring and the row's badge say it the same way. */
export const PERSON_TINT: Record<ReviewerState, string> = {
  approved: "var(--success)",
  "approved-old": "color-mix(in srgb, var(--success) 62%, var(--surface-card))",
  "approved-void": "color-mix(in srgb, var(--text) 32%, transparent)",
  changes: "var(--error)",
  "changes-again": "var(--warning)",
  commented: "color-mix(in srgb, var(--text) 40%, transparent)",
  requested: "color-mix(in srgb, var(--text) 20%, transparent)",
  team: "color-mix(in srgb, var(--text) 20%, transparent)",
  dismissed: "color-mix(in srgb, var(--text) 14%, transparent)",
};

/** What the small badge on a face says: a tick, a cross, or nothing but its colour. */
export type BadgeGlyph = "tick" | "cross" | "none";

export function badgeGlyph(state: ReviewerState): BadgeGlyph {
  return state === "approved" || state === "approved-old" ? "tick"
    : state === "changes" ? "cross"
    : "none";
}
