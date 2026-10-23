/*
 * The Jira cards the pull request list names, resolved ahead of the rows.
 *
 * The list path draws a card from cache alone (see `cardFor` in prs.ts), so a
 * pull request whose key sits on none of the saved boards had no chip row at
 * all, where the same pull request against ClickUp had one. This is the other
 * half: ONE bounded search per list read for the keys nothing holds yet, kept
 * here so the next read costs nothing. `cardFor` stays synchronous and never
 * makes a request; this runs once before the rows are built.
 *
 * Budget, measured against the hundred-per-minute ceiling the ClickUp side
 * already lives under: one `key in (...)` of at most fifty keys per list read,
 * and only for keys not read in the last five minutes, found or not. A failed
 * search keeps what was held and is not repeated for a minute, so a site that
 * is down is asked once a minute, not once per poll.
 *
 * Ceiling: past fifty distinct keys in one page the rest wait for the next
 * read; a list page is thirty rows, so this is a guard, not a limit anybody
 * meets.
 */
import { boardHolding, knownKeys } from "./jiraviews.ts";
import { hasCredential } from "./credentials.ts";
import { projects, searchJql, withStored, type JiraCreds, type JiraResult, type JiraTasks } from "./jira.ts";
import type { ProviderTask } from "../../shared/providers.ts";

const TTL_MS = 5 * 60_000;
/** A failed read is asked again after this long, not after TTL_MS. */
const RETRY_MS = 60_000;
export const BATCH_MAX = 50;
const DAY_MS = 24 * 60 * 60_000;

const held = new Map<string, { at: number; task: ProviderTask }>();
/** When a key was last asked, found or not, so a card that does not exist is not asked for on every read. */
const askedAt = new Map<string, number>();
/** Project keys the site lists, for a prefix no cached card has carried yet. */
const projectKeys = new Map<string, { at: number; keys: string[] }>();
const PROJECTS_TTL_MS = 10 * 60_000;
let running: Promise<void> | null = null;

const keyOf = (site: string, ref: string): string => `${site}|${ref.toUpperCase()}`;
const REF = /^[A-Z][A-Z0-9_]*-\d+$/;

/** The key in a branch or a title, read against the project keys given. The one rule the list and the panel share. */
export function readJiraRef(keys: readonly string[], branch: string, title: string): string | undefined {
  const alt = keys.map((k) => k.replace(/[^A-Z0-9_]/g, "")).filter(Boolean).join("|");
  if (!alt) return undefined;
  const read = (text: string, flags: string): string | undefined =>
    new RegExp(`(?<![A-Za-z0-9_])(${alt})-(\\d+)(?![A-Za-z0-9_]|-\\d)`, flags).exec(text)?.slice(1, 3).join("-").toUpperCase();
  return read(branch, "i") ?? read(title, "");
}

/** Every project key this site is known by: those on cached cards, then those Jira listed when a list asked. */
export function siteKeys(site: string): string[] {
  const all = new Set([...knownKeys(site), ...(projectKeys.get(site)?.keys ?? [])]);
  return [...all].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/** A card this process read, if it is not older than `freshMs`. */
export function heldCard(site: string, ref: string, freshMs: number = DAY_MS): { at: number; task: ProviderTask } | null {
  const hit = held.get(keyOf(site, ref));
  return hit && Date.now() - hit.at <= freshMs ? hit : null;
}

/**
 * Keep a card some read just returned. One fact, two views: the card panel's
 * lookup writes here too, so opening a card the list resolved costs nothing and
 * the list draws what the panel just read. The newer reading wins.
 */
export function holdCard(site: string, task: ProviderTask, at: number = Date.now()): void {
  const ref = (task.customId ?? "").toUpperCase();
  if (!REF.test(ref)) return;
  const k = keyOf(site, ref);
  const prior = held.get(k);
  if (prior && prior.at > at) return;
  held.set(k, { at, task });
  askedAt.set(k, at);
}

/** Test seam: how the one search is made. */
type Reader = (creds: JiraCreds, jql: string) => Promise<JiraResult<JiraTasks>>;
let reader: Reader = (creds, jql) => searchJql(creds, jql, { pages: 1, optional: true, light: true });
export function __setReader(r: Reader | null): void { reader = r ?? ((creds, jql) => searchJql(creds, jql, { pages: 1, optional: true, light: true })); }
/** Test seam: how the site's project keys are asked for. */
type Lister = (creds: JiraCreds) => Promise<JiraResult<{ keys: string[] }>>;
const listProjects: Lister = (creds) => projects(creds, { optional: true });
let lister: Lister = listProjects;
export function __setLister(l: Lister | null): void { lister = l ?? listProjects; }
export function __clearPrCards(): void { held.clear(); askedAt.clear(); projectKeys.clear(); running = null; }

/**
 * Resolve the Jira keys these rows name, in one search. Never throws and never
 * delays the list past one Jira answer; a site that is not connected, or rows
 * with no key, cost nothing.
 */
export async function resolveJiraCards(rows: ReadonlyArray<{ headRefName?: unknown; title?: unknown }>): Promise<void> {
  if (!hasCredential("jira") || !rows.length) return;
  // A second list read while one is in the air joins it instead of asking again.
  if (running) return running;
  running = (async () => { try { await resolve(rows); } catch { /* the rows are drawn without the card */ } })()
    .finally(() => { running = null; });
  return running;
}

async function resolve(rows: ReadonlyArray<{ headRefName?: unknown; title?: unknown }>): Promise<void> {
  const texts = rows.map((r) => [typeof r.headRefName === "string" ? r.headRefName : "", typeof r.title === "string" ? r.title : ""] as const);
  await withStored(async (creds) => {
    const site = creds.site;
    /* A prefix no cached card has carried is a word until the site says it is a
       project. `projects` is kept for ten minutes by the client, so this is at
       most one request in ten (a branch called `fix-123` is key-shaped and never
       becomes known, so the time bound is what keeps this from every read). */
    const candidate = /(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]*)-\d+(?![A-Za-z0-9_]|-\d)/i;
    const known = () => new Set(siteKeys(site));
    const unknown = texts.some(([b, t]) => [b, t].some((x) => { const p = candidate.exec(x)?.[1]?.toUpperCase(); return !!p && !known().has(p); }));
    if (unknown && Date.now() - (projectKeys.get(site)?.at ?? 0) > PROJECTS_TTL_MS) {
      const p = await lister(creds);
      if (p.ok && p.data) projectKeys.set(site, { at: Date.now(), keys: p.data.keys });
      else projectKeys.set(site, { at: Date.now() - PROJECTS_TTL_MS + RETRY_MS, keys: projectKeys.get(site)?.keys ?? [] });
    }
    const keys = siteKeys(site);
    const now = Date.now();
    const want = new Set<string>();
    for (const [b, t] of texts) {
      const ref = readJiraRef(keys, b, t);
      if (!ref) continue;
      if (now - (askedAt.get(keyOf(site, ref)) ?? 0) < TTL_MS) continue;
      if (boardHolding(site, ref, { freshMs: TTL_MS })) continue;
      want.add(ref);
    }
    if (!want.size) return { ok: true, data: undefined };
    const batch = [...want].sort().slice(0, BATCH_MAX);
    const r = await reader(creds, `key in (${batch.join(", ")})`);
    const at = Date.now();
    if (!r.ok || !r.data) {
      // Keep every chip already held; ask again soon, not on the next poll.
      for (const ref of batch) askedAt.set(keyOf(site, ref), at - TTL_MS + RETRY_MS);
      return { ok: true, data: undefined };
    }
    for (const ref of batch) askedAt.set(keyOf(site, ref), at);
    for (const t of r.data.tasks) holdCard(site, t, at);
    return { ok: true, data: undefined };
  });
}
