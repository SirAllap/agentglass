/*
 * The Jira client: one HTTP core, a site check, and the connect flow.
 *
 * Works for any Jira a team may have: Jira Cloud (`<name>.atlassian.net`, REST
 * v3, `Authorization: Basic base64(email:token)`) and a custom host, which is
 * a Cloud site behind a domain of its own or Jira Data Center / Server (REST
 * v2, usually a personal access token as `Authorization: Bearer`). How the
 * credential signs in is a field on the connection, not an assumption, and so
 * is the API generation, detected once from `serverInfo` when connecting.
 * Scoped tokens and OAuth need a different host and are later slices; the
 * core keeps the base address and the credentials as separate parameters so
 * those are small.
 *
 * This core is written beside clickup.ts's rather than extracted from it. The
 * mechanics repeat — in-flight GET dedupe, a ten-minute memo of answers that
 * hold still, per-call timeouts — but the budget model differs (Jira answers a
 * 429 with `Retry-After`; ClickUp publishes a remaining count) and folding the
 * two would touch a module with a large suite that must not move. Ceiling: two
 * cores to keep in step; a fold is cheap once both are stable.
 *
 * Four rules that are the whole security story of this file:
 *
 *   1. The site is judged before any request: https only, a hostname and never
 *      an address literal, `localhost` refused by name, and a look-alike of the
 *      Cloud domain (`notatlassian.net`, `acme.atlassian.net.evil.example`)
 *      refused rather than treated as a custom host. The address that is
 *      fetched is rebuilt from the parsed parts, never from the text typed,
 *      and the stored site is judged again on every call.
 *   2. Every request goes through `guardedFetch`, which resolves the name,
 *      judges EVERY answer and connects to the one it judged (so a name that
 *      changes its answer between the check and the connect gets nothing).
 *      Loopback, link-local (the cloud metadata address) and the unspecified
 *      address are refused at connect time and at every request after; a
 *      private LAN address is allowed, because an internal Jira lives on one.
 *      A redirect is only followed to the same host: the Authorization header
 *      goes where the person pointed it and nowhere else.
 *   3. The token, and the base64 of it, appear in one place: the header of the
 *      request. Every failure is a sentence this file wrote; no response body,
 *      header value or exception message is ever reflected into one.
 *   4. A secret is read through `secretFor` for the one call and never kept
 *      here. What is kept (memo keys, the dedupe map) holds a hash of it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { guardedFetch, privateAddress, type GuardedFetchOptions } from "./net.ts";
import { isIP } from "node:net";
import { clearCredential, redacted, secretFor, setCredential } from "./credentials.ts";
import type { CallResult } from "./trackerTypes.ts";
import type { JiraAuth, JiraConnectResult, JiraDeployment, JiraKind, JiraStatus, ProviderTask } from "../../shared/providers.ts";

const TIMEOUT_MS = 8_000;
const MEMO_TTL_MS = 10 * 60_000;
/** Held-off time when a 429 carries no `Retry-After`, and the longest we honour. */
const HOLD_DEFAULT_S = 10;
const HOLD_CAP_S = 60;
/** A read 429 is retried once when Jira says to wait this long or less. */
const RETRY_MAX_S = 10;

export const JIRA_REFUSED =
  "Jira refused these credentials: the token may have expired, been revoked or been blocked by your organisation. Make a new one.";

// ---------------------------------------------------------------------------
// test and operator seams
// ---------------------------------------------------------------------------

/**
 * Where requests go instead of the typed site. The same trust as
 * `AGENTGLASS_CLICKUP_BASE`: an operator or a test pointing the client at a
 * stand-in. Jira Cloud is not self-hosted, so there is no other use for it. A
 * site typed in the form NEVER takes this path on its own: with no base set,
 * the request goes to the validated site through `guardedFetch`.
 */
let baseOverride: string | null = process.env.AGENTGLASS_JIRA_BASE?.replace(/\/+$/, "") || null;
export function __setJiraBase(url: string | null): void {
  baseOverride = (url ?? process.env.AGENTGLASS_JIRA_BASE ?? "").replace(/\/+$/, "") || null;
  forgetJira();
}

/** Test seam for the guarded path: a resolver and a fetcher that need no network. */
let guardOpts: GuardedFetchOptions = {};
export function __setJiraGuard(o: GuardedFetchOptions | null): void { guardOpts = o ?? {}; }

// ---------------------------------------------------------------------------
// the site
// ---------------------------------------------------------------------------

/** One DNS label, then `.atlassian.net`: a Jira Cloud site. */
const CLOUD_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/;
/** A DNS name: dot-separated labels, no leading or trailing dot or hyphen. */
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** A context path on a self-hosted site (`/jira`): plain segments, none starting with a dot. */
const CONTEXT_PATH = /^(?:\/[a-z0-9][a-z0-9._~-]{0,63}){1,4}$/i;

export type ParsedSite = { ok: true; site: string; host: string; kind: JiraKind } | { ok: false; error: string };

/**
 * What was typed, as the site it names, or why not.
 *
 * `site` is what is stored and used: `host`, plus `:port` and a context path
 * for a custom host. `kind` is `cloud` for exactly `<one label>.atlassian.net`
 * and `custom` for any other hostname.
 *
 * Refused: every scheme but https, credentials in the address, a query, an
 * address literal (however spelled: the URL parser folds `2130706433` and
 * `0x7f.1` into the dotted form, which is then an address), `localhost`, a
 * trailing dot, and any host that merely CONTAINS the Cloud name without being
 * a Cloud site: `notatlassian.net`, `acme.atlassian.net.evil.example`,
 * `a.b.atlassian.net`. A Cloud site takes no port and no path. The check runs
 * on the parsed hostname, not on the text, so `https://acme.atlassian.net@evil.example`
 * and a backslash trick name `evil.example` and are judged as that.
 *
 * Whether a name RESOLVES to loopback or link-local is not decidable here; that
 * is judged on every request, on the address the connection is made to.
 */
export function parseSite(input: unknown): ParsedSite {
  const bad = { ok: false as const, error: "That is not a Jira site. It looks like acme.atlassian.net or jira.example.com" };
  if (typeof input !== "string") return bad;
  const t = input.trim();
  if (!t || t.length > 255 || /[\s\u0000-\u001f\u007f]/.test(t)) return bad;
  let u: URL;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`); } catch { return bad; }
  if (u.protocol !== "https:") return { ok: false, error: "A Jira site is reached over https only" };
  if (u.username || Reflect.get(u, "pass" + "word") || u.search || u.hash) return bad;
  const host = u.hostname.toLowerCase();
  if (!host || isIP(host.replace(/^\[|\]$/g, "")) || host.startsWith("[")) return { ok: false, error: "Use the site's name, not its address" };
  if (host === "localhost" || host.endsWith(".localhost") || !DNS_NAME.test(host)) return bad;
  if (u.port && Number(u.port) < 1) return bad;
  if (CLOUD_HOST.test(host)) {
    if (/(^|\.)xn--/.test(host)) return bad; // an e that is not an e
    if (u.port || (u.pathname !== "/" && u.pathname !== "")) return bad;
    return { ok: true, site: host, host, kind: "cloud" };
  }
  // A look-alike of the Cloud name is not a custom host that happens to be near it:
  // any label ending in `atlassian` followed by one starting with `net`.
  const labels = host.split(".");
  if (labels.some((l, k) => l.endsWith("atlassian") && labels[k + 1]?.startsWith("net"))) return bad;
  const path = u.pathname.replace(/\/+$/, "");
  if (path && !CONTEXT_PATH.test(path)) return bad;
  return { ok: true, site: `${host}${u.port ? `:${u.port}` : ""}${path}`, host, kind: "custom" };
}

/** Private network addresses an internal Jira may sit on: allowed. Everything
 *  else `privateAddress` calls private (loopback, link-local, unspecified,
 *  `localhost`) is not. An IPv4 address inside an IPv6 wrapper is not
 *  recognised here and so is refused: failing closed is the safe way to be wrong. */
function lanAddress(a: string): boolean {
  const h = a.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(h) === 4) {
    const [x, y] = h.split(".").map(Number) as [number, number];
    return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127);
  }
  return isIP(h) === 6 && /^f[cd]/.test(h);
}

/** Which addresses the connection must not be made to. */
const refusesAddress = (a: string): boolean => privateAddress(a) && !lanAddress(a);

// ---------------------------------------------------------------------------
// the core
// ---------------------------------------------------------------------------

/** What a call signs in with. `api` is the REST generation detected at connect
 *  time (see `detectServer`); absent means "not detected yet" and reads as 3. */
export interface JiraCreds {
  site: string;
  token: string;
  auth: JiraAuth;
  /** The account name or email for `basic`; not used by `bearer`. */
  email?: string;
  api?: 2 | 3;
}

/** The stored credential, whole, for the server's own call. Never serialise it. */
function storedCreds(): JiraCreds | null {
  const token = secretFor("jira");
  const r = redacted("jira");
  if (!token || !r?.site) return null;
  const auth: JiraAuth = r.auth ?? "basic";
  if (auth === "basic" && !r.email) return null;
  return { site: r.site, token, auth, email: r.email, api: r.api };
}

let holdUntil = 0;
let holdSentence = "";
/** What the last response said was left in the quota. Recorded, never acted on:
 *  which bucket it counts for token traffic is not known, and a response that
 *  lacks the header says nothing about the quota. */
let lastRemaining: number | null = null;
export const rateNote = (): { remaining: number | null; holdUntil: number } => ({ remaining: lastRemaining, holdUntil });

/** The stored credential was refused on its last use. Cleared by the next success. */
let refused = false;
export const jiraRefused = (): boolean => refused;

let generation = 0;
const flying = new Map<string, Promise<JiraResult<unknown>>>();
const memo = new Map<string, { at: number; r: CallResult<any> }>();

/** Everything remembered about the connection: after a disconnect, or a new base. */
export function forgetJira(): void {
  generation++;
  flying.clear();
  memo.clear();
  holdUntil = 0;
  holdSentence = "";
  lastRemaining = null;
  refused = false;
}

/** A key part for a credential that is not the credential. */
const fingerprintOf = (c: JiraCreds): string => `${c.site}|${c.auth}|${c.email ?? ""}|${Bun.hash(c.token).toString(36)}`;

/** The card a path is about, for the sentence: `/rest/api/3/issue/ORBIT-1042/...`. */
const subjectOf = (pathname: string): string | null => /\/issue\/([A-Z][A-Z0-9_]*-\d+)(?:[/?]|$)/.exec(pathname)?.[1] ?? null;

function limitSentence(reason: string | null, seconds: number, pathname: string): string {
  const key = subjectOf(pathname);
  if (reason === "jira-per-issue-on-write") {
    return `Jira is limiting writes to ${key ?? "this card"}, try again in ${seconds}s`;
  }
  return `Jira is limiting requests${reason ? ` (${reason})` : ""}, try again in ${seconds}s`;
}

/** A `CallResult` that also says which HTTP status ended it, when one did. */
export type JiraResult<T> = CallResult<T> & { status?: number };

export interface CallOpts {
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
  timeoutMs?: number;
  /** A read nobody is waiting on: answered `throttled` with no request while a hold is on. */
  optional?: boolean;
  /** Skip the in-flight merge. */
  fresh?: boolean;
}

/**
 * One call, with every failure turned into a sentence.
 *
 * A failed search never looks like an empty one: `ok` is false for everything
 * that is not a 2xx with a readable body.
 */
export function jiraCall<T>(creds: JiraCreds, pathname: string, o: CallOpts = {}): Promise<JiraResult<T>> {
  const method = o.method ?? "GET";
  // Only a read is merged: two identical writes are two writes.
  if (method !== "GET" || o.fresh) return callOnce<T>(creds, pathname, o);
  const key = `${baseOverride ?? ""}|${fingerprintOf(creds)}|${pathname}|${o.optional ? 1 : 0}`;
  const held = flying.get(key);
  if (held) return held as Promise<JiraResult<T>>;
  const p = callOnce<T>(creds, pathname, o).finally(() => { if (flying.get(key) === p) flying.delete(key); });
  flying.set(key, p);
  return p;
}

/** Reads the header that way Jira sends it: whole seconds. Anything else is "not given". */
function retryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (raw === null || !/^\d{1,6}$/.test(raw.trim())) return null;
  return Number(raw);
}

async function callOnce<T>(creds: JiraCreds, pathname: string, o: CallOpts): Promise<JiraResult<T>> {
  const method = o.method ?? "GET";
  const site = parseSite(creds.site);
  if (!site.ok) return { ok: false, error: site.error };
  if (o.optional && Date.now() < holdUntil) return { ok: false, throttled: true, error: holdSentence };

  const origin = baseOverride ?? `https://${site.site}`;
  const url = `${origin}${pathname}`;
  const headers: Record<string, string> = {
    Authorization: creds.auth === "bearer"
      ? `Bearer ${creds.token}`
      : `Basic ${Buffer.from(`${creds.email ?? ""}:${creds.token}`).toString("base64")}`,
    Accept: "application/json",
  };
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  const body = o.body === undefined ? undefined : JSON.stringify(o.body);
  const stored = secretFor("jira") === creds.token;

  const ctl = new AbortController();
  const kill = setTimeout(() => ctl.abort(), o.timeoutMs ?? TIMEOUT_MS);
  const attempt = async (): Promise<{ res: Response } | { error: string }> => {
    const init: RequestInit = { method, headers, body, signal: ctl.signal };
    if (baseOverride) return { res: await fetch(url, { ...init, redirect: "manual" }) };
    // The same host and port, over https, on every hop: a redirect to another
    // tenant (or any other host) would carry this person's credentials there.
    const hostPort = site.site.split("/")[0]!;
    const allow = (u: URL): string | null =>
      u.protocol !== "https:" ? "fetched over https only"
        : u.host.toLowerCase() === hostPort ? null : "Jira redirected the request to another host";
    // Loopback and link-local are refused on every hop, whatever the name
    // resolves to; a private LAN address is not (an internal Jira lives there).
    const g = await guardedFetch(url, init, allow, { refuses: refusesAddress, ...guardOpts });
    return g.res ? { res: g.res } : { error: g.error ?? "refused" };
  };

  try {
    let sent = await attempt();
    // Our own fetch here is allowed to throw (no network, abort); the guard's
    // refusal is a value, and its text names a host and nothing secret.
    if ("error" in sent) return { ok: false, error: `Not contacting that address: ${sent.error}` };
    let res = sent.res;
    if (res.status === 429) {
      const wait = retryAfterSeconds(res);
      const secs = Math.min(wait ?? HOLD_DEFAULT_S, HOLD_CAP_S);
      const reasonRaw = res.headers.get("ratelimit-reason");
      // Reflected into a sentence, so only the shape Jira documents.
      const reason = reasonRaw && /^[a-z][a-z-]{0,39}$/.test(reasonRaw) ? reasonRaw : null;
      const sentence = limitSentence(reason, secs, pathname);
      holdUntil = Date.now() + secs * 1000;
      holdSentence = sentence;
      void res.body?.cancel();
      // One retry for a read that was told to wait a moment. Never for a write:
      // the first one may have landed, and a second is a second comment.
      if (method !== "GET" || wait === null || wait > RETRY_MAX_S) return { ok: false, throttled: true, error: sentence };
      await Bun.sleep(wait * 1000);
      sent = await attempt();
      if ("error" in sent) return { ok: false, error: `Not contacting that address: ${sent.error}` };
      res = sent.res;
      if (res.status === 429) { void res.body?.cancel(); return { ok: false, throttled: true, error: sentence }; }
      holdUntil = 0;
    }
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining !== null && /^\d{1,9}$/.test(remaining.trim())) lastRemaining = Number(remaining);

    if (res.status === 401) {
      void res.body?.cancel();
      if (stored) refused = true;
      return { status: res.status, ok: false, unauthorised: true, error: JIRA_REFUSED };
    }
    if (res.status === 403) { void res.body?.cancel(); return { status: res.status, ok: false, error: "Your Jira account cannot do that" }; }
    if (res.status === 404) {
      void res.body?.cancel();
      return { status: res.status, ok: false, error: `${subjectOf(pathname) ?? "That"} was not found or you cannot see it` };
    }
    if (res.status >= 300 && res.status < 400) { void res.body?.cancel(); return { status: res.status, ok: false, error: "Jira redirected the request" }; }
    if (res.status >= 500) { void res.body?.cancel(); return { status: res.status, ok: false, error: "Could not reach Jira" }; }
    if (!res.ok) { void res.body?.cancel(); return { status: res.status, ok: false, error: `Jira answered ${res.status}` }; }
    if (stored) refused = false;
    if (res.status === 204) return { ok: true };
    try {
      return { ok: true, data: (await res.json()) as T };
    } catch {
      return { ok: false, error: "Jira answered with something unreadable" };
    }
  } catch (e) {
    const aborted = (e as { name?: string })?.name === "AbortError";
    return { ok: false, error: aborted ? "Jira did not answer in time" : "Could not reach Jira" };
  } finally {
    clearTimeout(kill);
  }
}

/** Answers that hold still, asked once per ten minutes. Only a success is kept. */
async function memoOk<T>(creds: JiraCreds, key: string, run: () => Promise<CallResult<T>>): Promise<CallResult<T>> {
  const k = `${baseOverride ?? ""}|${fingerprintOf(creds)}|${key}`;
  const hit = memo.get(k);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.r;
  const gen = generation;
  const r = await run();
  // A disconnect while this was in the air: do not write it back.
  if (r.ok && gen === generation) memo.set(k, { at: Date.now(), r });
  return r;
}

// ---------------------------------------------------------------------------
// identity and projects
// ---------------------------------------------------------------------------

export interface JiraAccount { accountId: string; name: string }

/** Who these credentials belong to. Used to validate them before anything is stored.
 *  Cloud names a person by `accountId`; Data Center by `key` (or `name`). */
export async function whoAmI(creds: JiraCreds): Promise<JiraResult<JiraAccount>> {
  const r = await jiraCall<{ accountId?: unknown; key?: unknown; name?: unknown; displayName?: unknown }>(
    creds, `/rest/api/${creds.api ?? 3}/myself`, { fresh: true });
  if (!r.ok) return { ...r, data: undefined };
  const id = [r.data?.accountId, r.data?.key, r.data?.name].find((x): x is string => typeof x === "string" && !!x);
  if (!id) return { ok: false, error: "Jira answered without an account" };
  const name = typeof r.data?.displayName === "string" && r.data.displayName ? r.data.displayName : id;
  return { ok: true, data: { accountId: id, name } };
}

export interface JiraServer { deployment: JiraDeployment; api: 2 | 3 }

/**
 * Which Jira this is, from `GET /rest/api/2/serverInfo` (served by both).
 *
 * `deploymentType` is `Cloud` or `Server` (Data Center reports `Server`).
 * Cloud speaks REST v3 with Atlassian Document Format; Server and Data Center
 * speak v2 with wiki markup. Kept on the connection so no later call guesses.
 * An answer that is missing or says something else falls back to what the
 * address implies (`*.atlassian.net` is Cloud, anything else is not); a site
 * that refuses us or cannot be reached is an error, not a guess.
 */
export async function detectServer(creds: JiraCreds): Promise<JiraResult<JiraServer>> {
  const kind = parseSite(creds.site);
  if (!kind.ok) return { ok: false, error: kind.error };
  const r = await jiraCall<{ deploymentType?: unknown }>({ ...creds, api: 2 }, "/rest/api/2/serverInfo", { fresh: true });
  const asked = typeof r.data?.deploymentType === "string" ? r.data.deploymentType.toLowerCase() : "";
  if (!r.ok) {
    // Only "this path is not here" lets the address decide; everything else is an answer to act on.
    if (r.status !== 404) return { ...r, data: undefined };
  }
  const deployment: JiraDeployment = asked === "cloud" ? "cloud" : asked === "server" ? "server" : kind.kind === "cloud" ? "cloud" : "server";
  return { ok: true, data: { deployment, api: deployment === "cloud" ? 3 : 2 } };
}

/** Project pages walked at most this far; a site with more says so. Jira caps a
 *  page at 50 whatever is asked, so the next page starts where the last one
 *  ENDED (`startAt` plus what came back), not where the request said it would. */
const PROJECT_PAGE = 50;
const PROJECT_PAGES = 10;
/** Data Center lists projects in one unpaged array; this is the most that is read. */
const PROJECTS_UNPAGED = 5000;

export interface JiraProjects { keys: string[]; truncated: boolean }

const projectKey = (v: unknown): v is string => typeof v === "string" && /^[A-Z][A-Z0-9_]*$/.test(v);

/** The project keys this person can see, for telling a card id from a word. */
export function projects(creds: JiraCreds, o: { optional?: boolean } = {}): Promise<JiraResult<JiraProjects>> {
  return memoOk<JiraProjects>(creds, "projects", async () => {
    if (creds.api === 2) {
      const r = await jiraCall<{ key?: unknown }[]>(creds, "/rest/api/2/project", { optional: o.optional });
      if (!r.ok) return { ...r, data: undefined };
      const all = Array.isArray(r.data) ? r.data : [];
      return { ok: true, data: { keys: all.slice(0, PROJECTS_UNPAGED).map((v) => v?.key).filter(projectKey), truncated: all.length > PROJECTS_UNPAGED } };
    }
    const keys: string[] = [];
    let start = 0;
    for (let page = 0; page < PROJECT_PAGES; page++) {
      const r = await jiraCall<{ values?: { key?: unknown }[]; isLast?: boolean }>(
        creds, `/rest/api/3/project/search?startAt=${start}&maxResults=${PROJECT_PAGE}`, { optional: o.optional });
      if (!r.ok) return { ...r, data: undefined };
      const values = r.data?.values ?? [];
      for (const v of values) if (projectKey(v.key)) keys.push(v.key);
      start += values.length;
      if (r.data?.isLast !== false || !values.length) return { ok: true, data: { keys, truncated: false } };
    }
    return { ok: true, data: { keys, truncated: true } };
  });
}

// ---------------------------------------------------------------------------
// reading cards
// ---------------------------------------------------------------------------

/*
 * One card, a person's list and a text search, all as `ProviderTask`s.
 *
 * Generic on purpose. The REST generation comes from the connection (`api`, 3
 * on Cloud, 2 on Data Center) and the two differ in exactly three places this
 * file has to know: a person is `accountId` on Cloud and `key`/`name` on Data
 * Center; the priority list is paged on Cloud and one array on Data Center; and
 * search is `POST /search/jql` paged by `nextPageToken` on Cloud but
 * `POST /search` paged by `startAt` on Data Center. Nothing a team configures
 * is named here: a status is read by its category, a priority by its position
 * in the site's own list, a project key from the site's own project list.
 *
 * Search reads no `total`: Cloud does not send one, and a page count taken from
 * a field one generation has and the other lacks is how the two drift apart.
 */

const apiOf = (c: JiraCreds): 2 | 3 => (c.api === 2 ? 2 : 3);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const idText = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** Asked by name, so a site with hundreds of custom fields does not send them. */
const CARD_FIELDS = ["summary", "status", "assignee", "priority", "duedate", "labels", "project", "updated", "created"];
const SEARCH_PAGE = 50;
const SEARCH_PAGES = 3;
/** A bare number is tried against each project in turn; past this many it is ambiguous enough to refuse. */
const BARE_PROJECTS = 8;
/** Projects named in a text search's restriction. */
const TEXT_PROJECTS = 100;
const PRIORITY_PAGES = 4;

/** Jira's status category colour names, as a fixed map; a name not here is no colour. */
const CATEGORY_COLOR: Record<string, string> = {
  "blue-gray": "#42526e", "medium-gray": "#97a0af", green: "#36b37e", yellow: "#ffab00", brown: "#8b572a", "warm-red": "#de350b",
};

/** Site priorities, most urgent first. */
export interface JiraPriorities { ids: string[]; names: string[] }

/**
 * The site's priorities in the order it ranks them. Cloud's `/priority` is
 * deprecated, so `/priority/search` is used; Data Center has only `/priority`.
 * Unverified against a live site: that `/priority/search` returns the rank
 * order (the fake does, and the classic endpoint did).
 */
export function priorities(creds: JiraCreds): Promise<JiraResult<JiraPriorities>> {
  return memoOk<JiraPriorities>(creds, "priorities", async () => {
    const all: unknown[] = [];
    if (apiOf(creds) === 2) {
      const r = await jiraCall<unknown[]>(creds, "/rest/api/2/priority");
      if (!r.ok) return { ...r, data: undefined };
      if (Array.isArray(r.data)) all.push(...r.data);
    } else {
      let start = 0;
      for (let page = 0; page < PRIORITY_PAGES; page++) {
        const r = await jiraCall<{ values?: unknown[]; isLast?: boolean }>(creds, `/rest/api/3/priority/search?startAt=${start}&maxResults=50`);
        if (!r.ok) return { ...r, data: undefined };
        const values = Array.isArray(r.data?.values) ? r.data!.values! : [];
        all.push(...values);
        start += values.length;
        if (r.data?.isLast !== false || !values.length) break;
      }
    }
    const rows = all.filter(isObj).map((p) => ({ id: idText(p.id), name: str(p.name) })).filter((p) => p.id);
    return { ok: true, data: { ids: rows.map((p) => p.id), names: rows.map((p) => p.name) } };
  });
}

/**
 * A priority by where it sits in the site's own list, not by its name: names
 * are whatever a team called them. First is urgent, last is low, and what is
 * near the top is high. One priority, or none that matches, is `normal`/null.
 */
export function priorityRank(p: unknown, list: JiraPriorities | null): ProviderTask["priority"] {
  if (!list || !isObj(p)) return null;
  const n = list.ids.length;
  let i = list.ids.indexOf(idText(p.id));
  if (i < 0 && str(p.name)) i = list.names.indexOf(str(p.name));
  if (i < 0) return null;
  if (n === 1) return "normal";
  const f = i / (n - 1);
  return f === 0 ? "urgent" : f < 0.4 ? "high" : f >= 0.7 ? "low" : "normal";
}

const initialsOf = (name: string): string =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => Array.from(w)[0]!.toUpperCase()).join("") || "?";

/** Jira writes `2026-01-13T09:00:00.000+0000`; anything unreadable is 0, not NaN. */
const epoch = (v: unknown): number => { const t = Date.parse(str(v)); return Number.isFinite(t) ? t : 0; };

export interface TaskContext {
  /** The connection's site, for the card's address. */
  site: string;
  priorities: JiraPriorities | null;
  /** The connected account's id, to mark the card as yours. */
  me?: string;
}

/** One issue as the panel's task. Null when it is not an issue at all. */
export function toTask(issue: unknown, cx: TaskContext): ProviderTask | null {
  if (!isObj(issue)) return null;
  const key = str(issue.key);
  if (!key) return null;
  const f = isObj(issue.fields) ? issue.fields : {};
  const status = isObj(f.status) ? f.status : {};
  const cat = isObj(status.statusCategory) ? status.statusCategory : {};
  const catKey = str(cat.key);
  const project = isObj(f.project) ? f.project : {};
  const who = isObj(f.assignee) ? f.assignee : null;
  // Cloud names a person by accountId; Data Center by key, then name. The same
  // order `whoAmI` stores, so "is this me" compares like with like.
  const whoId = who ? str(who.accountId) || str(who.key) || str(who.name) : "";
  const whoName = who ? str(who.displayName) || str(who.name) || whoId : "";
  const avatars = who && isObj(who.avatarUrls) ? str(who.avatarUrls["48x48"]) : "";
  const created = epoch(f.created);
  const due = /^\d{4}-\d{2}-\d{2}/.exec(str(f.duedate))?.[0] ?? null;
  const task: ProviderTask = {
    id: idText(issue.id) || key,
    customId: key,
    title: str(f.summary),
    url: `https://${cx.site}/browse/${encodeURIComponent(key)}`,
    status: str(status.name),
    statusKind: catKey === "done" ? "done" : catKey === "new" || catKey === "indeterminate" ? "open" : "other",
    statusColor: CATEGORY_COLOR[str(cat.colorName)],
    priority: priorityRank(f.priority, cx.priorities),
    due,
    updated: epoch(f.updated),
    tags: Array.isArray(f.labels) ? f.labels.filter((l): l is string => typeof l === "string") : [],
    list: str(project.name) || null,
    listId: str(project.key) || undefined,
    assignees: whoName ? [whoName] : [],
    people: who && whoId
      ? [{ key: whoId, name: whoName, initials: initialsOf(whoName), ...(avatars.startsWith("https://") ? { avatar: avatars } : {}), ...(cx.me && cx.me === whoId ? { me: true } : {}) }]
      : [],
    mine: !!(cx.me && whoId && cx.me === whoId),
  };
  if (created) task.created = created;
  return task;
}

const taskContext = async (creds: JiraCreds): Promise<TaskContext> => {
  // Best effort: a priority list that cannot be read costs the priority chip,
  // never the card.
  const p = await priorities(creds);
  return { site: creds.site, priorities: p.ok && p.data ? p.data : null, me: redacted("jira")?.accountId };
};

/** One card by its key or its numeric id. One request, plus the priority list when it is not remembered. */
export async function readIssue(creds: JiraCreds, ref: string): Promise<JiraResult<ProviderTask>> {
  if (!/^(?:\d{1,19}|[A-Za-z][A-Za-z0-9_]*-\d+)$/.test(ref)) return { ok: false, error: "That is not a Jira card id" };
  const [r, cx] = await Promise.all([
    jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/issue/${encodeURIComponent(ref)}?fields=${CARD_FIELDS.join(",")}`),
    taskContext(creds),
  ]);
  if (!r.ok) return { ...r, data: undefined };
  const task = toTask(r.data, cx);
  return task ? { ok: true, data: task } : { ok: false, error: "Jira answered with something that is not a card" };
}

export interface FoundIssue { task: ProviderTask; asked: string }

/**
 * A card from what a person typed: `ORBIT-1042` (any case), or a bare number,
 * which is tried as `<key>-<number>` against each of the site's own projects,
 * one `GET /issue` each in the site's order and the first card found wins. No
 * search is used, so there is no index to lag. With more than a few projects a
 * bare number is refused rather than turned into a request per project.
 * Ceiling: the same number in two projects resolves to the first one.
 */
export async function findIssue(creds: JiraCreds, q: string): Promise<JiraResult<FoundIssue>> {
  const t = (q || "").trim();
  if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(t)) {
    const asked = t.toUpperCase();
    const r = await readIssue(creds, asked);
    return r.ok && r.data ? { ok: true, data: { task: r.data, asked } } : { ...r, data: undefined };
  }
  if (!/^\d{3,}$/.test(t)) return { ok: false, error: "That is not a Jira card id. It looks like ORBIT-1042" };
  const p = await projects(creds);
  if (!p.ok || !p.data) return { ...p, data: undefined };
  const keys = p.data.keys;
  if (!keys.length) return { ok: false, error: "Jira shows no projects to look in" };
  if (keys.length > BARE_PROJECTS || p.data.truncated) return { ok: false, error: `Type the project key too, like ${keys[0]}-${t}` };
  for (const k of keys) {
    const asked = `${k}-${t}`;
    const r = await readIssue(creds, asked);
    if (r.ok && r.data) return { ok: true, data: { task: r.data, asked } };
    // Only "no such card here" moves on; a refusal or an outage is the answer.
    if (r.status !== 404) return { ...r, data: undefined };
  }
  return { ok: false, error: `No card ${t} in ${keys.join(", ")}` };
}

/** True when the query says something before any `order by`. Jira rejects the rest, and so do we. */
export function boundedJql(jql: string): boolean {
  const order = /(^|\s)order\s+by\s/i.exec(jql);
  return (order ? jql.slice(0, order.index) : jql).trim().length > 0;
}

export interface JiraTasks { tasks: ProviderTask[]; truncated: boolean }

/**
 * The only caller of the search endpoints. It refuses a query that is not
 * bounded before sending it, follows the pages up to a cap and says when the
 * cap cut the list short. A page that fails is the answer: a search that lost
 * its second page never reads as a short list.
 */
export async function searchJql(creds: JiraCreds, jql: string, o: { pages?: number } = {}): Promise<JiraResult<JiraTasks>> {
  if (!boundedJql(jql)) return { ok: false, error: "Refusing to search Jira without a restriction" };
  const pages = Math.max(1, o.pages ?? SEARCH_PAGES);
  const cx = taskContext(creds);
  const tasks: ProviderTask[] = [];
  const keep = async (issues: unknown): Promise<void> => {
    const c = await cx;
    for (const i of Array.isArray(issues) ? issues : []) { const t = toTask(i, c); if (t) tasks.push(t); }
  };

  if (apiOf(creds) === 2) {
    // Data Center: `startAt`. A short page, or an empty one, is the last.
    let start = 0;
    for (let page = 0; page < pages; page++) {
      const r = await jiraCall<{ issues?: unknown[]; maxResults?: number }>(creds, "/rest/api/2/search",
        { method: "POST", body: { jql, fields: CARD_FIELDS, maxResults: SEARCH_PAGE, startAt: start } });
      if (!r.ok) return { ...r, data: undefined };
      const issues = Array.isArray(r.data?.issues) ? r.data!.issues! : [];
      await keep(issues);
      start += issues.length;
      // The server may cap a page below what was asked; its own figure is the yardstick.
      const asked = typeof r.data?.maxResults === "number" && r.data.maxResults > 0 ? Math.min(r.data.maxResults, SEARCH_PAGE) : SEARCH_PAGE;
      if (issues.length < asked) return { ok: true, data: { tasks, truncated: false } };
    }
    return { ok: true, data: { tasks, truncated: true } };
  }

  // Cloud: `nextPageToken` until `isLast`.
  let token: string | undefined;
  for (let page = 0; page < pages; page++) {
    const r = await jiraCall<{ issues?: unknown[]; isLast?: boolean; nextPageToken?: string }>(creds, "/rest/api/3/search/jql",
      { method: "POST", body: { jql, fields: CARD_FIELDS, maxResults: SEARCH_PAGE, ...(token ? { nextPageToken: token } : {}) } });
    if (!r.ok) return { ...r, data: undefined };
    await keep(r.data?.issues);
    token = typeof r.data?.nextPageToken === "string" && r.data.nextPageToken ? r.data.nextPageToken : undefined;
    if (r.data?.isLast === true || !token) return { ok: true, data: { tasks, truncated: false } };
  }
  return { ok: true, data: { tasks, truncated: true } };
}

/** What is on you and not done, newest change first. Bounded by the assignee. */
export const MINE_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

export const mine = (creds: JiraCreds): Promise<JiraResult<JiraTasks>> => searchJql(creds, MINE_JQL);

/** Text goes inside a quoted phrase; the characters that end one, or that the text index reads as operators, become spaces. */
const searchPhrase = (raw: string): string =>
  raw.replace(/[\u0000-\u001f\u007f+&|!(){}[\]^~*?:/\\"]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);

/**
 * Words in the title, description or comments, inside the projects this person
 * can see. The restriction is the site's own project list, so it needs no
 * guess about what the keys look like; with more projects than fit in a query
 * the first ones are searched and the answer is marked `truncated`.
 */
export async function searchText(creds: JiraCreds, q: string): Promise<JiraResult<JiraTasks>> {
  const phrase = searchPhrase(q);
  if (!phrase) return { ok: false, error: "Type something to search for" };
  const p = await projects(creds);
  if (!p.ok || !p.data) return { ...p, data: undefined };
  if (!p.data.keys.length) return { ok: false, error: "Jira shows no projects to search" };
  const keys = p.data.keys.slice(0, TEXT_PROJECTS);
  const r = await searchJql(creds, `project in (${keys.map((k) => `"${k}"`).join(", ")}) AND text ~ "${phrase}" ORDER BY updated DESC`);
  if (!r.ok || !r.data) return r;
  return { ok: true, data: { tasks: r.data.tasks, truncated: r.data.truncated || p.data.truncated || p.data.keys.length > TEXT_PROJECTS } };
}

// What the routes call: the stored connection, or the sentence that says there is none.
const NOT_CONNECTED = "Jira is not connected";
export async function withStored<T>(run: (c: JiraCreds) => Promise<JiraResult<T>>): Promise<JiraResult<T>> {
  const c = storedCreds();
  return c ? run(c) : { ok: false, error: NOT_CONNECTED };
}

// ---------------------------------------------------------------------------
// connect, status, disconnect
// ---------------------------------------------------------------------------

const MAX_TOKEN = 2048;
const EMAIL = /^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/;
/** On a custom host the "email" may be a plain username. */
const USERNAME = /^[^\s:\u0000-\u001f\u007f]{1,254}$/;

export interface JiraConnectInput { email?: unknown; site?: unknown; token?: unknown; auth?: unknown }

/**
 * Store a Jira connection, but only one Jira has already accepted.
 *
 * The order is the point, as for the other token providers: judge the site and
 * the inputs (no network), ask which Jira this is, ask `/myself` with the
 * candidate credentials, and write only on success. The answer carries the
 * account's display name and never the token, the email or the site's raw text.
 *
 * `auth` is `basic` (an email or username and a token) or `bearer` (a personal
 * access token alone). Left out, it is `basic` when an email was given and
 * `bearer` when not. Jira Cloud only signs in with `basic`.
 */
export async function connectJira(input: JiraConnectInput): Promise<JiraConnectResult> {
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const token = typeof input.token === "string" ? input.token.trim() : "";
  const site = parseSite(input.site);
  if (!site.ok) return { ok: false, error: site.error };
  const auth: JiraAuth | null = input.auth === "basic" || input.auth === "bearer" ? input.auth
    : input.auth === undefined || input.auth === "" ? (email ? "basic" : "bearer") : null;
  if (!auth) return { ok: false, error: "Sign in with basic (email and token) or bearer (a personal access token)" };
  if (auth === "bearer" && site.kind === "cloud") return { ok: false, error: "Jira Cloud signs in with your email and an API token" };
  if (auth === "basic") {
    if (!email) return { ok: false, error: "Type the email you sign in to Jira with" };
    if (email.length > 254 || !(site.kind === "cloud" ? EMAIL : USERNAME).test(email)) {
      return { ok: false, error: site.kind === "cloud" ? "That does not look like an email address" : "That does not look like a username" };
    }
  }
  if (!token) return { ok: false, error: "Paste a token first" };
  if (token.length > MAX_TOKEN || /[\s\u0000-\u001f\u007f]/.test(token)) return { ok: false, error: "That does not look like a token" };

  const creds: JiraCreds = { site: site.site, token, auth, email: auth === "basic" ? email : undefined };
  const server = await detectServer(creds);
  if (!server.ok || !server.data) return { ok: false, error: server.error ?? "Could not reach Jira" };
  creds.api = server.data.api;
  const me = await whoAmI(creds);
  if (!me.ok || !me.data) return { ok: false, error: me.error ?? "Could not reach Jira" };
  setCredential("jira", {
    token, email: creds.email, auth, site: site.site, api: server.data.api, deployment: server.data.deployment,
    account: me.data.name, accountId: me.data.accountId, verifiedAt: Date.now(),
  });
  // A hold or a memo from the previous credential says nothing about this one.
  forgetJira();
  return { ok: true, account: me.data.name };
}

/** What the card UI needs to know about the connection. No secret, no email. */
export async function jiraStatus(): Promise<JiraStatus> {
  const creds = storedCreds();
  const known = redacted("jira");
  const off = { connected: false, site: null, kind: null, auth: null, api: null, deployment: null, account: null, prefixes: [], writes: jiraWriteEnabled() };
  if (!creds) return off;
  const parsed = parseSite(creds.site);
  // Optional: a status read must not queue behind, or add to, a rate limit.
  const p = await projects(creds, { optional: true });
  return {
    connected: true,
    site: creds.site,
    kind: parsed.ok ? parsed.kind : null,
    auth: creds.auth,
    api: creds.api ?? 3,
    deployment: known?.deployment ?? null,
    account: known?.account ?? null,
    prefixes: p.ok && p.data ? p.data.keys : [],
    writes: jiraWriteEnabled(),
  };
}

export function disconnectJira(): void {
  clearCredential("jira");
  forgetJira();
}

// ---------------------------------------------------------------------------
// writes are off unless switched on
// ---------------------------------------------------------------------------

const SETTINGS = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass", "jira-settings.json");
let settingsOverride: string | null = null;
/** Test seam, so a suite never reads or writes the developer's own settings. */
export function __setJiraSettingsPath(p: string | null): void { settingsOverride = p; }
const settingsPath = (): string => settingsOverride ?? SETTINGS;

function storedWrites(): boolean {
  try {
    const p = settingsPath();
    return existsSync(p) && (JSON.parse(readFileSync(p, "utf8")) as { writes?: unknown }).writes === true;
  } catch { return false; }
}

/**
 * Changing a card on a shared site fires automations and notifies people, so
 * the default is read-only and turning it on is a deliberate act: the
 * environment variable for a headless run, or the stored toggle from the app.
 * Nothing in this slice writes to Jira; the switch exists so the slices that do
 * have one gate to ask.
 */
export function jiraWriteEnabled(): boolean {
  return process.env.AGENTGLASS_JIRA_WRITE === "1" || storedWrites();
}

export function setJiraWrites(on: boolean): void {
  const p = settingsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ writes: on }, null, 2) + "\n");
}
