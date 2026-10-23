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

export interface JiraLink { url: string; number: number; title: string; resolved: boolean }
export type JiraLinks = { links: JiraLink[]; error: string };

const TTL_MS = 60_000;
const held = new Map<string, { at: number; value: JiraLinks }>();
const pending = new Map<string, Promise<JiraLinks>>();

/** The card's links: from memory while fresh, otherwise one request, shared by whoever asks meanwhile. */
export function readJiraLinks(key: string): Promise<JiraLinks> {
  const hit = held.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.value);
  const going = pending.get(key);
  if (going) return going;
  const p = api.jiraLinks(key)
    .then((r): JiraLinks => ({ links: r?.ok ? r.links ?? [] : [], error: r?.ok ? "" : r?.error || "Jira did not answer" }))
    .catch((): JiraLinks => ({ links: [], error: "Could not reach the server" }))
    .then((value) => { held.set(key, { at: Date.now(), value }); pending.delete(key); return value; });
  pending.set(key, p);
  return p;
}

/** A write just put this link on the card: what the card now carries, without asking again. */
export function addJiraLink(key: string, link: JiraLink): JiraLinks {
  const cur = held.get(key)?.value ?? { links: [], error: "" };
  const value = { links: cur.links.some((l) => l.url === link.url) ? cur.links : [...cur.links, link], error: "" };
  held.set(key, { at: Date.now(), value });
  return value;
}

export function forgetJiraLinks(): void { held.clear(); pending.clear(); }
