/*
 * A parent row's sub-tasks, read the first time the row is opened and then held for the session.
 *
 * The board's own search leaves sub-tasks out (`issuetype not in subTaskIssueTypes()` on the server), so a row's card count
 * is the only thing the list knows about them: no child is on the page to nest under its parent. Opening a parent is one
 * `GET /jira/child-cards`, a `parent = KEY` search read with the board's own fields, so the children are full rows — who,
 * the due date, the points and the pull request — and not the stubs a card read carries. The answer is held by the parent's
 * key: one request per parent per session, none while the parent is closed, and none again for a parent opened a second
 * time. Failures are held too, so a site that does not answer is asked once.
 *
 * Ceiling: a parent with more than 50 sub-tasks shows the first page; a sub-task created in Jira after the parent was
 * opened shows when the window is reloaded, and folding a parent back does not forget its answer.
 */
import { api } from "./api.ts";
import type { ProviderTask } from "../../../shared/providers.ts";

export type JiraSubtasks = { rows: ProviderTask[]; error: string };

const held = new Map<string, JiraSubtasks>();
const pending = new Map<string, Promise<JiraSubtasks>>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => { version++; for (const f of listeners) f(); };

/** What is held for a parent, without asking: a closed parent reads this and costs no request. */
export function peekJiraSubtasks(key: string): JiraSubtasks | null { return held.get(key) ?? null; }
export function onJiraSubtasks(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function jiraSubtasksVersion(): number { return version; }

/** The parent's sub-tasks: from memory when this session already read them, otherwise one request, shared by whoever asks meanwhile. */
export function readJiraSubtasks(key: string): Promise<JiraSubtasks> {
  const hit = held.get(key);
  if (hit) return Promise.resolve(hit);
  const going = pending.get(key);
  if (going) return going;
  const p = api.jiraChildCards(key)
    .then((r): JiraSubtasks => (r?.ok ? { rows: r.tasks ?? [], error: "" } : { rows: [], error: r?.error || "Jira did not answer" }))
    .catch((): JiraSubtasks => ({ rows: [], error: "Could not reach the server" }))
    .then((value) => { held.set(key, value); pending.delete(key); changed(); return value; });
  pending.set(key, p);
  return p;
}

export function forgetJiraSubtasks(): void { held.clear(); pending.clear(); changed(); }
