/**
 * The Jira writes only the person makes. A worker's token reaches these
 * routes (the denylist in auth.ts is short), so each one answers an agent with
 * 403; the agent's way in is the card door (`POST /jira/door/<verb>`, which
 * adds the control level, the write switch, the rate limit and an audit line),
 * and the door calls the same functions in-process, so locking the raw route
 * leaves it working. `/jira/connect` replaces the stored credentials: person
 * only, no door.
 *
 * A test walks every `POST /jira/` route in index.ts and fails when one is in
 * none of the three lists below, so a new route cannot be forgotten.
 */
export const JIRA_PERSON_ONLY_REFUSED = "Only the person changes cards in Jira; an agent cannot.";

/** Raw write routes the central guard in index.ts refuses to an agent. */
export const PERSON_ONLY_JIRA_ROUTES: readonly string[] = [
  "/jira/link", "/jira/connect", "/jira/transition", "/jira/assignee", "/jira/handoff", "/jira/steps", "/jira/step",
  "/jira/rank", "/jira/sprint-move", "/jira/backlog-move", "/jira/bulk", "/jira/clone", "/jira/edit",
  "/jira/comment", "/jira/comment/edit", "/jira/comment/delete",
  "/jira/worklog", "/jira/worklog/edit", "/jira/worklog/delete", "/jira/watch", "/jira/vote",
  "/jira/subtask", "/jira/relate", "/jira/relate/remove", "/jira/weblink", "/jira/weblink/remove",
  "/jira/attach", "/jira/attach/remove",
];

/** Routes an agent may call because they carry their own approval policy: the card door, and the two switches that go through the Settings door. */
export const DOOR_ONLY_JIRA_ROUTES: readonly string[] = ["/jira/door/", "/jira/writes", "/jira/write-kinds"];

/** Routes that change only agentglass's own screen preferences or the local pairing list, never a card or the credentials. */
export const LOCAL_JIRA_ROUTES: readonly string[] = [
  "/jira/pairs", "/jira/pairs/forget", "/jira/settings", "/jira/status-units", "/jira/spaces", "/jira/spaces/column-board", "/jira/filter",
  "/jira/views/add", "/jira/views/remove", "/jira/views/edit", "/jira/views/duplicate", "/jira/views/save-jql", "/jira/folders/add", "/jira/folders/remove",
];

const SET = new Set(PERSON_ONLY_JIRA_ROUTES);
export const isPersonOnlyJiraRoute = (pathname: string): boolean => SET.has(pathname);
