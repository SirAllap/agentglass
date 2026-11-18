/*
 * Which card screen a pull request's chip opens, and whose the card is when the
 * pull request names two.
 *
 * Rule 1 of the Jira-first switch: a Jira key wins wherever it is named, and a
 * ClickUp id is the fallback for the pull requests that only ever had one. A
 * key counts as Jira's only when the connected site itself listed its project —
 * `ORBIT-1042` is also the shape of a ClickUp custom id, and sending that to
 * Jira opens a page that does not exist.
 */
import type { JiraReach, TaskRef } from "../../../shared/taskref.ts";

export type CardDoor = { tracker: "jira"; id: string } | { tracker: "clickup"; id: string };

const prefixOf = (label: string): string => (label.split("-")[0] ?? "").toUpperCase();

/**
 * The Jira key this reference names, or null.
 *
 * An address is certain. An id read from a branch or a title is Jira's only
 * against the keys the site listed; a prefix it never mentioned is a ClickUp
 * custom id as far as this can tell, and guessing the other way sends people to
 * a Jira page for a card that never existed.
 */
export function jiraKeyOf(ref: TaskRef | null, jira: JiraReach | null | undefined): string | null {
  if (!ref) return null;
  if (ref.tracker === "jira") return ref.query;
  if (ref.tracker !== null || !jira) return null;
  return jira.keys.some((k) => k.toUpperCase() === prefixOf(ref.label)) ? ref.query : null;
}

/**
 * The board that can draw this reference itself, or null when none can and the
 * chip has to search instead. Jira is asked first, in that order and not by
 * who was connected first.
 */
export function cardDoor(
  ref: TaskRef | null,
  o: { clickup: boolean; jira?: JiraReach | null },
): CardDoor | null {
  if (!ref) return null;
  const key = jiraKeyOf(ref, o.jira);
  if (key) return { tracker: "jira", id: key };
  if (!o.clickup || ref.tracker === "jira") return null;
  return { tracker: "clickup", id: ref.query };
}
