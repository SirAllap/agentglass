// Who waits on whom, for the board card's "baton" chip (review · checks · merge).
//
// Pure: it reads the lane the board already chose and the card's own facts, and
// answers one question — whose turn is it, and how is it going. The card draws
// the answer; it never works it out. Colour words match the mockup: you is
// orange, waiting is amber, stuck is red, done is green.

import type { Filed, LaneId } from "./prLanes.ts";
import type { PrSummary } from "./types.ts";

export type BatonStep = "review" | "checks" | "merge";
export type BatonTone = "you" | "waiting" | "stuck" | "done";

export interface Baton {
  step: BatonStep;
  tone: BatonTone;
  /** Who holds it: "you" or "someone else" (a person, a running suite). */
  holder: "you" | "other";
}

/** The lanes in the order a person reads them: what needs you first. */
export const LANE_ORDER: readonly LaneId[] = ["review", "land", "blocked", "others", "flight"];

/** A lane that draws only while it has cards; the mockup folds "Waiting on someone else" away when empty. */
export const HIDES_WHEN_EMPTY: ReadonlySet<LaneId> = new Set<LaneId>(["others"]);

export function visibleLanes(counts: Partial<Record<LaneId, number>>): LaneId[] {
  return LANE_ORDER.filter((id) => !HIDES_WHEN_EMPTY.has(id) || (counts[id] ?? 0) > 0);
}

export function baton(p: Pick<PrSummary, "checks" | "mergeable">, filed: Pick<Filed, "lane">): Baton {
  switch (filed.lane) {
    case "review": return { step: "review", tone: "you", holder: "you" };
    case "land": return { step: "merge", tone: "done", holder: "you" };
    case "blocked": return { step: "checks", tone: "stuck", holder: "you" };
    case "others": return { step: "review", tone: "waiting", holder: "other" };
    case "flight":
      return p.checks.pending > 0
        ? { step: "checks", tone: "waiting", holder: "other" }
        : { step: "review", tone: "waiting", holder: "you" };
  }
}
