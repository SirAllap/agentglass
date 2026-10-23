/*
 * The projects the workflow map is drawn from: which ones count, and the
 * statuses each has. The decision is shared/jiraStatusUnits.ts; this reads what
 * it needs (the person's cards, the projects' statuses) and keeps the pick.
 * Nothing here writes to Jira: the pick is the local settings file's.
 */
import { mine, projectKey, projectStatuses, projects, readSettingsFile, withStored, writeSettingsKey, type JiraResult } from "./jira.ts";
import { jiraStatusUnits, pickProjects, type JiraProjectRead, type JiraUnits } from "../../shared/jiraStatusUnits.ts";

const MAX_PICK = 200;

/** The project keys the person chose to count; empty means "where my cards live". */
export function countedProjects(): string[] {
  const raw = readSettingsFile().counted;
  return Array.isArray(raw) ? [...new Set(raw.filter(projectKey))].slice(0, MAX_PICK) : [];
}

/** The longest a project key is allowed to be here: Jira's own are ten or so, and a settings file is read on every write check. */
const KEY_MAX = 32;

export function setCountedProjects(input: unknown): { ok: true; counted: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input) || input.length > MAX_PICK || !input.every((k) => projectKey(k) && k.length <= KEY_MAX)) return { ok: false, error: "That is not a list of Jira project keys" };
  const counted = [...new Set(input as string[])];
  writeSettingsKey("counted", counted);
  return { ok: true, counted };
}

/** Projects read at most this many at a time: one request each, on a site that rate-limits. */
const MAX_PROJECTS = 12;

export async function statusUnits(creds: Parameters<typeof projects>[0], fresh = false): Promise<JiraResult<JiraUnits>> {
  const [all, cards] = await Promise.all([projects(creds), mine(creds, { fresh })]);
  if (!all.ok) return { ...all, data: undefined };
  if (!cards.ok) return { ...cards, data: undefined };
  const count: Record<string, number> = {};
  for (const t of cards.data?.tasks ?? []) if (t.listId) count[t.listId] = (count[t.listId] ?? 0) + 1;
  const chosen = countedProjects();
  const names = all.data?.names ?? {};
  const { read: wanted, omitted } = pickProjects(chosen, count, all.data?.keys ?? [], MAX_PROJECTS);
  const read: JiraProjectRead[] = [];
  const failed: string[] = [];
  let why: JiraResult<unknown> | null = null;
  for (const key of wanted) {
    const r = await projectStatuses(creds, key);
    // One project whose statuses cannot be read is left out and named, not the reason the whole map is empty.
    if (!r.ok) { failed.push(key); why ??= r; continue; }
    read.push({ key, name: names[key] ?? key, statuses: (r.data ?? []).map((s) => ({ name: s.name, kind: s.kind })) });
  }
  if (!read.length && why) return { ...(why as JiraResult<JiraUnits>), data: undefined };
  const out = jiraStatusUnits(read, count, chosen);
  const said = [
    omitted ? `${omitted} more ${omitted === 1 ? "project" : "projects"} with your cards ${omitted === 1 ? "is" : "are"} not read: ${MAX_PROJECTS} at most.` : "",
    failed.length ? `The statuses of ${failed.join(", ")} could not be read.` : "",
  ].filter(Boolean).join(" ");
  return { ok: true, data: said ? { ...out, note: [out.note, said].filter(Boolean).join(" ") } : out };
}

export const statusUnitsStored = (fresh = false) => withStored((c) => statusUnits(c, fresh));
