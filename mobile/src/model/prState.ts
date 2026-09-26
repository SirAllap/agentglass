/*
 * The open / merged / closed axis of the PR list.
 *
 * The server knows three states — open, closed, all — and "closed" INCLUDES
 * merged, exactly as GitHub's own Closed tab does. The phone wants Merged and
 * Closed apart, so it asks for "closed" and splits what comes back by the
 * row's own state.
 */
export type StateView = "open" | "merged" | "closed" | "all";

export const STATE_VIEWS: StateView[] = ["open", "merged", "closed", "all"];
export const STATE_LABEL: Record<StateView, string> = {
  open: "Open", merged: "Merged", closed: "Closed", all: "Any",
};

/** What `/prs/list?state=` is asked. */
export function stateQuery(v: StateView): "open" | "closed" | "all" {
  return v === "merged" ? "closed" : v;
}

export function byState<T extends { state: "OPEN" | "CLOSED" | "MERGED" }>(rows: T[], v: StateView): T[] {
  if (v === "all") return rows;
  const want = v === "open" ? "OPEN" : v === "merged" ? "MERGED" : "CLOSED";
  return rows.filter((r) => r.state === want);
}
