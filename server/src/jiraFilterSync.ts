/*
 * One Jira filter, read or written for the sidebar's "Sync from / to Jira filter". A read is free; a write replaces the
 * filter's JQL on the site and only runs behind the master write switch, on the person's click (the sidebar asks first).
 *
 * Ceiling: the write is gated by the one "Writing to Jira" switch; it has no switch of its own in the per-kind list.
 */
import { apiOf, jiraCall, jiraWriteEnabled, WRITE_OFF, type JiraCreds, type JiraResult } from "./jira.ts";

const FILTER_ID = /^\d{1,12}$/;
export interface FilterRead { id: string; name: string; jql: string }

const at = (c: JiraCreds, id: string) => `/rest/api/${apiOf(c)}/filter/${encodeURIComponent(id)}`;
const text = (v: unknown): string => (typeof v === "string" ? v : "");

export async function readFilter(c: JiraCreds, id: string): Promise<JiraResult<FilterRead>> {
  if (!FILTER_ID.test(id)) return { ok: false, error: "That is not a filter id" };
  const r = await jiraCall<{ name?: unknown; jql?: unknown }>(c, at(c, id), { fresh: true });
  if (!r.ok || !r.data) return { ...r, data: undefined };
  return { ok: true, data: { id, name: text(r.data.name), jql: text(r.data.jql) } };
}

/** Replaces the filter's JQL. Jira wants the name in an update, so the current one is read first and sent back unchanged. */
export async function writeFilterJql(c: JiraCreds, id: string, jql: string): Promise<JiraResult<FilterRead>> {
  if (!jiraWriteEnabled()) return { ok: false, error: WRITE_OFF };
  const q = jql.trim();
  if (!q || q.length > 5000) return { ok: false, error: "The search is empty or too long to write" };
  const cur = await readFilter(c, id);
  if (!cur.ok || !cur.data) return cur;
  const put = await jiraCall<unknown>(c, at(c, id), { method: "PUT", body: { name: cur.data.name, jql: q }, fresh: true });
  return put.ok ? { ok: true, data: { ...cur.data, jql: q } } : { ...put, data: undefined };
}
