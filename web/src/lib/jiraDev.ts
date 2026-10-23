/*
 * What the site's development tool holds for a card, read once per card.
 *
 * One request to our own server (`GET /jira/dev`), which asks the site for a
 * summary and, for the kinds that counted something, their rows. It is made when
 * a card is opened and held for TTL_MS, as the card's links are (lib/jiraLinks.ts);
 * there is no timer. A site with no tool connected, no panel or a shape that
 * changed answers `null`, which is held as well so it is not asked on every render.
 *
 * The pull requests the tool lists are joined to the ones agentglass finds itself
 * (remote links, the card's own words) by address: one pull request is one row,
 * with the richest state of the two. Ceiling: a pull request the tool reports on
 * a host `prAddress` does not know (a Bitbucket address) keeps its own address
 * as the key and is opened by its number, as any other.
 */
import { api } from "./api.ts";
import type { CardDev, CardDevPr } from "../../../shared/providers.ts";
import { prAddress } from "../../../shared/taskref.ts";
import type { JiraLink } from "./jiraLinks.ts";

const TTL_MS = 60_000;
const held = new Map<string, { at: number; dev: CardDev | null }>();
const pending = new Map<string, Promise<CardDev | null>>();

/** The card's development data: from memory while fresh, otherwise one request shared by whoever asks meanwhile. */
export function readJiraDev(issueId: string): Promise<CardDev | null> {
  const hit = held.get(issueId);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.dev);
  const going = pending.get(issueId);
  if (going) return going;
  const p = api.jiraDev(issueId)
    .then((r) => (r?.ok && r.dev ? r.dev : null))
    .catch(() => null)
    .then((dev) => { held.set(issueId, { at: Date.now(), dev }); pending.delete(issueId); return dev; });
  pending.set(issueId, p);
  return p;
}
export function forgetJiraDev(): void { held.clear(); pending.clear(); }

/** The number a pull request address ends in, for one on a host the app has no pattern for. */
const numberOf = (url: string): number => Number(/(\d+)\/?$/.exec(new URL(url).pathname)?.[1] ?? 0);

/**
 * The card's pull requests: what agentglass found (links first, then mentions) with what the tool says about each laid
 * over it, then the tool's own that nothing else named. A row the tool knows carries its state, title and reviewers; a row
 * only the tool knows is marked "dev". Order is stable: the app's rows keep their place.
 */
export function withDev(links: JiraLink[], dev: CardDevPr[]): JiraLink[] {
  const key = (u: string) => prAddress(u)?.url ?? u;
  const by = new Map(dev.map((d) => [key(d.url), d]));
  const out: JiraLink[] = links.map((l) => {
    const d = by.get(key(l.url));
    return d ? { ...l, title: d.title || l.title, dev: d } : l;
  });
  const have = new Set(out.map((l) => key(l.url)));
  for (const d of dev) {
    if (have.has(key(d.url))) continue;
    have.add(key(d.url));
    out.push({ url: d.url, number: prAddress(d.url)?.number ?? numberOf(d.url), title: d.title, resolved: d.state !== "OPEN", where: "dev", dev: d });
  }
  return out;
}

/** "2 of 3 approved", or nothing when nobody was asked. */
export function approvalsOf(d: CardDevPr): string {
  const asked = d.reviewers.length;
  if (!asked) return "";
  const ok = d.reviewers.filter((r) => r.approved).length;
  return `${ok} of ${asked} approved`;
}

/** The header's counts, in the order the site's panel shows them; a kind of zero is left out. */
export function countsLine(c: CardDev["counts"]): string {
  const part = (n: number, one: string, many: string) => (n ? [`${n} ${n === 1 ? one : many}`] : []);
  return [...part(c.pullRequests, "PR", "PRs"), ...part(c.branches, "branch", "branches"), ...part(c.commits, "commit", "commits"), ...part(c.builds, "build", "builds")].join(" · ");
}
