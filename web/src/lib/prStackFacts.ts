// What the app knows about each pull request in a stack, from the lists it
// already holds, for the words on the marks (prStackWords.ts).
//
// One function for the board and the pull request's header, so the word a
// token carries on a card and the word the ladder carries for the same pull
// request cannot disagree: both read the column it would be filed in, with the
// same check rollup, and the tracker status the card store already has.

import type { PrSummary } from "../../../shared/types.ts";
import { fileInLane, type LaneId } from "./prLanes.ts";
import type { StackPr } from "./prStack.ts";
import type { Facts, Rung } from "./prStackWords.ts";
import { standing } from "./prCardZones.ts";

/** The column each pull request in these lists is, or would be, filed in. */
export function laneMap(
  pool: readonly PrSummary[], mine: ReadonlySet<number>, asked: ReadonlySet<number>,
  truth: (p: PrSummary) => PrSummary = (p) => p,
): Map<number, LaneId> {
  const out = new Map<number, LaneId>();
  for (const p of pool) out.set(p.number, fileInLane(truth(p), { mine: mine.has(p.number), asked: asked.has(p.number) }).lane);
  return out;
}

export function factsReader(o: {
  pool: readonly PrSummary[];
  found: ReadonlyMap<string, StackPr | null>;
  onBoard: (n: number) => boolean;
  lane: (n: number) => LaneId | undefined;
  /** The tracker card's status text, when the app holds the card. */
  status: (p: PrSummary) => string | undefined;
}): (n: number) => Facts | undefined {
  const byNumber = new Map(o.pool.map((p) => [p.number, p]));
  return (n) => {
    const p = byNumber.get(n);
    if (p) return { number: n, state: p.state, draft: p.isDraft, onBoard: o.onBoard(n), lane: o.lane(n), status: o.status(p) || undefined };
    for (const f of o.found.values()) if (f?.number === n) return { number: n, state: f.state, draft: !!f.isDraft, onBoard: false };
    return undefined;
  };
}

/** One line under a rung's title, from the list row when there is one. */
export function rungReader(pool: readonly PrSummary[]): (n: number) => Rung | undefined {
  const byNumber = new Map(pool.map((p) => [p.number, p]));
  return (n) => {
    const p = byNumber.get(n);
    if (!p) return undefined;
    const review = p.reviewDecision === "APPROVED" ? "approved" : p.reviewDecision === "CHANGES_REQUESTED" ? "changes requested" : "no review yet";
    const checks = p.checks && p.checksLoaded !== false ? standing(p.checks).word : "";
    return { number: n, title: p.title, line: [`→ ${p.baseRefName}`, checks, review].filter(Boolean).join(" · ") };
  };
}
