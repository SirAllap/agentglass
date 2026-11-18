/*
 * The PR board's five lanes, as data.
 *
 * The classification is not here and must not be: `shared/prLanes.ts` is the one
 * classifier the desk and the phone file by, and a second copy on the phone is
 * how "approved but red" ends up in two different lanes on two screens. What IS
 * here is the phone's reading of that map — how the two list reads fold, what a
 * lane hides behind the person's rules, how many a column may draw — plus the
 * saved views the server holds, narrowed by the evaluator the desk uses — so a
 * screen only paints what this returns and never re-sorts it.
 *
 * The board asks `/prs/list?filter=mine` and `?filter=review` — the same two
 * lists the tab's own counts came from, so opening it costs no request of its
 * own — plus the repository's list only while the person has everyone's on.
 */
import type { PrSummary } from "../../../shared/types.ts";
import {
  LANES, LANE_CAP, board as fileBoard, stakeFrom, suggestedAction,
  type Filed, type Lane, type LaneId, type Suggested,
} from "../../../shared/prLanes.ts";
import type { PrView } from "../../../shared/prFilter.ts";
import { evalExempt, type LaneResult } from "../../../shared/prFilterEval.ts";
import { viewFieldReader } from "../../../shared/prFilterFields.ts";

/** The two list reads the board is built from, and the repository's own list
 *  when the switch is on (absent while it is off: it was never asked for). */
export interface BoardData {
  mine: PrSummary[];
  review: PrSummary[];
  all?: PrSummary[];
}

/**
 * One card as its lane holds it: the pull request, the sentence that filed it,
 * and the one press the lane implies.
 */
export interface BoardCard {
  pr: PrSummary;
  filed: Filed;
  action: Suggested;
}

/** A lane's tint, in the phone's palette. Resolved with `toneInk` at paint time. */
export type LaneTint = "accent" | "good" | "bad" | "warn" | "neutral";

export interface BoardLane {
  id: LaneId;
  label: string;
  /** Why this lane exists, said once at the top of it. */
  why: string;
  tint: LaneTint;
  /** Everything the lane holds after the filters and the rules, before the cap. */
  count: number;
  /** What the column draws, in the order the lists answered. Capped at LANE_CAP. */
  cards: BoardCard[];
  /** Cards past the cap, counted and not drawn. */
  more: number;
  /** Behind the person's rules, for the always-present drawer. */
  hidden: BoardCard[];
}

/** Which facts are the person's own rules rather than the classifier's. */
export interface LaneRules {
  drafts: boolean;
  bots: boolean;
}

/**
 * The mock's two rules, on by default: a draft is nobody's job, and a bot's
 * version bump is not a review request. Both are switches — nothing is deleted,
 * the drawer says how many are behind them and Peek shows them in place.
 */
export const HIDE_BY_RULES: LaneRules = { drafts: true, bots: true };

/** The jump strip's words. A lane's full title does not fit five abreast at 360. */
export const STRIP_LABEL: Record<LaneId, string> = {
  review: "Needs you",
  land: "Green",
  blocked: "Blocked",
  others: "Waiting",
  flight: "In flight",
};

const TINT: Record<LaneId, LaneTint> = {
  review: "accent",
  land: "good",
  blocked: "bad",
  others: "warn",
  flight: "neutral",
};

/**
 * The two lists as one, each pull request once.
 *
 * A pull request that asked you for a review is ALSO yours sometimes, and the
 * two list calls return it as two different objects. The key is the repository's
 * root and the number, not the number alone: a board is one repository wide, but
 * this also answers "which of these did both lists answer?" in a test.
 */
export function foldLists(mine: PrSummary[], review: PrSummary[], rootOf?: (p: PrSummary) => string): PrSummary[] {
  const seen = new Set<string>();
  const out: PrSummary[] = [];
  for (const pr of [...mine, ...review]) {
    const key = `${rootOf?.(pr) ?? ""}#${pr.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pr);
  }
  return out;
}

/**
 * The rows the board files from: your two queues, or the whole repository when
 * the switch is on.
 *
 * A pull request in both queues is one card. The `mine` copy is the one kept,
 * which is the order the desktop files its lists in — so the card keeps the
 * stake and the fields the author's own list answered with.
 */
export function boardRows(data: BoardData, everyone: boolean): PrSummary[] {
  return foldLists(data.mine, everyone ? [...data.review, ...(data.all ?? [])] : data.review);
}

/** Bot-authored, by the one fact a list carries: the login GitHub gives it. */
export function isBot(p: Pick<PrSummary, "author">): boolean {
  return p.author === "bot" || p.author.toLowerCase().endsWith("[bot]");
}

export function hiddenByRules(p: PrSummary, rules: LaneRules): boolean {
  return (rules.drafts && p.isDraft) || (rules.bots && isBot(p));
}

/**
 * Five lanes, in `LANES` order, from the two lists and the rows the filters
 * left (`visible`).
 *
 * The stake is read from the two UNFILTERED lists: a filter that hides the
 * `mine` copy of a pull request must not turn its author into a stranger. No
 * sorting anywhere — the order inside a lane is the order the list answered,
 * which is GitHub's own relevance, and the lane order is the classifier's.
 */
export function laneBoard(data: BoardData, visible: PrSummary[], rules: LaneRules = HIDE_BY_RULES): BoardLane[] {
  const stakeOf = stakeFrom(data.mine, data.review);
  const byNumber = new Map(visible.map((p) => [p.number, p]));
  const filed = fileBoard(visible, stakeOf);
  return LANES.map((lane: Lane) => {
    const all: BoardCard[] = (filed.get(lane.id) ?? []).map((p) => ({
      pr: byNumber.get(p.number)!,
      filed: p.filed,
      action: suggestedAction(p, p.filed),
    }));
    const hidden = all.filter((c) => hiddenByRules(c.pr, rules));
    const shown = all.filter((c) => !hiddenByRules(c.pr, rules));
    return {
      id: lane.id,
      label: lane.label,
      why: lane.why,
      tint: TINT[lane.id],
      count: shown.length,
      cards: shown.slice(0, LANE_CAP),
      more: Math.max(0, shown.length - LANE_CAP),
      hidden,
    };
  });
}

/**
 * What an empty lane says.
 *
 * Every lane is always on the board — a lane that disappears when it empties
 * teaches the reader a layout that is not there — so each one needs a sentence
 * that reads as quiet rather than broken.
 */
export const EMPTY_SENTENCE: Record<LaneId, string> = {
  review: "Nobody is waiting on your review.",
  land: "Nothing is waiting on a press.",
  blocked: "Nothing is in the way.",
  others: "Nobody owes you a review.",
  flight: "None of yours is moving.",
};

/** The empty line as drawn: a narrowed board says it was the filters, not the repository. */
export function emptyLaneWords(id: LaneId, filtered: boolean): string {
  return filtered ? "No pull request here matches the filters." : EMPTY_SENTENCE[id];
}

/**
 * A saved view, as the desk saves it: the server's `PrView` — a name, a place
 * in the row, and the two lanes of rules the desk's board narrows by.
 *
 * A view is EVALUATED, not translated. The phone's facets cannot say `is not`,
 * nest groups or `matches`, and a lossy translation would be a view that keeps
 * different rows on two screens; so the phone runs the stored `LaneFilter`
 * through the evaluator the desk uses (shared/prFilterEval.ts) with the same
 * field reader and the same unread exemption (shared/prFilterFields.ts,
 * `unreadOf` at the call site).
 */
export interface ViewRun {
  /** The clock `updated` rules are read against; a test pins it. */
  now?: number;
  /** The desk's exemption: a row with something unread is never hidden. */
  exempt?: (p: PrSummary) => boolean;
}

const noExemption = (): boolean => false;

function runView(rows: readonly PrSummary[], view: PrView, run: ViewRun): LaneResult<PrSummary> {
  const now = run.now ?? Date.now();
  return evalExempt([...rows], view.filter, (p, key) => viewFieldReader(p, key, now), run.exempt ?? noExemption);
}

/** The rows a view keeps, with the desk's null policy and unread exemption.
 *  The phone draws `kept`; what a view took away is only counted by
 *  `viewHiddenCount`, not drawn as the desk's drawer. */
export function inView(rows: readonly PrSummary[], view: PrView, run: ViewRun = {}): PrSummary[] {
  return runView(rows, view, run).kept;
}

/** A view's number over the rows the board files from, so the chip matches what opening it draws. */
export function viewCount(rows: readonly PrSummary[], view: PrView, run: ViewRun = {}): number {
  return runView(rows, view, run).kept.length;
}

/** How many rows a view hides, so the phone can say what it is not drawing. */
export function viewHiddenCount(rows: readonly PrSummary[], view: PrView, run: ViewRun = {}): number {
  let n = 0;
  for (const count of runView(rows, view, run).hiddenBy.values()) n += count;
  return n;
}

/** The chip row: the views the server holds for this repository, in its order. */
export function viewChips(rows: readonly PrSummary[], views: readonly PrView[], run: ViewRun = {}): { view: PrView; count: number }[] {
  return views.map((view) => ({ view, count: viewCount(rows, view, run) }));
}
