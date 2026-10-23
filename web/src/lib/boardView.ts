/**
 * What the board's list area is showing: waiting for its first answer, a real
 * answer, or an error. The empty words ("This board has nothing open", the
 * counters at 0, the footer "0 of 0") belong to a real empty answer only.
 *
 * Measured: opening the Jira tab from a key click showed all of them for the
 * second or so before the first read landed, because `data` starts null and
 * a null board and an empty board both have no rows. A board that reads as
 * empty gets acted on; one that reads as loading gets waited for.
 *
 * Ceiling: a re-read over rows already on screen is not "loading" here; the
 * veil and the strip own that case.
 */
export type BoardView = "loading" | "error" | "ready";

export function boardView(state: { data: { error?: string | null; tasks: readonly unknown[] } | null }): BoardView {
  if (!state.data) return "loading";
  if (state.data.error && !state.data.tasks.length) return "error";
  return "ready";
}
