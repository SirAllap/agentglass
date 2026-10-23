import type { CardAttachment, CardFact, CardLinked, CardWebLink, ProviderTask, TaskDetail } from "../../shared/providers.ts";
import { prAddress } from "../../shared/taskref.ts";
import { adfToMarkdown, wikiToMarkdown } from "./jiraAdf.ts";

/*
 * What a Jira card shows besides its words, read off the one issue answer:
 * the cards it is linked to, its files by name, and its Details. Pure
 * functions of what the site sent, so the shapes of both flavors are tested
 * without a site.
 *
 * Which Details to draw is the site's say, not ours. The issue is asked with
 * `expand=editmeta`, whose field list is what this card's edit screen offers:
 * a field that screen lists is drawn even when nobody filled it ("None"), a
 * field it does not list is drawn only when it holds something, and a project
 * without components, versions or time tracking therefore never shows an empty
 * row for them. When the site does not send the list (no permission to edit),
 * only what holds a value is drawn.
 *
 * Ceiling: an epic's children are not in `subtasks` on either flavor, so they
 * are not here; the web shows them from a search, which is a request this
 * read-only slice does not make.
 */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const idText = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const epoch = (v: unknown): number => { const t = Date.parse(str(v)); return Number.isFinite(t) ? t : 0; };
const initialsOf = (name: string): string =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => Array.from(w)[0]!.toUpperCase()).join("") || "?";

/** The site's own ids for the Details that are custom fields; any may be absent. */
export interface DetailFieldIds { start?: string; flag?: string; team?: string }

/**
 * The cards this card is linked to, in the order the site lists them. A link has two ends and this card is one: the
 * phrase is the type's wording for the card's own side ("blocks" when the other card is on the outward end).
 */
export function linkedOf(f: Record<string, unknown>, toRow: (stub: unknown) => ProviderTask | null): CardLinked[] {
  const out: CardLinked[] = [];
  for (const l of Array.isArray(f.issuelinks) ? f.issuelinks : []) {
    if (!isObj(l) || !isObj(l.type)) continue;
    const outward = isObj(l.outwardIssue);
    const other = outward ? l.outwardIssue : l.inwardIssue;
    const task = toRow(other);
    if (!task) continue;
    // The type names each side from the card's own point of view: this card "blocks" the one on the outward end.
    const phrase = str(outward ? l.type.outward : l.type.inward) || str(l.type.name);
    out.push({ id: idText(l.id) || `${phrase}-${task.id}`, phrase, type: str(l.type.name), direction: outward ? "out" : "in", task });
  }
  return out;
}

/** The card's files by name: no address, because the bytes are a redirect to another host that a later slice proxies. */
export function attachmentsOf(f: Record<string, unknown>): CardAttachment[] {
  const out: CardAttachment[] = [];
  for (const a of Array.isArray(f.attachment) ? f.attachment : []) {
    if (!isObj(a) || !idText(a.id) || !str(a.filename)) continue;
    const name = str(a.filename);
    const who = isObj(a.author) ? str(a.author.displayName) || str(a.author.name) : "";
    const at = epoch(a.created);
    out.push({
      id: idText(a.id), title: name, ext: /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase() ?? "",
      size: typeof a.size === "number" && a.size > 0 ? a.size : 0, url: "",
      ...(at ? { at } : {}), ...(who ? { who } : {}),
    });
  }
  return out;
}

const namesOf = (v: unknown): string => (Array.isArray(v) ? v : []).flatMap((x) => (isObj(x) && str(x.name) ? [str(x.name)] : [])).join(", ");

/** Time as the site writes it ("2d", "1d 4h"), only the parts the card has. */
function timeOf(v: unknown): string {
  if (!isObj(v)) return "";
  const parts = [["timeSpent", "spent"], ["originalEstimate", "estimated"], ["remainingEstimate", "left"]] as const;
  // "0m" is what a site writes for no time at all, which is no row: only an amount is worth a line.
  return parts.flatMap(([k, w]) => (str(v[k]) && !/^0[smhdw]?$/.test(str(v[k])) ? [`${str(v[k])} ${w}`] : [])).join(" · ");
}

const optionsOf = (v: unknown): string => (Array.isArray(v) ? v : []).flatMap((x) => (isObj(x) && str(x.value) ? [str(x.value)] : typeof x === "string" ? [x] : [])).join(", ");

/**
 * The Details, in the order Jira's own panel reads them. `offered` is the key set of `editmeta.fields`, or null when the
 * site sent none; `ids` are the custom fields found on the site.
 */
export function factsOf(f: Record<string, unknown>, ids: DetailFieldIds, offered: Set<string> | null): CardFact[] {
  const rows: { id: string; label: string; field: string; value: string; person?: Record<string, unknown>; tone?: "flag" }[] = [];
  const reporter = isObj(f.reporter) ? f.reporter : null;
  rows.push({ id: "reporter", label: "Reporter", field: "reporter", value: reporter ? str(reporter.displayName) || str(reporter.name) : "", person: reporter ?? undefined });
  rows.push({ id: "type", label: "Type", field: "issuetype", value: isObj(f.issuetype) ? str(f.issuetype.name) : "" });
  rows.push({ id: "components", label: "Components", field: "components", value: namesOf(f.components) });
  rows.push({ id: "fixVersions", label: "Fix versions", field: "fixVersions", value: namesOf(f.fixVersions) });
  rows.push({ id: "versions", label: "Affects versions", field: "versions", value: namesOf(f.versions) });
  rows.push({ id: "start", label: "Start date", field: ids.start ?? "", value: ids.start ? /^\d{4}-\d{2}-\d{2}/.exec(str(f[ids.start]))?.[0] ?? "" : "" });
  rows.push({ id: "time", label: "Time tracking", field: "timetracking", value: timeOf(f.timetracking) });
  const flag = ids.flag ? optionsOf(f[ids.flag]) : "";
  rows.push({ id: "flag", label: "Flagged", field: "", value: flag, tone: flag ? "flag" : undefined });
  const team = ids.team && isObj(f[ids.team]) ? str((f[ids.team] as Record<string, unknown>).name) || str((f[ids.team] as Record<string, unknown>).title) : "";
  rows.push({ id: "team", label: "Team", field: "", value: team });
  const out: CardFact[] = [];
  for (const r of rows) {
    if (!r.value && !(r.field && offered?.has(r.field))) continue;
    const avatar = r.person && isObj(r.person.avatarUrls) ? str(r.person.avatarUrls["48x48"]) : "";
    out.push({
      id: r.id, label: r.label, value: r.value,
      ...(r.person && r.value ? { initials: initialsOf(r.value), ...(avatar.startsWith("https://") ? { avatar } : {}) } : {}),
      ...(r.tone ? { tone: r.tone } : {}),
    });
  }
  return out;
}

/** The field ids `expand=editmeta` lists, or null when the answer carries none. */
export function offeredFields(issue: unknown): Set<string> | null {
  const m = isObj(issue) && isObj(issue.editmeta) && isObj(issue.editmeta.fields) ? issue.editmeta.fields : null;
  return m ? new Set(Object.keys(m)) : null;
}

/** Every remote link of a card as a row: any address, a pull request marked as one. A link with no address is not a row. */
export function webLinksOf(raw: unknown): CardWebLink[] {
  const out: CardWebLink[] = [];
  const seen = new Set<string>();
  for (const l of Array.isArray(raw) ? raw : []) {
    if (!isObj(l) || !isObj(l.object)) continue;
    const url = str(l.object.url);
    let u: URL;
    try { u = new URL(url); } catch { continue; }
    // A row opens in the app's browser: only addresses a person would click.
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ id: idText(l.id) || url, url, title: str(l.object.title) || u.host, host: u.host, ...(prAddress(url) ? { pr: true } : {}) });
  }
  return out;
}

/** A Cloud account id, a Data Center key or login: how the site names a person. */
export const personId = (u: Record<string, unknown>): string => str(u.accountId) || str(u.key) || str(u.name);
export const avatarOf = (u: Record<string, unknown>): string | undefined => {
  const a = isObj(u.avatarUrls) ? str(u.avatarUrls["48x48"]) : "";
  return a.startsWith("https://") ? a : undefined;
};
export const initialsFor = initialsOf;
export const epochOf = epoch;

/**
 * The site's words as Markdown: ADF on Cloud's v3, wiki markup on Data Center's v2. A login inside `[~ada]` is shown
 * by the name the same answer gave it, and anyone else by the login.
 */
export const textReader = (v: 2 | 3, names: Record<string, string>) => (body: unknown): string =>
  (v === 3 ? adfToMarkdown(body) : wikiToMarkdown(body, names)).text;

/** Login to display name, from every person the answer named. */
export function loginNames(people: unknown[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const u of people) if (isObj(u) && str(u.name) && str(u.displayName)) names[str(u.name)] = str(u.displayName);
  return names;
}

/** The comments of one answer as the pane draws them, oldest first, and the names its authors went by. */
export function commentRows(raw: Record<string, unknown>[], v: 2 | 3, me: string | undefined, others: unknown[] = []): { comments: TaskDetail["comments"]; names: Record<string, string> } {
  const names = loginNames([...others, ...raw.map((c) => c.author)]);
  const read = textReader(v, names);
  const comments = raw.map((c) => {
    const a = isObj(c.author) ? c.author : {};
    const who = str(a.displayName) || str(a.name) || "Someone";
    const avatar = avatarOf(a);
    return {
      id: str(c.id) || String(c.id ?? ""),
      who,
      text: read(c.body),
      at: epoch(c.created),
      initials: initialsOf(who),
      ...(avatar ? { avatar } : {}),
      ...(me && personId(a) === me ? { mine: true as const } : {}),
    };
  }).filter((c) => c.id).sort((x, y) => x.at - y.at);
  return { comments, names };
}
