import type { ProviderTask } from "../../shared/providers.ts";

/*
 * What a Jira card carries for a board, read off the issue's fields: the
 * sprint, the points, how many comments, subtasks, and what it waits on. Pure
 * functions of what the site sent, so the one place that reads them can be
 * tested without a site. Each is left off when the card or the site has none,
 * never zero or an empty string.
 */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const idText = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** The sprint a card is in: the active one, else the newest. Cloud sends objects, older Data Center the bean's text. */
export function sprintOf(v: unknown): string | undefined {
  const all = (Array.isArray(v) ? v : []).flatMap((x) => {
    if (isObj(x)) return str(x.name) ? [{ id: Number(x.id) || 0, state: str(x.state).toLowerCase(), name: str(x.name) }] : [];
    if (typeof x !== "string") return [];
    const name = /(?:^|[,[])name=(.*?)(?=,(?:startDate|endDate|completeDate|sequence|goal|rapidViewId|state|id)=|\]$)/.exec(x)?.[1];
    return name ? [{ id: Number(/(?:^|[,[])id=(\d+)/.exec(x)?.[1]) || 0, state: (/(?:^|[,[])state=(\w+)/.exec(x)?.[1] ?? "").toLowerCase(), name }] : [];
  });
  const active = all.filter((x) => x.state === "active");
  return (active.length ? active : all).sort((a, b) => b.id - a.id)[0]?.name;
}

/** Whether the linked card is unfinished, from the status it carries on the link. */
const linkedOpen = (c: unknown): boolean => {
  const status = isObj(c) && isObj(c.fields) && isObj(c.fields.status) ? c.fields.status : null;
  return !(status && isObj(status.statusCategory) && str(status.statusCategory.key) === "done");
};

export function cardExtras(f: Record<string, unknown>, ids?: { sprint?: string; points?: string; flag?: string }): Partial<ProviderTask> {
  const out: Partial<ProviderTask> = {};
  const sprint = ids?.sprint ? sprintOf(f[ids.sprint]) : undefined;
  if (sprint) out.sprint = sprint;
  const points = ids?.points ? f[ids.points] : undefined;
  if (typeof points === "number" && Number.isFinite(points)) out.points = points;
  // Zero is an answer ("no comments"); a block that was not asked for is not.
  if (isObj(f.comment) && typeof f.comment.total === "number") out.comments = f.comment.total;
  if (Array.isArray(f.subtasks) && f.subtasks.length) out.subtasks = f.subtasks.length;
  if (isObj(f.parent) && str(f.parent.key)) {
    const pf = isObj(f.parent.fields) ? f.parent.fields : {};
    const type = isObj(pf.issuetype) ? str(pf.issuetype.name) : "";
    out.parent = { key: str(f.parent.key), title: str(pf.summary), ...(type ? { type } : {}) };
  }
  // The Flagged field is a list of options: raised when it holds one, absent (not false) when it does not.
  if (ids?.flag && Array.isArray(f[ids.flag]) && (f[ids.flag] as unknown[]).length) out.flagged = true;
  const waitsOn: string[] = [];
  const blocks: string[] = [];
  for (const l of Array.isArray(f.issuelinks) ? f.issuelinks : []) {
    // The built-in link type; a site that renamed it shows no dependencies, not wrong ones.
    if (!isObj(l) || !isObj(l.type) || str(l.type.name).toLowerCase() !== "blocks") continue;
    if (isObj(l.inwardIssue) && linkedOpen(l.inwardIssue) && idText(l.inwardIssue.id)) waitsOn.push(idText(l.inwardIssue.id));
    if (isObj(l.outwardIssue) && linkedOpen(l.outwardIssue) && idText(l.outwardIssue.id)) blocks.push(idText(l.outwardIssue.id));
  }
  if (waitsOn.length) out.waitsOn = waitsOn;
  if (blocks.length) out.blocks = blocks;
  return out;
}
