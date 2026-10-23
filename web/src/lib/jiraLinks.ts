/*
 * The pull requests a Jira card carries as remote links, read once per card.
 *
 * Opening a card costs ONE request to the site (`GET /jira/links`); the pane
 * that draws it, a second pane on the same card and a re-render all share it.
 * There is no timer: a card is read when it is opened and again only after it
 * has been closed for longer than TTL_MS, or after a link was written to it.
 * Failures are held as well, so a site that does not answer is asked once and
 * not on every render.
 */
import { api } from "./api.ts";
import { prMentions } from "../../../shared/taskref.ts";

/** Where a row came from: a real remote link, or an address somebody wrote in the card's words. */
export type LinkWhere = "link" | "comment" | "description";
export interface JiraLink { url: string; number: number; title: string; resolved: boolean; where?: LinkWhere }
export type JiraLinks = { links: JiraLink[]; error: string };

const TTL_MS = 60_000;
const held = new Map<string, { at: number; value: JiraLinks }>();
const pending = new Map<string, Promise<JiraLinks>>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => { version++; for (const f of listeners) f(); };

/** What is held for a card, without asking: the pane's tab counter reads this and costs no request. */
export function peekJiraLinks(key: string): JiraLinks | null { return held.get(key)?.value ?? null; }
export function onJiraLinks(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function jiraLinksVersion(): number { return version; }

/** The card's links: from memory while fresh, otherwise one request, shared by whoever asks meanwhile. */
export function readJiraLinks(key: string): Promise<JiraLinks> {
  const hit = held.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.value);
  const going = pending.get(key);
  if (going) return going;
  const p = api.jiraLinks(key)
    .then((r): JiraLinks => ({ links: r?.ok ? r.links ?? [] : [], error: r?.ok ? "" : r?.error || "Jira did not answer" }))
    .catch((): JiraLinks => ({ links: [], error: "Could not reach the server" }))
    .then((value) => { held.set(key, { at: Date.now(), value }); pending.delete(key); changed(); return value; });
  pending.set(key, p);
  return p;
}

/** A write just put this link on the card: what the card now carries, without asking again. */
export function addJiraLink(key: string, link: JiraLink): JiraLinks {
  const cur = held.get(key)?.value ?? { links: [], error: "" };
  const value = { links: cur.links.some((l) => l.url === link.url) ? cur.links : [...cur.links, link], error: "" };
  held.set(key, { at: Date.now(), value });
  changed();
  return value;
}

export function forgetJiraLinks(): void { held.clear(); pending.clear(); changed(); }

/** Most rows the tab will hold: a card quoting a whole release's pull requests is not a list of its own. */
export const MENTION_CAP = 20;

/**
 * The pull request addresses written in the card's description and comments,
 * from the detail read the card pane already made: no request of its own.
 * Comments are read oldest first as they come; the description wins a tie.
 */
export function mentionsOfCard(d: { description: string; comments: { text: string }[] }): JiraLink[] {
  const out = new Map<string, JiraLink>();
  const take = (text: string, where: LinkWhere) => {
    for (const a of prMentions(text)) if (!out.has(a.url)) out.set(a.url, { url: a.url, number: a.number, title: `${a.slug}#${a.number}`, resolved: false, where });
  };
  take(d.description, "description");
  for (const c of d.comments) take(c.text, "comment");
  return [...out.values()];
}

/** The card's remote links first (they are never dropped), then the mentions that are not already one, up to the cap. */
export function withMentions(links: JiraLink[], mentions: JiraLink[]): JiraLink[] {
  const out: JiraLink[] = links.map((l) => ({ ...l, where: "link" }));
  const have = new Set(out.map((l) => l.url));
  for (const m of mentions) if (out.length < MENTION_CAP && !have.has(m.url)) { have.add(m.url); out.push(m); }
  return out;
}
