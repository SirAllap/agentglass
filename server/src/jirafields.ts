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
  return sprintRead(v)?.name;
}

/** The sprint a card shows and whether it is running now: a card can sit in a closed sprint and an active one at once; the active one wins, then a future one. */
export function sprintRead(v: unknown): { name: string; active: boolean; id?: string; state?: "closed"; start?: number; end?: number; goal?: string } | undefined {
  const when = (t: unknown): number | undefined => { const n = typeof t === "string" ? Date.parse(t) : NaN; return Number.isFinite(n) ? n : undefined; };
  const bean = (x: string, k: string) => new RegExp(`(?:^|[,\\[])${k}=([^,\\]]*)`).exec(x)?.[1];
  const all = (Array.isArray(v) ? v : []).flatMap((x) => {
    if (isObj(x)) return str(x.name) ? [{ id: Number(x.id) || 0, state: str(x.state).toLowerCase(), name: str(x.name), start: when(x.startDate), end: when(x.endDate), goal: str(x.goal) }] : [];
    if (typeof x !== "string") return [];
    const name = /(?:^|[,[])name=(.*?)(?=,(?:startDate|endDate|completeDate|sequence|goal|rapidViewId|state|id)=|\]$)/.exec(x)?.[1];
    return name ? [{ id: Number(/(?:^|[,[])id=(\d+)/.exec(x)?.[1]) || 0, state: (/(?:^|[,[])state=(\w+)/.exec(x)?.[1] ?? "").toLowerCase(), name, start: when(bean(x, "startDate")), end: when(bean(x, "endDate")), goal: bean(x, "goal") ?? "" }] : [];
  });
  // Active, else future (where the card goes next), else the newest closed: a closed sprint's id can be the higher one.
  const rank = (x: { state: string }) => (x.state === "active" ? 0 : x.state === "future" ? 1 : 2);
  const pick = all.sort((a, b) => rank(a) - rank(b) || b.id - a.id)[0];
  return pick ? { name: pick.name, active: pick.state === "active", ...(pick.id ? { id: String(pick.id) } : {}), ...(pick.state === "closed" ? { state: "closed" as const } : {}), ...(pick.start ? { start: pick.start } : {}), ...(pick.end ? { end: pick.end } : {}), ...(pick.goal ? { goal: pick.goal } : {}) } : undefined;
}

/** Whether the linked card is unfinished, from the status it carries on the link. */
const linkedOpen = (c: unknown): boolean => {
  const status = isObj(c) && isObj(c.fields) && isObj(c.fields.status) ? c.fields.status : null;
  return !(status && isObj(status.statusCategory) && str(status.statusCategory.key) === "done");
};

/** The colour a child's square wears: its status category, except that a blocked-like status says blocked (a done card never does). */
export function childKind(status: string, category: string): "done" | "progress" | "todo" | "blocked" {
  if (category === "done") return "done";
  if (/block|impediment|on hold/i.test(status)) return "blocked";
  return category === "new" ? "todo" : "progress";
}

export function cardExtras(f: Record<string, unknown>, ids?: { sprint?: string; points?: string; flag?: string }): Partial<ProviderTask> {
  const out: Partial<ProviderTask> = {};
  const sprint = ids?.sprint ? sprintRead(f[ids.sprint]) : undefined;
  if (sprint) { out.sprint = sprint.name; if (sprint.active) out.sprintActive = true; if (sprint.id) out.sprintId = sprint.id; if (sprint.state) out.sprintState = sprint.state; if (sprint.start) out.sprintStart = sprint.start; if (sprint.end) out.sprintEnd = sprint.end; if (sprint.goal) out.sprintGoal = sprint.goal; }
  const points = ids?.points ? f[ids.points] : undefined;
  if (typeof points === "number" && Number.isFinite(points)) out.points = points;
  // Zero is an answer ("no comments"); a block that was not asked for is not.
  if (isObj(f.comment) && typeof f.comment.total === "number") out.comments = f.comment.total;
  if (Array.isArray(f.subtasks) && f.subtasks.length) {
    out.subtasks = f.subtasks.length;
    // The same field, each child with its key and status: no request of its own.
    const kids = f.subtasks.flatMap((c) => {
      if (!isObj(c) || !str(c.key)) return [];
      const cf = isObj(c.fields) ? c.fields : {};
      const st = isObj(cf.status) ? cf.status : {};
      const status = str(st.name);
      const title = str(cf.summary);
      return [{ key: str(c.key), ...(title ? { title } : {}), status, kind: childKind(status, isObj(st.statusCategory) ? str(st.statusCategory.key) : "") }];
    });
    if (kids.length) out.children = kids;
  }
  if (isObj(f.parent) && str(f.parent.key)) {
    const pf = isObj(f.parent.fields) ? f.parent.fields : {};
    const type = isObj(pf.issuetype) ? str(pf.issuetype.name) : "";
    out.parent = { key: str(f.parent.key), title: str(pf.summary), ...(type ? { type } : {}) };
  }
  const comps = Array.isArray(f.components) ? f.components.flatMap((c) => (isObj(c) && str(c.name) ? [str(c.name)] : [])) : [];
  if (comps.length) out.components = comps;
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
