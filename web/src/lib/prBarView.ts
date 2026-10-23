/*
 * What the PRs panel's one bar does for the view under it.
 *
 * The search box keeps its place; its hint and its target change with the
 * view. Each view keeps its own text, so coming back to the board finds the
 * board's query where it was left. Everything here is a decision, not a
 * screen: the panel only draws what these say.
 */
import { SEARCH_PLACEHOLDER } from "./prSearch.ts";

export type BarView = "board" | "inbox" | "ci";

export const INBOX_PLACEHOLDER = "Inbox · filter by title, repo or #number";
export const CI_PLACEHOLDER = "CI · filter checks by name or workflow";

export function barView(inboxOn: boolean, metricsOn: boolean): BarView {
  return metricsOn ? "ci" : inboxOn ? "inbox" : "board";
}

export function barPlaceholder(view: BarView): string {
  return view === "inbox" ? INBOX_PLACEHOLDER : view === "ci" ? CI_PLACEHOLDER : SEARCH_PLACEHOLDER;
}

/** Which controls the bar draws. A control keeps its place; it is drawn or it is not. */
export function barControls(view: BarView) {
  const board = view === "board";
  return {
    /** The Needs-my-review / Failing / Ready pills, the saved sets, Filters, Sort and the "N unread" chip of the board. */
    boardControls: board,
    /** ⏎ asks GitHub, `@` suggests people, "Search all" appears. All of it is the board's. */
    serverSearch: board,
    /** The All / Unread switch and the unread counter of the inbox. */
    inboxControls: view === "inbox",
  };
}
