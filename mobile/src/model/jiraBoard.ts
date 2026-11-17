/*
 * The Jira board as the phone draws it: four lanes, the filters' effect, and
 * whose cards it shows (Mine or Everyone).
 *
 * The fold itself is shared/jiraLanes.ts, because it is a rule about a board
 * rather than about this screen. What is here is the phone's two habits on top
 * of it: the cards are narrowed by the filter sheet before they are filed, and
 * by the scope switch, like the PR board's: Mine (the default) keeps only the
 * cards assigned to the person, Everyone keeps all of them.
 *
 * ── The scope is remembered ───────────────────────────────────────────────
 * It is stored on the phone (notifications/jiraScopePref.ts). The switch is
 * always on screen, so a board narrowed to Mine is never a surprise.
 *
 * Counts follow the filters, not the whole board: the jump strip's number and
 * the cards below it are the same set, so a strip that says "3" over a lane
 * showing one card is impossible by construction.
 */
import type { ListStatus, ProviderTask } from "../../../shared/providers.ts";
import { jiraLanes, type JiraLane } from "../../../shared/jiraLanes.ts";
import { activeJiraFilters, applyJiraFilters, type JiraFilters } from "./jiraFilters.ts";

/** Whose cards the board shows. */
export type JiraScope = "mine" | "everyone";

export interface JiraBoard {
  lanes: JiraLane[];
  /** Cards that got through the filters. */
  shown: number;
  /** Cards the view returned, filters aside. */
  total: number;
  /** The person's own cards, filters aside: the Mine count. */
  mine: number;
  /** Filters answered, for the button's badge. */
  active: number;
}

/** Is this card a sub-task? The site's own word for the kind is the only
 *  portable test: a Story ALSO carries a `parent` (its epic), so that field
 *  cannot say "this is a step of the card above". */
export const isSubtask = (t: Pick<ProviderTask, "issueType">): boolean =>
  /^sub-?task$/i.test((t.issueType ?? "").replace(/\s+/g, ""));

/** The cards a column draws. A sub-task is a step of the card above it, and
 *  drawing it as a card doubles the work; it is not dropped from the view, only
 *  from the lanes. */
export function boardCards(tasks: readonly ProviderTask[]): ProviderTask[] {
  return tasks.filter((t) => !isSubtask(t));
}

export function jiraBoard(
  statuses: readonly ListStatus[],
  cards: readonly ProviderTask[],
  filters: JiraFilters,
  scope: JiraScope,
): JiraBoard {
  const shown = applyJiraFilters(scope === "mine" ? cards.filter((c) => c.mine === true) : cards, filters);
  const lanes = jiraLanes(statuses, shown);
  return {
    lanes,
    shown: shown.length,
    total: cards.length,
    mine: cards.filter((c) => c.mine === true).length,
    active: activeJiraFilters(filters),
  };
}

/** What a lane says when it is empty, by whether anything was narrowed. */
export function emptyLaneWords(filters: JiraFilters): string {
  return activeJiraFilters(filters) > 0 ? "No card here with these filters." : "Nothing here. Quiet is good.";
}
