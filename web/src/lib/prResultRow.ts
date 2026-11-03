import { cardReviewers } from "./cardReviewers.ts";
import type { LaneId } from "./prLanes.ts";
import type { PrSummary } from "../../../shared/types.ts";

/**
 * What one row of a search, a person's board or the closed list says.
 *
 * Results used to be drawn as the board's cards, which is a lane's worth of
 * decisions (a Merge button, a footer of actions) on a pull request that is
 * not in a lane. A row has a tile for its state, a title, who and when, and
 * the few facts that tell it apart: where it sits on YOUR board, whether one
 * of your rules hides it there, and how many approved it.
 */
export type RowTone = "ok" | "merged" | "bad" | "quiet";
export type RowIcon = "pr" | "draft" | "merge" | "x";

export interface ResultRow {
  tone: RowTone;
  icon: RowIcon;
  /** open | draft | merged | closed: the word for a pull request that is in no lane. */
  state: string;
  /** Where it is on your board, when it is open and filed. */
  lane: LaneId | null;
  /** The rule that keeps it off the board, by name. */
  hiddenBy: string | null;
  /** "3 approved", for a finished one that was. */
  approved: number;
  /** Why the search found it ("matched as author"), when it did. */
  why: string | null;
  aria: string;
}

export function resultRow(p: Pick<PrSummary, "number" | "title" | "state" | "isDraft" | "humanReview">, o: {
  lane?: LaneId | null; hiddenBy?: string | null; why?: string | null;
}): ResultRow {
  const merged = p.state === "MERGED";
  const closed = p.state === "CLOSED";
  const state = merged ? "merged" : closed ? "closed" : p.isDraft ? "draft" : "open";
  const r = cardReviewers(p.humanReview);
  const approved = merged || closed ? [...r.faces, ...r.more].filter((f) => f.state === "approved").length : 0;
  const lane = merged || closed ? null : o.lane ?? null;
  const hiddenBy = merged || closed ? null : o.hiddenBy ?? null;
  return {
    tone: merged ? "merged" : closed ? "bad" : p.isDraft ? "quiet" : "ok",
    icon: merged ? "merge" : closed ? "x" : p.isDraft ? "draft" : "pr",
    state, lane, hiddenBy, approved,
    why: o.why ?? null,
    aria: `#${p.number} ${p.title}. ${state}${hiddenBy ? `, hidden on your board by ${hiddenBy}` : ""}`,
  };
}
