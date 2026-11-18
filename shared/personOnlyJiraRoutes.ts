// One list for the server's guard (index.ts) and the window's desk gate (web/src/lib/deskGate.ts).

/** Raw write routes the central guard in index.ts refuses to an agent. */
export const PERSON_ONLY_JIRA_ROUTES: readonly string[] = [
  "/jira/link", "/jira/connect", "/jira/transition", "/jira/assignee", "/jira/handoff", "/jira/steps", "/jira/step",
  "/jira/rank", "/jira/sprint-move", "/jira/backlog-move", "/jira/bulk", "/jira/clone", "/jira/edit",
  "/jira/comment", "/jira/comment/edit", "/jira/comment/delete",
  "/jira/worklog", "/jira/worklog/edit", "/jira/worklog/delete", "/jira/watch", "/jira/vote",
  "/jira/subtask", "/jira/relate", "/jira/relate/remove", "/jira/weblink", "/jira/weblink/remove",
  "/jira/attach", "/jira/attach/remove",
];
