/*
 * The two rules of a Jira card that are not drawing: what a key is, and what a
 * comment does to the card already on screen.
 *
 * A comment posted from the phone comes back from `POST /jira/comment` with the
 * server's idea of it, and the card is not re-read: one request per comment is
 * the point of the composer. `appendComment` lays the new row on the detail the
 * screen holds, in the order the site shows comments (oldest first), without
 * duplicating one that a slower read already brought back.
 *
 * The key shape is the server's own (`ISSUE_KEY`, server/src/jira.ts): letters,
 * digits and underscores, a hyphen, digits. It is NOT used to tell a Jira key
 * from a ClickUp custom id — those are the same shape, which is why the
 * notification router reads the tracker from the alert's data instead of
 * guessing from the string (src/notifications/target.ts).
 */
import type { TaskDetail } from "../../../shared/providers.ts";

/** `ORBIT-1042`. The site's own spelling, upper-cased when read. */
export const JIRA_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

export const isJiraKey = (id: unknown): id is string => typeof id === "string" && JIRA_KEY.test(id);

export type JiraComment = TaskDetail["comments"][number];

/**
 * The card with one more comment at the end. An id the card already has is left
 * where it is: a read that landed after the post must not draw it twice, and the
 * comment the person just wrote is the one they expect at the bottom.
 */
export function appendComment(detail: TaskDetail, comment: JiraComment): TaskDetail {
  if (detail.comments.some((c) => c.id === comment.id)) return detail;
  return { ...detail, comments: [...detail.comments, comment] };
}

/** A comment as the server answers one, from what the person typed. */
export function commentFrom(id: string, who: string, text: string, at: number): JiraComment {
  return { id, who, text, at, mine: true };
}
