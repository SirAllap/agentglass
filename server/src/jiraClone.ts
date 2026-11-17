/*
 * Clone a Jira card: one read of the card and one create. The copy keeps type, project, parent (the epic, or the
 * parent of a sub-task), components, labels and priority, and its title is "CLONE - <title>", Jira's own convention.
 * Behind the write switch like every write here.
 *
 * Ceiling: the description, assignee, sprint, estimates, links and attachments are not copied. A clone is a new card
 * to fill in, not a duplicate of the whole history; a person who wants the rest opens it in Jira.
 * A create that gets no answer may have been made: it is not sent again, and the sentence says so.
 */
import { ISSUE_KEY, NOT_CONNECTED, WRITE_OFF, apiOf, jiraCall, jiraWriteEnabled, storedCreds, type JiraCreds } from "./jira.ts";
import { forgetViewReads } from "./jiraboards.ts";
import type { WriteOutcome } from "./trackerTypes.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const no = (error: string): WriteOutcome & { created?: string } => ({ ok: false, error });
export const CLONE_PREFIX = "CLONE - ";
const MAX_TITLE = 255;

interface Source {
  summary?: unknown; issuetype?: unknown; project?: unknown; parent?: unknown; components?: unknown; labels?: unknown; priority?: unknown;
}
const byId = (o: unknown): { id: string } | { name: string } | null => (isObj(o) ? (str(o.id) ? { id: str(o.id) } : str(o.name) ? { name: str(o.name) } : null) : null);

/** The create request a card's fields make. */
export function cloneBody(f: Source): { fields: Record<string, unknown> & { summary: string; issuetype: unknown } } {
  const title = str(f.summary);
  const summary = (title.startsWith(CLONE_PREFIX) ? title : `${CLONE_PREFIX}${title}`).slice(0, MAX_TITLE);
  const fields: Record<string, unknown> & { summary: string; issuetype: unknown } = {
    project: { key: isObj(f.project) ? str(f.project.key) : "" }, summary, issuetype: byId(f.issuetype) ?? {},
  };
  const parent = isObj(f.parent) ? str(f.parent.key) : "";
  if (parent) fields.parent = { key: parent };
  const comps = (Array.isArray(f.components) ? f.components : []).map(byId).filter((c): c is { id: string } => !!c && "id" in c);
  if (comps.length) fields.components = comps;
  const labels = (Array.isArray(f.labels) ? f.labels : []).filter((l): l is string => typeof l === "string");
  if (labels.length) fields.labels = labels;
  const pr = byId(f.priority);
  if (pr) fields.priority = pr;
  return { fields };
}

export async function cloneCard(creds: JiraCreds, key: string): Promise<WriteOutcome & { created?: string }> {
  if (!jiraWriteEnabled()) return no(WRITE_OFF);
  if (!ISSUE_KEY.test(key)) return no("That is not a Jira card id");
  const upper = key.toUpperCase();
  const v = apiOf(creds);
  const seen = await jiraCall<unknown>(creds, `/rest/api/${v}/issue/${encodeURIComponent(upper)}?fields=summary,issuetype,project,parent,components,labels,priority`, { fresh: true });
  if (!seen.ok) return { ok: false, unauthorised: seen.unauthorised, error: `Nothing was cloned: could not read the card first. ${seen.error ?? "Jira did not answer"}` };
  const f = isObj(seen.data) && isObj(seen.data.fields) ? seen.data.fields : null;
  if (!f || !str(f.summary)) return no("Nothing was cloned: the card could not be read");
  const post = await jiraCall<unknown>(creds, `/rest/api/${v}/issue`, { method: "POST", body: cloneBody(f) });
  if (!post.ok) {
    if (post.status === 400) return no("Jira did not accept that clone: the project may need a field this copy does not carry. Clone it in Jira");
    if (post.status === 403) return no(`Your Jira account cannot create cards like ${upper}`);
    if (!post.throttled && !post.unauthorised && (post.status === undefined || post.status >= 500)) return no(`${post.error ?? "Jira did not answer"}. The clone may have been made: look in Jira before cloning again`);
    return { ok: false, unauthorised: post.unauthorised, error: post.error ?? "Jira did not accept that clone" };
  }
  forgetViewReads();
  const made = isObj(post.data) ? str(post.data.key) : "";
  return ISSUE_KEY.test(made) ? { ok: true, created: made } : { ok: true };
}

export const cloneStored = (key: string): Promise<WriteOutcome & { created?: string }> => {
  const c = storedCreds();
  return c ? cloneCard(c, key) : Promise.resolve(no(NOT_CONNECTED));
};
