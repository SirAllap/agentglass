/*
 * What the PRs panel's one bar does for the view under it.
 *
 * The search box keeps its place and keeps its meaning: it is the board's
 * search, with the board's hint, on every view. Inbox and CI narrow their own
 * rows from a box in their own header, so a hint here that promised a filter of
 * checks would promise something a GitHub search does not do. Typing in the
 * bar from one of them is a search, so it takes the person to the board where
 * the text applies; the board's query is where it was left otherwise.
 * Everything here is a decision, not a screen: the panel only draws what these
 * say.
 */
export type BarView = "board" | "inbox" | "ci";

export function barView(inboxOn: boolean, metricsOn: boolean): BarView {
  return metricsOn ? "ci" : inboxOn ? "inbox" : "board";
}

/** Where the person is after typing `text` in the bar: a search is the board's, so any text leaves Inbox and CI for it. */
export function viewAfterTyping(view: BarView, text: string): BarView {
  return text.trim() ? "board" : view;
}

/** Which controls the bar draws. A control keeps its place; it is drawn or it is not. */
export function barControls(view: BarView) {
  const board = view === "board";
  return {
    /** The Needs-my-review / Failing / Ready pills, the saved sets, Filters, Sort and the "N unread" chip of the board. */
    boardControls: board,
    /** ⏎ asks GitHub, `@` suggests people, "Search all" appears. All of it is the board's. */
    serverSearch: board,
  };
}
