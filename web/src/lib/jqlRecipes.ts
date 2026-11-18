/*
 * The view builder's ready parts: whole searches to start from, the fields most views are made of (each with what it
 * means and a clause to drop in), and the sort orders. Pure text in, text out, so a test drives them with no screen.
 *
 * Ceiling: a recipe replaces the box, a clause is appended with AND. Nothing here parses the search back into chips;
 * a view written by hand stays text, which is what Jira keeps too.
 */

export interface JqlRecipe { name: string; hint: string; jql: string }

export const JQL_RECIPES: readonly JqlRecipe[] = [
  { name: "My open work", hint: "Assigned to me, not done", jql: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC" },
  { name: "Current sprint", hint: "Everything in the open sprint", jql: "sprint in openSprints() ORDER BY Rank ASC" },
  { name: "Touched this week", hint: "Updated in the last 7 days", jql: "updated >= -7d ORDER BY updated DESC" },
  { name: "Nobody owns it", hint: "Unassigned and open", jql: "assignee is EMPTY AND statusCategory != Done ORDER BY created DESC" },
  { name: "Flagged", hint: "An impediment is raised", jql: "flagged is not EMPTY ORDER BY updated DESC" },
  { name: "Open bugs", hint: "Bugs not done, worst first", jql: "issuetype = Bug AND statusCategory != Done ORDER BY priority DESC" },
  { name: "I reported", hint: "Cards I created", jql: "reporter = currentUser() ORDER BY created DESC" },
  { name: "Due soon", hint: "Due in the next 7 days", jql: "duedate <= 7d AND statusCategory != Done ORDER BY duedate ASC" },
  { name: "Done lately", hint: "Resolved in the last 14 days", jql: "resolved >= -14d ORDER BY resolved DESC" },
];

export interface JqlPart { field: string; label: string; hint: string; clause: string }

/** The clause each one adds ends where the person's next word goes: a value to type, with the site's own list under it. */
export const JQL_PARTS: readonly JqlPart[] = [
  { field: "project", label: "Space", hint: "Which Jira space", clause: "project = " },
  { field: "status", label: "Status", hint: "One or more statuses", clause: "status in (" },
  { field: "assignee", label: "Assignee", hint: "Who holds it; currentUser() is you", clause: "assignee in (" },
  { field: "labels", label: "Label", hint: "Any of these labels", clause: "labels in (" },
  { field: "sprint", label: "Sprint", hint: "openSprints() is the running one", clause: "sprint in (" },
  { field: "priority", label: "Priority", hint: "Highest, High, Medium…", clause: "priority in (" },
  { field: "issuetype", label: "Type", hint: "Bug, Task, Story…", clause: "issuetype in (" },
  { field: "parent", label: "Epic / parent", hint: "Cards under one card", clause: "parent = " },
  { field: "updated", label: "Updated", hint: "-7d is a week ago", clause: "updated >= -7d" },
  { field: "text", label: "Text", hint: "Words in the title or description", clause: 'text ~ "' },
];

export interface JqlOrder { label: string; order: string }
export const JQL_ORDERS: readonly JqlOrder[] = [
  { label: "Board rank", order: "Rank ASC" },
  { label: "Last updated", order: "updated DESC" },
  { label: "Priority", order: "priority DESC" },
  { label: "Newest", order: "created DESC" },
  { label: "Due date", order: "duedate ASC" },
];

const ORDER_RE = /\s*\border\s+by\b[\s\S]*$/i;

/** The search without its ORDER BY, and the ORDER BY alone ("" when there is none). */
export function splitOrder(jql: string): { where: string; order: string } {
  const m = ORDER_RE.exec(jql);
  if (!m) return { where: jql.trim(), order: "" };
  return { where: jql.slice(0, m.index).trim(), order: m[0].trim().replace(/^order\s+by\s+/i, "") };
}

/** Append one clause with AND, before any ORDER BY; the caret lands at the end of the clause, where its value goes. */
export function addClause(jql: string, clause: string): { text: string; cursor: number } {
  const { where, order } = splitOrder(jql);
  const head = where ? `${where} AND ${clause}` : clause;
  const closer = clause.endsWith("(") ? ")" : clause.endsWith('"') ? '"' : "";
  const text = `${head}${closer}${order ? ` ORDER BY ${order}` : ""}`;
  return { text, cursor: head.length };
}

/** The same search sorted another way: the ORDER BY is replaced, never doubled. */
export function withOrder(jql: string, order: string): string {
  const { where } = splitOrder(jql);
  return where ? `${where} ORDER BY ${order}` : `ORDER BY ${order}`;
}

/** The sort the search uses now, as one of JQL_ORDERS, or null when it is none of them. */
export function orderOf(jql: string): string | null {
  const o = splitOrder(jql).order.toLowerCase().replace(/\s+/g, " ");
  return JQL_ORDERS.find((x) => x.order.toLowerCase() === o)?.order ?? null;
}
