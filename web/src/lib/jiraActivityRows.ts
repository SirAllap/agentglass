/*
 * What the Jira card's Activity draws for each of its tabs, as plain data.
 *
 * The tabs are Jira's: All, Comments, History, Work log. "All" is the same
 * merged timeline the ClickUp card draws (comments, with the runs of events
 * between them); the other three are one kind each. Newest first is a reading
 * order and not a different list: the rows are the same rows turned around,
 * and a run of events is turned around inside as well, so the last thing that
 * happened is the first line either way.
 */
import { activityRows, type ActivityRow } from "./cardActivity.ts";
import type { CardEvent, TaskDetail } from "../../../shared/providers.ts";

export type ActivityTab = "all" | "comments" | "history" | "worklog";
export const ACTIVITY_TABS: readonly { id: ActivityTab; label: string }[] = [
  { id: "all", label: "All" }, { id: "comments", label: "Comments" }, { id: "history", label: "History" }, { id: "worklog", label: "Work log" },
];

type Comment = TaskDetail["comments"][number];

/** Rows in the order the reader asked for. Oldest first is how they are built. */
export function orderRows<C extends { id: string; at: number }>(rows: ActivityRow<C>[], newestFirst: boolean): ActivityRow<C>[] {
  if (!newestFirst) return rows;
  return [...rows].reverse().map((r) => (r.kind === "events" ? { ...r, events: [...r.events].reverse() } : r));
}

/** The events a tab draws on its own: the history alone, or the work log alone. Oldest first. */
export function eventsFor(tab: "history" | "worklog", history: readonly CardEvent[], worklog: readonly CardEvent[]): CardEvent[] {
  return [...(tab === "history" ? history : worklog)].sort((a, b) => a.at - b.at);
}

/** All of it on one timeline: the comments, the history and the work log, merged by time. */
export function allRows(comments: readonly Comment[], history: readonly CardEvent[], worklog: readonly CardEvent[], newestFirst: boolean): ActivityRow<Comment>[] {
  return orderRows(activityRows(comments, [...history, ...worklog]), newestFirst);
}

/** The comments, oldest or newest first. */
export function commentsFor(comments: readonly Comment[], newestFirst: boolean): Comment[] {
  const sorted = [...comments].sort((a, b) => a.at - b.at);
  return newestFirst ? sorted.reverse() : sorted;
}

/**
 * Whether the history has to be asked for to draw this tab. History and All
 * need it; Comments and Work log never do, so a card whose reader stays on
 * Comments never costs the site a history request.
 */
export const needsHistory = (tab: ActivityTab): boolean => tab === "history" || tab === "all";
