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
import type { CardWebLink } from "../../../shared/providers.ts";
import { prMentions } from "../../../shared/taskref.ts";

/** Where a row came from: a real remote link, or an address somebody wrote in the card's words. */
export type LinkWhere = "link" | "comment" | "description";
export interface JiraLink { url: string; number: number; title: string; resolved: boolean; where?: LinkWhere }
/** `web` is every remote link of the card, the pull requests among them; `links` is the pull requests alone. */
export type JiraLinks = { links: JiraLink[]; web: CardWebLink[]; error: string };

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
    .then((r): JiraLinks => ({ links: r?.ok ? r.links ?? [] : [], web: r?.ok ? r.web ?? [] : [], error: r?.ok ? "" : r?.error || "Jira did not answer" }))
    .catch((): JiraLinks => ({ links: [], web: [], error: "Could not reach the server" }))
    .then((value) => { held.set(key, { at: Date.now(), value }); pending.delete(key); changed(); return value; });
  pending.set(key, p);
  return p;
}

/** A write just put this link on the card: what the card now carries, without asking again. */
export function addJiraLink(key: string, link: JiraLink): JiraLinks {
  const cur = held.get(key)?.value ?? { links: [], web: [], error: "" };
  const value = {
    links: cur.links.some((l) => l.url === link.url) ? cur.links : [...cur.links, link],
    web: cur.web.some((w) => w.url === link.url) ? cur.web : [...cur.web, { id: link.url, url: link.url, title: link.title, host: new URL(link.url).host, pr: true }],
    error: "",
  };
  held.set(key, { at: Date.now(), value });
  changed();
  return value;
}

/**
 * A write just changed the card's web addresses: what the site now lists, without asking again. The pull requests among them
 * are the rows whose address is still there; one the write ADDED is not in `links` yet (its number and state come from a read),
 * so that card is read again in the background and the Development tab catches up.
 */
export function setJiraWeb(key: string, web: CardWebLink[]): JiraLinks {
  const cur = held.get(key)?.value ?? { links: [], web: [], error: "" };
  const value = { links: cur.links.filter((l) => web.some((w) => w.url === l.url)), web, error: "" };
  const adds = web.some((w) => w.pr && !cur.links.some((l) => l.url === w.url));
  held.set(key, { at: adds ? 0 : Date.now(), value });
  changed();
  if (adds) void readJiraLinks(key);
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
