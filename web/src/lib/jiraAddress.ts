/*
 * What "Add to the sidebar" can do with a pasted address, decided before any
 * request: the default first. A list-view address with a `jql` query is a
 * SEARCH by default (it shows exactly what that address shows), with "the whole
 * project" one click away; a bare project address is a space; anything else
 * (a board, a filter) is left to the server, which already resolves it.
 *
 * Limit, chosen: only the address's own text is read. Whether the project exists
 * is the picker's and the server's to say.
 */
import type { JiraAddChoice } from "../../../shared/jiraSpaces.ts";

export interface ParsedAddress {
  choices: JiraAddChoice[];
  /** The search, without its ORDER BY, for the card's second line. */
  jql?: string;
  project?: string;
}

const KEY = /^[A-Za-z][A-Za-z0-9_]{1,31}$/;

export function parseAddress(raw: string): ParsedAddress {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { choices: [] }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { choices: [] };
  const jql = u.searchParams.get("jql")?.trim() || undefined;
  const fromPath = /\/projects\/([A-Za-z][A-Za-z0-9_]{1,31})(?:\/|$)/.exec(u.pathname)?.[1];
  const fromJql = jql ? /\bproject\s*(?:=|in\s*\()\s*"?([A-Za-z][A-Za-z0-9_]{1,31})"?/i.exec(jql)?.[1] : undefined;
  const project = (fromPath ?? fromJql)?.toUpperCase();
  const board = /\/boards\/\d+/.test(u.pathname);
  const choices: JiraAddChoice[] = [];
  if (jql) {
    choices.push({ kind: "jql", id: "jql", label: "Add as a search" });
    if (project && KEY.test(project)) choices.push({ kind: "space", id: project, label: "Add the whole project instead" });
  } else if (!board && project && KEY.test(project)) {
    choices.push({ kind: "space", id: project, label: "Add a space" });
  }
  return { choices, project, ...(jql ? { jql: jql.replace(/\s+order\s+by\b[\s\S]*$/i, "") } : {}) };
}
