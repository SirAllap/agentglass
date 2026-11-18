/*
 * Four lanes on a phone, out of a board that has as many columns as its
 * workflow.
 *
 * The desktop draws one column per status (`web/src/lib/boardGroups.ts`), which
 * is right at a monitor and wrong in one hand: a seven-status site is seven
 * columns of 120 px behind a swipe nobody can count. The mock settles on four —
 * To do · In progress · In review · Done — and this is that fold, written once.
 *
 * ── never a list of status NAMES ──────────────────────────────────────────
 * Status names are per-site and per-project. What travels is the view's own
 * `ListStatus.type` (open / custom / done / closed), so a workflow that spells
 * "Doing" or "En curso" files itself. The one exception is review, which Jira
 * has no category for: the plan asks for a name match, and it is a substring of
 * the status's own name, in the site's spelling. A site that calls it
 * "Verification" puts those cards in In progress until somebody adds "review"
 * to the name or the fold learns the word — the ceiling is stated here because
 * a silent misfile is worse than a known one.
 *
 * Order wins over the name: a status whose category is done is Done even if its
 * name says review, because that is where the workflow says the card has
 * finished.
 *
 * A card whose status the view did not list is not dropped: its own
 * `statusKind` files it, and the same review match applies. Losing a card off a
 * board is the failure this module exists to make impossible.
 *
 * Phone-only for now (plan-movil-v1 §8, decision 3): the desktop keeps its
 * per-status columns until question 3 is answered.
 */
import type { ListStatus, ProviderTask } from "./providers.ts";

export type JiraLaneId = "todo" | "progress" | "review" | "done";

/** The four, in the order they are drawn. Every one is always drawn, empty
 *  included: a lane with nothing in it answers "nothing here", and a missing
 *  lane answers "does this board have that step", which is a different and
 *  unanswerable question. */
export const JIRA_LANES: readonly { id: JiraLaneId; name: string }[] = [
  { id: "todo", name: "To do" },
  { id: "progress", name: "In progress" },
  { id: "review", name: "In review" },
  { id: "done", name: "Done" },
];

export interface JiraLane {
  id: JiraLaneId;
  name: string;
  /** The view's own status names folded into this lane, in the view's order. */
  statuses: string[];
  cards: ProviderTask[];
  /** The view's colour for the first status folded in here. */
  color?: string;
}

const lower = (s: string): string => s.trim().toLowerCase();

/**
 * The lane a status belongs in, from the site's category and the status's own
 * name. Exported because the move sheet names the lane a transition leads to
 * without having a board in hand.
 */
export function jiraLaneOf(name: string, type: string): JiraLaneId {
  const kind = lower(type);
  if (kind === "done" || kind === "closed") return "done";
  if (/review/.test(lower(name))) return "review";
  if (kind === "open") return "todo";
  return "progress";
}

/** The lane a card belongs in, when the view did not list its status. */
function laneOfUnlisted(card: ProviderTask): JiraLaneId {
  if (card.statusKind === "done") return "done";
  if (/review/.test(lower(card.status))) return "review";
  return card.statusKind === "open" ? "todo" : "progress";
}

interface Placed {
  card: ProviderTask;
  /** The view's order for the card's status; after every listed status when
   *  the view did not list it. */
  at: number;
  /** The order the view sent the cards in, so one status keeps its own hand. */
  order: number;
}

/**
 * The cards folded into four lanes, in the view's order.
 *
 * Inside a lane, cards are grouped by the status order the view gave and keep
 * the view's order within one status — the board's own hand, not an
 * alphabetical sort. `mineFirst` is the board's business (model/jiraBoard.ts);
 * this keeps the raw order.
 */
export function jiraLanes(statuses: readonly ListStatus[], cards: readonly ProviderTask[]): JiraLane[] {
  const seen = new Map<string, { lane: JiraLaneId; at: number; name: string; color?: string }>();
  statuses.forEach((s, at) => {
    const name = (s.status ?? "").trim();
    if (!name || seen.has(lower(name))) return;
    seen.set(lower(name), { lane: jiraLaneOf(name, s.type), at, name, ...(s.color ? { color: s.color } : null) });
  });

  const lanes: JiraLane[] = JIRA_LANES.map((l) => ({ ...l, statuses: [], cards: [] }));
  const byId = new Map(lanes.map((l) => [l.id, l]));
  for (const s of seen.values()) {
    const lane = byId.get(s.lane)!;
    lane.statuses.push(s.name);
    lane.color ??= s.color;
  }

  const placed: { lane: JiraLaneId; row: Placed }[] = cards.map((card, order) => {
    const known = seen.get(lower(card.status));
    return { lane: known?.lane ?? laneOfUnlisted(card), row: { card, at: known?.at ?? statuses.length, order } };
  });
  placed.sort((a, b) => a.row.at - b.row.at || a.row.order - b.row.order);
  for (const p of placed) byId.get(p.lane)!.cards.push(p.row.card);

  return lanes;
}
