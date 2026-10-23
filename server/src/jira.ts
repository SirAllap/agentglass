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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { guardedFetch, privateAddress, type GuardedFetchOptions } from "./net.ts";
import { isIP } from "node:net";
import { forgetCached } from "./jiraviews.ts";
import { cardExtras } from "./jirafields.ts";
import { webLinksOf } from "./jiraCardRead.ts";
import type { CardWebLink } from "../../shared/providers.ts";
import { clearCredential, redacted, secretFor, setCredential } from "./credentials.ts";
import type { CallResult, WriteOutcome } from "./trackerTypes.ts";
import { prAddress } from "../../shared/taskref.ts";
import { moveBody, screenOf } from "./jiraMoveFields.ts";
import type {
  JiraAuth, JiraBlockOutcome, JiraConnectResult, JiraDeployment, JiraHandoffRule, JiraKind, JiraMove, JiraMoves, JiraPerson, JiraSettings, JiraStatus, ProviderTask,
} from "../../shared/providers.ts";
import { hasUrlCredentials } from "../../shared/urlCredentials.ts";

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
  if (hasUrlCredentials(u) || u.search || u.hash) return bad;
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
export function storedCreds(): JiraCreds | null {
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
/** Bumps whenever everything remembered is forgotten; a held answer from before it is stale. */
export const jiraGeneration = (): number => generation;
const flying = new Map<string, Promise<JiraResult<unknown>>>();
const memo = new Map<string, { at: number; r: CallResult<any> }>();

/** Everything remembered about the connection: after a disconnect, or a new base. */
export function forgetJira(): void {
  generation++;
  flying.clear();
  memo.clear();
  misses.clear();
  mineHeld.clear();
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
  method?: "GET" | "POST" | "PUT" | "DELETE";
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

/** How long a failed lookup is not asked again, where a caller says it may be remembered. */
const MISS_TTL_MS = 2 * 60_000;
const misses = new Map<string, { at: number; r: CallResult<unknown> }>();
const memoKey = (creds: JiraCreds, key: string): string => `${baseOverride ?? ""}|${fingerprintOf(creds)}|${key}`;

/** Is there a live answer (good, or a remembered failure) for this key, so asking would cost nothing? */
export function memoHas(creds: JiraCreds, key: string): boolean {
  const k = memoKey(creds, key);
  const hit = memo.get(k);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return true;
  const miss = misses.get(k);
  return !!miss && Date.now() - miss.at < MISS_TTL_MS;
}

/**
 * Answers that hold still, asked once per ten minutes. A success is kept. A
 * failure is kept for two minutes only when the caller says so (`remember`),
 * for lookups made on every read of a view: a board that is gone or forbidden
 * would otherwise be asked again on every focus and every tick.
 */
export async function memoOk<T>(
  creds: JiraCreds,
  key: string,
  run: () => Promise<CallResult<T>>,
  remember = false,
): Promise<CallResult<T>> {
  const k = memoKey(creds, key);
  const hit = memo.get(k);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.r;
  const miss = remember ? misses.get(k) : undefined;
  if (miss && Date.now() - miss.at < MISS_TTL_MS) return miss.r as CallResult<T>;
  const gen = generation;
  const r = await run();
  // A disconnect while this was in the air: do not write it back.
  if (gen === generation) {
    if (r.ok) { memo.set(k, { at: Date.now(), r }); misses.delete(k); }
    else if (remember) misses.set(k, { at: Date.now(), r });
  }
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

export interface JiraProjects {
  keys: string[];
  truncated: boolean;
  /** Key to name, from the same responses. Optional so a caller that never needs a name is unchanged. */
  names?: Record<string, string>;
}

export const projectKey = (v: unknown): v is string => typeof v === "string" && /^[A-Z][A-Z0-9_]*$/.test(v);

/** The project keys this person can see, for telling a card id from a word. */
export function projects(creds: JiraCreds, o: { optional?: boolean } = {}): Promise<JiraResult<JiraProjects>> {
  return memoOk<JiraProjects>(creds, "projects", async () => {
    if (creds.api === 2) {
      const r = await jiraCall<{ key?: unknown; name?: unknown }[]>(creds, "/rest/api/2/project", { optional: o.optional });
      if (!r.ok) return { ...r, data: undefined };
      const all = (Array.isArray(r.data) ? r.data : []).slice(0, PROJECTS_UNPAGED);
      const names: Record<string, string> = {};
      for (const v of all) if (projectKey(v?.key)) names[v.key] = str(v.name) || v.key;
      return { ok: true, data: { keys: all.map((v) => v?.key).filter(projectKey), truncated: (Array.isArray(r.data) ? r.data.length : 0) > PROJECTS_UNPAGED, names } };
    }
    const keys: string[] = [];
    const names: Record<string, string> = {};
    let start = 0;
    for (let page = 0; page < PROJECT_PAGES; page++) {
      const r = await jiraCall<{ values?: { key?: unknown; name?: unknown }[]; isLast?: boolean }>(
        creds, `/rest/api/3/project/search?startAt=${start}&maxResults=${PROJECT_PAGE}`, { optional: o.optional });
      if (!r.ok) return { ...r, data: undefined };
      const values = r.data?.values ?? [];
      for (const v of values) if (projectKey(v.key)) { keys.push(v.key); names[v.key] = str(v.name) || v.key; }
      start += values.length;
      if (r.data?.isLast !== false || !values.length) return { ok: true, data: { keys, truncated: false, names } };
    }
    return { ok: true, data: { keys, truncated: true, names } };
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

export const apiOf = (c: JiraCreds): 2 | 3 => (c.api === 2 ? 2 : 3);
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === "string" ? v : "");
export const idText = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** Asked by name, so a site with hundreds of custom fields does not send them. */
export const CARD_FIELDS = ["summary", "status", "assignee", "priority", "duedate", "labels", "project", "updated", "created"];
const SEARCH_PAGE = 50;
const SEARCH_PAGES = 3;
/** A bare number is tried against each project in turn; past this many it is ambiguous enough to refuse. */
const BARE_PROJECTS = 8;
/** Projects named in a text search's restriction. */
const TEXT_PROJECTS = 100;
const PRIORITY_PAGES = 4;

/** Jira's status category colour names, as a fixed map; a name not here is no colour. */
export const CATEGORY_COLOR: Record<string, string> = {
  "blue-gray": "#42526e", "medium-gray": "#97a0af", green: "#36b37e", yellow: "#ffab00", brown: "#8b572a", "warm-red": "#de350b",
};

/**
 * Whether a board's search asks for `comment`, which makes every card carry
 * its comments for the sake of one number. Measured on 100 cards with 30
 * comments each: see the commit that added it. Off, the count comes from the
 * card's own read.
 */
let searchComments = false;
/** Test seam: the one constant, so both of its branches run. */
export const __setSearchComments = (on: boolean): void => { searchComments = on; };

/** The site's own ids for the fields a board shows, found by what they are, never by what they are called. */
export interface JiraFieldIds {
  sprint?: string; points: string[];
  /** The Details a card read shows when the site has them: start date, the flag and the team. */
  start?: string; flag?: string; team?: string;
}

/**
 * Which points field a card's number is read from. A board names the one it counts in; a view that does not takes the
 * site's first. A card read cannot know which board it was opened from, so with several fields to choose from it asks
 * for none rather than put a second field's number over the board's.
 */
export function pointsField(ids: JiraFieldIds | null, stated?: string): string | undefined {
  if (stated && CUSTOM_ID.test(stated)) return stated;
  if (!ids) return undefined;
  return ids.points[0];
}
export function cardPointsField(ids: JiraFieldIds | null): string | undefined {
  return ids && ids.points.length === 1 ? pointsField(ids) : undefined;
}

const CUSTOM_ID = /^customfield_\d{1,9}$/;

/**
 * `GET /field`, once per ten minutes and again after a reconnect. The sprint is
 * the field of the sprint type; story points are the fields of the points type,
 * in the site's order, because a site may carry two and a board names which it
 * counts in. Data Center's points field has no type of its own (a plain number
 * called Story Points), so a number field by that name is taken when no field
 * has the type: the one name this file relies on, and the one a rename breaks.
 */
export function siteFields(creds: JiraCreds): Promise<JiraResult<JiraFieldIds>> {
  return memoOk<JiraFieldIds>(creds, "fields", async () => {
    const r = await jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/field`);
    if (!r.ok) return { ...r, data: undefined };
    const rows = (Array.isArray(r.data) ? r.data : []).filter(isObj).filter((f) => CUSTOM_ID.test(str(f.id)));
    const custom = (f: Record<string, unknown>) => (isObj(f.schema) ? str(f.schema.custom) : "");
    const byType = rows.filter((f) => custom(f).endsWith(":jsw-story-points"));
    const points = byType.length ? byType : rows.filter((f) => /^story points?$/i.test(str(f.name)) && isObj(f.schema) && str(f.schema.type) === "number");
    const named = (re: RegExp, type: string) => rows.find((f) => re.test(str(f.name)) && isObj(f.schema) && str(f.schema.type) === type)?.id as string | undefined;
    return { ok: true, data: {
      sprint: rows.find((f) => custom(f).endsWith(":gh-sprint"))?.id as string | undefined,
      points: points.map((f) => str(f.id)),
      // Found by what they are where a type says so (the team); the start date and the flag have no type of their own, so by the name Jira gives them.
      start: named(/^start date$/i, "date"),
      flag: named(/^flagged$/i, "array"),
      team: rows.find((f) => custom(f).endsWith(":atlassian-team"))?.id as string | undefined,
    } };
  }, true);
}

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
export const epoch = (v: unknown): number => { const t = Date.parse(str(v)); return Number.isFinite(t) ? t : 0; };

export interface TaskContext {
  /** The connection's site, for the card's address. */
  site: string;
  priorities: JiraPriorities | null;
  /** The connected account's id, to mark the card as yours. */
  me?: string;
  /** Where a board's fields live on this site; absent for a read that did not ask. */
  fields?: { sprint?: string; points?: string; flag?: string };
}

/** One issue as the panel's task. Null when it is not an issue at all. */
export function toTask(issue: unknown, cx: TaskContext, arrival?: number): ProviderTask | null {
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
    // A board column holds status ids; two statuses may share a name.
    ...(idText(status.id) ? { statusId: idText(status.id) } : {}),
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
  if (isObj(f.issuetype) && str(f.issuetype.name)) task.issueType = str(f.issuetype.name);
  Object.assign(task, cardExtras(f, cx.fields));
  if (arrival !== undefined) task.order = String(arrival).padStart(6, "0");
  return task;
}

export const taskContext = async (creds: JiraCreds): Promise<TaskContext> => {
  // Best effort: a priority list that cannot be read costs the priority chip,
  // never the card.
  const p = await priorities(creds);
  return { site: creds.site, priorities: p.ok && p.data ? p.data : null, me: redacted("jira")?.accountId };
};

/** One card by its key or its numeric id. One request, plus the priority list when it is not remembered. */
export async function readIssue(creds: JiraCreds, ref: string, o: { fresh?: boolean } = {}): Promise<JiraResult<ProviderTask>> {
  if (!/^(?:\d{1,19}|[A-Za-z][A-Za-z0-9_]*-\d+)$/.test(ref)) return { ok: false, error: "That is not a Jira card id" };
  const [r, cx] = await Promise.all([
    jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/issue/${encodeURIComponent(ref)}?fields=${CARD_FIELDS.join(",")}`, { fresh: o.fresh }),
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

/**
 * Where the `order by` clause starts, or -1. Text inside "..." and '...' (with
 * backslash escapes) is skipped: a filter `summary ~ "sort order by date"` has
 * no order clause, and cutting it there sent Jira half a quoted string.
 */
export function orderByAt(jql: string): number {
  let masked = "";
  let q = "";
  for (let i = 0; i < jql.length; i++) {
    const c = jql[i];
    if (q) {
      if (c === "\\") { masked += "xx"; i++; continue; }
      if (c === q) q = "";
      masked += "x";
    } else {
      if (c === '"' || c === "'") q = c;
      masked += c;
    }
  }
  // An escape at the very end adds one char past the input; the index is still before it.
  return /(^|\s)order\s+by\s/i.exec(masked)?.index ?? -1;
}

/** True when the query says something before any `order by`. Jira rejects the rest, and so do we. */
export function boundedJql(jql: string): boolean {
  const at = orderByAt(jql);
  return (at >= 0 ? jql.slice(0, at) : jql).trim().length > 0;
}

/** A status as a card wore it, with its category and the projects whose cards wore it. */
export interface SeenStatus { id: string; name: string; category: string; color: string; projects: string[] }

export interface JiraTasks {
  tasks: ProviderTask[];
  truncated: boolean;
  /** Only a board read (`o.board`) fills it: the statuses the cards wore, in the order first met. */
  seen?: SeenStatus[];
}

/** What a view read asks for beyond a card list. `points` is the field the board counts in, when it names one. */
export interface BoardAsk { points?: string }

/**
 * The only caller of the search endpoints. It refuses a query that is not
 * bounded before sending it, follows the pages up to a cap and says when the
 * cap cut the list short. A page that fails is the answer: a search that lost
 * its second page never reads as a short list.
 */
export async function searchJql(creds: JiraCreds, jql: string, o: { pages?: number; optional?: boolean; light?: boolean; board?: BoardAsk } = {}): Promise<JiraResult<JiraTasks>> {
  if (!boundedJql(jql)) return { ok: false, error: "Refusing to search Jira without a restriction" };
  const pages = Math.max(1, o.pages ?? SEARCH_PAGES);
  // `light`: a caller that never shows a priority does not pay for the list.
  const base = o.light ? Promise.resolve<TaskContext>({ site: creds.site, priorities: null, me: redacted("jira")?.accountId }) : taskContext(creds);
  // A board read adds the site's own fields. Where they cannot be read the cards come without them, never fail for them.
  let fields = CARD_FIELDS;
  let ask: TaskContext["fields"];
  if (o.board) {
    const found = await siteFields(creds);
    const ids = found.ok && found.data ? found.data : null;
    const sprint = ids?.sprint;
    const points = pointsField(ids, o.board.points);
    // The kind, the parent and the flag are three more fields in the one search, never a request each.
    const flag = ids?.flag;
    fields = [...CARD_FIELDS, ...(sprint ? [sprint] : []), ...(points ? [points] : []), ...(flag ? [flag] : []), "issuetype", "parent", "issuelinks", "subtasks", ...(searchComments ? ["comment"] : [])];
    ask = { sprint, points, flag };
  }
  const cx = base.then((c): TaskContext => (ask ? { ...c, fields: ask } : c));
  // The order a rank-ordered search arrives in is the board's order; the card carries it across pages.
  const at = orderByAt(jql);
  const ranked = o.board !== undefined && at >= 0 && /^order\s+by\s+rank\b/i.test(jql.slice(at).trim());
  const tasks: ProviderTask[] = [];
  const seen = new Map<string, SeenStatus>();
  const keep = async (issues: unknown): Promise<void> => {
    const c = await cx;
    for (const i of Array.isArray(issues) ? issues : []) {
      const t = toTask(i, c, ranked ? tasks.length : undefined);
      if (!t) continue;
      tasks.push(t);
      if (o.board && t.statusId) {
        const st = isObj(i) && isObj(i.fields) && isObj(i.fields.status) ? i.fields.status : {};
        const cat = isObj(st.statusCategory) ? st.statusCategory : {};
        const hit = seen.get(t.statusId) ?? { id: t.statusId, name: t.status, category: str(cat.key), color: str(cat.colorName), projects: [] };
        if (t.listId && !hit.projects.includes(t.listId)) hit.projects.push(t.listId);
        seen.set(t.statusId, hit);
      }
    }
  };
  const done = (truncated: boolean): JiraResult<JiraTasks> => ({ ok: true, data: { tasks, truncated, ...(o.board ? { seen: [...seen.values()] } : null) } });

  if (apiOf(creds) === 2) {
    // Data Center: `startAt`. A short page, or an empty one, is the last.
    let start = 0;
    for (let page = 0; page < pages; page++) {
      const r = await jiraCall<{ issues?: unknown[]; maxResults?: number }>(creds, "/rest/api/2/search",
        { method: "POST", optional: o.optional, body: { jql, fields, maxResults: SEARCH_PAGE, startAt: start } });
      if (!r.ok) return { ...r, data: undefined };
      const issues = Array.isArray(r.data?.issues) ? r.data!.issues! : [];
      await keep(issues);
      start += issues.length;
      // The server may cap a page below what was asked; its own figure is the yardstick.
      const asked = typeof r.data?.maxResults === "number" && r.data.maxResults > 0 ? Math.min(r.data.maxResults, SEARCH_PAGE) : SEARCH_PAGE;
      if (issues.length < asked) return done(false);
    }
    return done(true);
  }

  // Cloud: `nextPageToken` until `isLast`.
  let token: string | undefined;
  for (let page = 0; page < pages; page++) {
    const r = await jiraCall<{ issues?: unknown[]; isLast?: boolean; nextPageToken?: string }>(creds, "/rest/api/3/search/jql",
      { method: "POST", optional: o.optional, body: { jql, fields, maxResults: SEARCH_PAGE, ...(token ? { nextPageToken: token } : {}) } });
    if (!r.ok) return { ...r, data: undefined };
    await keep(r.data?.issues);
    token = typeof r.data?.nextPageToken === "string" && r.data.nextPageToken ? r.data.nextPageToken : undefined;
    if (r.data?.isLast === true || !token) return done(false);
  }
  return done(true);
}

/** What is on you and not done, newest change first. Bounded by the assignee. */
export const MINE_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

/**
 * The Tasks tab asks for this on every visit and every return to the window, so
 * an answer is kept for a minute and a second ask while one is in the air joins
 * it: at most one search a minute for the site, however many windows or phones look.
 * `fresh` (the Refresh button) skips both and replaces what is kept. Only a
 * success is kept, so a failed read is never served again as if it were news.
 */
const MINE_TTL_MS = 60_000;
const mineHeld = new Map<string, { at: number; r?: JiraResult<JiraTasks>; run?: Promise<JiraResult<JiraTasks>> }>();

export function mine(creds: JiraCreds, o: { fresh?: boolean; board?: boolean } = {}): Promise<JiraResult<JiraTasks>> {
  // The board's read carries more per card; the plain one is never served in its place, nor the other way round.
  const k = `${baseOverride ?? ""}|${fingerprintOf(creds)}${o.board ? "|board" : ""}`;
  const hit = mineHeld.get(k);
  if (!o.fresh && hit) {
    if (hit.run) return hit.run;
    if (hit.r && Date.now() - hit.at < MINE_TTL_MS) return Promise.resolve(hit.r);
  }
  const gen = generation;
  const run = searchJql(creds, MINE_JQL, o.board ? { board: {} } : {}).then((r) => {
    if (gen !== generation) return r;
    const now = mineHeld.get(k);
    // A newer ask took the slot while this was in the air: leave it its own.
    if (now && now.run !== run) return r;
    if (r.ok) mineHeld.set(k, { at: Date.now(), r }); else if (now?.run === run) mineHeld.delete(k);
    return r;
  });
  mineHeld.set(k, { at: hit?.at ?? 0, r: hit?.r, run });
  return run;
}

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
  // No `key = ...` clause beside the text: Data Center rejects the whole search when the key is malformed or does not exist
  // ("utf-8", a typo), and the card lookup that runs beside this search already fetches an exact key.
  const r = await searchJql(creds, `project in (${keys.map((k) => `"${k}"`).join(", ")}) AND text ~ "${phrase}" ORDER BY updated DESC`);
  if (!r.ok || !r.data) return r;
  return { ok: true, data: { tasks: r.data.tasks, truncated: r.data.truncated || p.data.truncated || p.data.keys.length > TEXT_PROJECTS } };
}

// What the routes call: the stored connection, or the sentence that says there is none.
export const NOT_CONNECTED = "Jira is not connected";
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
  // The rows cached by the previous account were read as that account.
  forgetCached();
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
  // The last read of each view is the other person's data once the token is gone; the addresses are not.
  forgetCached();
}

// ---------------------------------------------------------------------------
// writes are off unless switched on
// ---------------------------------------------------------------------------

const SETTINGS = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass", "jira-settings.json");
let settingsOverride: string | null = null;
/** Test seam, so a suite never reads or writes the developer's own settings. */
export function __setJiraSettingsPath(p: string | null): void { settingsOverride = p; }
const settingsPath = (): string => settingsOverride ?? SETTINGS;

/** The settings file as it is on disk; unreadable is empty, never an error. */
export function readSettingsFile(): Record<string, unknown> {
  try {
    const p = settingsPath();
    if (!existsSync(p)) return {};
    const v = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return isObj(v) ? v : {};
  } catch { return {}; }
}

/** One key changed, the others kept: the write switch and the hand-off share the file. */
export function writeSettingsKey(key: string, value: unknown): void {
  const p = settingsPath();
  mkdirSync(dirname(p), { recursive: true });
  // Written aside and renamed: a half-written file would read as empty and lose every rule.
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...readSettingsFile(), [key]: value }, null, 2) + "\n");
  renameSync(tmp, p);
}

function storedWrites(): boolean {
  return readSettingsFile().writes === true;
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
  writeSettingsKey("writes", on);
}

// ---------------------------------------------------------------------------
// moving a card: one transition per click
// ---------------------------------------------------------------------------

/*
 * A card has no status to set. Its workflow offers moves (transitions) from
 * where it stands, each leading to a status, and only those can be made. The
 * names of the moves and of the statuses are the site's: nothing here knows
 * one, and "ready for review" is a setting somebody picks from this list, not
 * a word looked for in it.
 *
 * Ceiling: one move per call. Reaching a distant status through several moves
 * is not here. A move whose screen asks for a field is listed with `needs` and
 * `fields` (jiraMoveFields.ts reads them); it is made with the values the
 * person typed, and refused with no request when a required one is empty or of
 * a kind this cannot fill.
 */

export const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const FIELD_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
export const WRITE_OFF = "Writing to Jira is switched off";

/** What a workflow's `transitions` answer says, as moves. Unreadable entries are dropped, never guessed. */
export function toMoves(raw: unknown): JiraMove[] {
  const list = isObj(raw) && Array.isArray(raw.transitions) ? raw.transitions : [];
  const moves: JiraMove[] = [];
  for (const t of list) {
    if (!isObj(t) || t.isAvailable === false) continue;
    const id = idText(t.id);
    const to = isObj(t.to) ? t.to : {};
    const toStatus = str(to.name);
    if (!id || !toStatus) continue;
    const cat = isObj(to.statusCategory) ? to.statusCategory : {};
    const catKey = str(cat.key);
    // Every required field on the move's screen. A default value is no promise
    // that a move without it is accepted, so it is not an exception.
    const needs = isObj(t.fields)
      ? Object.entries(t.fields).filter(([k, v]) => isObj(v) && v.required === true && FIELD_KEY.test(k)).map(([k]) => k)
      : [];
    // The screen is carried only by a move that has to ask: the rest are made at once, as before.
    const screen = needs.length ? screenOf(t.fields) : [];
    const color = CATEGORY_COLOR[str(cat.colorName)];
    moves.push({
      id,
      name: str(t.name),
      label: toStatus,
      toStatus,
      ...(idText(to.id) ? { toId: idText(to.id) } : null),
      toKind: catKey === "done" ? "done" : catKey === "new" || catKey === "indeterminate" ? "open" : "other",
      ...(color ? { color } : null),
      ...(needs.length ? { needs } : null),
      ...(needs.length && screen.length ? { fields: screen } : null),
    });
  }
  // Two moves into one status (a quick path and a long one) must not read as one.
  const seen = new Map<string, number>();
  for (const m of moves) seen.set(m.label, (seen.get(m.label) ?? 0) + 1);
  for (const m of moves) if ((seen.get(m.label) ?? 0) > 1 && m.name) m.label = `${m.toStatus} (${m.name})`;
  return moves;
}

export const movesPath = (creds: JiraCreds, key: string): string =>
  `/rest/api/${apiOf(creds)}/issue/${encodeURIComponent(key)}/transitions?expand=transitions.fields`;

/**
 * The moves the card has now. An empty list is Jira's answer for a missing
 * permission and for a finished workflow alike, so it comes back with a
 * sentence about the person and never as "no statuses". One request, and
 * nothing is kept from it: a permission can change between two looks.
 */
export async function movesOf(creds: JiraCreds, key: string): Promise<JiraResult<JiraMoves>> {
  if (!ISSUE_KEY.test(key)) return { ok: false, error: "That is not a Jira card id" };
  const r = await jiraCall<unknown>(creds, movesPath(creds, key));
  if (!r.ok) return { ...r, data: undefined };
  const options = toMoves(r.data);
  return { ok: true, data: options.length ? { options } : { options, cannot: `You cannot move ${key.toUpperCase()}` } };
}

/** The sentence for a write Jira refused with a 400: its own words are never passed on. */
export const NOT_ACCEPTED = "Jira did not accept that move. The card may have moved on, or you cannot move it";

/**
 * Make one move, and give back the card as it is afterwards.
 *
 * In order, and each step may end it: the write switch, the inputs, a read of
 * `updated` (refused as a conflict when it is not the one the person saw), the
 * move's screen (refused with no write when a required field is empty), the
 * POST with what was typed, and a read of the card. Three requests, plus one when the site's moves for
 * this status are not remembered yet.
 *
 * The reads that bracket the write skip the in-flight merge: a read of this
 * card already in the air from before the write would be handed back as the
 * card "after" it.
 */
export async function moveIssue(creds: JiraCreds, key: string, transitionId: string, updated: number, fields?: unknown): Promise<WriteOutcome> {
  if (!jiraWriteEnabled()) return { ok: false, error: WRITE_OFF };
  if (!ISSUE_KEY.test(key)) return { ok: false, error: "That is not a Jira card id" };
  if (!/^\d{1,10}$/.test(transitionId)) return { ok: false, error: "That is not one of this card's moves" };
  // A write with nothing to compare against would go out unchecked.
  if (!Number.isFinite(updated) || updated <= 0) return { ok: false, error: "Nothing was changed: reload the card and try again" };
  const v = apiOf(creds);

  const seen = await jiraCall<unknown>(creds, `/rest/api/${v}/issue/${encodeURIComponent(key)}?fields=updated,status,project,issuetype`, { fresh: true });
  if (!seen.ok) {
    // A read that failed says nothing about whether the card moved: not a
    // conflict, and not a green light either.
    return { ok: false, unauthorised: seen.unauthorised, error: `Nothing was changed: could not check the card first. ${seen.error ?? "Jira did not answer"}` };
  }
  const f = isObj(seen.data) && isObj(seen.data.fields) ? seen.data.fields : {};
  const now = epoch(f.updated);
  if (!now) return unreadable();
  if (now !== updated) return stale();

  // Moves differ by project, issue type and status, so that is the memo's key.
  const status = isObj(f.status) ? f.status : {};
  const type = isObj(f.issuetype) ? f.issuetype : {};
  const where = `${str(isObj(f.project) ? f.project.key : "")}|${idText(type.id) || str(type.name)}|${idText(status.id) || str(status.name)}`;
  const listed = (fresh: boolean): Promise<CallResult<JiraMove[]>> => {
    const run = async (): Promise<CallResult<JiraMove[]>> => {
      const r = await jiraCall<unknown>(creds, movesPath(creds, key), { fresh: true });
      return r.ok ? { ok: true, data: toMoves(r.data) } : { ...r, data: undefined };
    };
    return fresh ? run() : memoOk(creds, `moves|${where}`, run);
  };
  // An empty list kept from an earlier look (a permission since granted) falls
  // through to the fresh read below, because it holds no such move.
  let moves = await listed(false);
  if (!moves.ok) return { ok: false, unauthorised: moves.unauthorised, error: `Nothing was changed: could not read the card's moves. ${moves.error ?? "Jira did not answer"}` };
  let move = moves.data?.find((m) => m.id === transitionId);
  if (!move) {
    // The remembered list may be older than a permission or a workflow edit.
    moves = await listed(true);
    if (!moves.ok) return { ok: false, unauthorised: moves.unauthorised, error: `Nothing was changed: could not read the card's moves. ${moves.error ?? "Jira did not answer"}` };
    if (!moves.data?.length) return { ok: false, error: `You cannot move ${key.toUpperCase()}` };
    move = moves.data.find((m) => m.id === transitionId);
    if (!move) return { ok: false, error: "That move is not available any more: reload the card" };
  }
  // A required field with nothing in it, or one this cannot fill, ends it here: no write.
  // A move whose screen could not be read as fields keeps the old refusal.
  if (move.needs?.length && !move.fields?.length) {
    return { ok: false, error: `That move needs ${move.needs.join(", ")}, which cannot be filled in here yet` };
  }
  const built = moveBody(transitionId, move.fields, fields, v);
  if (!built.ok) return { ok: false, error: built.error };

  const post = await jiraCall<unknown>(creds, `/rest/api/${v}/issue/${encodeURIComponent(key)}/transitions`, {
    method: "POST",
    body: built.body,
  });
  if (!post.ok) {
    if (post.status === 409) return { ok: false, conflict: true, error: "Somebody changed this card while you were moving it, reloaded" };
    if (post.status === 400) return { ok: false, error: NOT_ACCEPTED };
    return { ok: false, unauthorised: post.unauthorised, error: post.error };
  }
  // Read back, never assumed: a workflow can run its own steps on the way in.
  const back = await readIssue(creds, key, { fresh: true });
  if (!back.ok || !back.data) return { ok: false, error: `The card was moved, but could not be read back. Reload it. ${back.error ?? ""}`.trim() };
  return { ok: true, task: back.data, was: str(status.name) };
}

// ---------------------------------------------------------------------------
// remote links: the pull requests a card is linked to on the site
// ---------------------------------------------------------------------------

/** One remote link that is a pull request. `title` and `resolved` are as the link was written, never refreshed. */
export interface JiraPrLink { url: string; number: number; title: string; resolved: boolean }

function remoteLinksPath(creds: JiraCreds, key: string): string {
  return `/rest/api/${apiOf(creds)}/issue/${encodeURIComponent(key)}/remotelink`;
}

/** Each remote link of a card as `{ canon, link }` for the ones that are pull request addresses; a link to anything else is not ours to read. */
function prLinksIn(raw: unknown): { canon: string; globalId: string; link: JiraPrLink }[] {
  const out: { canon: string; globalId: string; link: JiraPrLink }[] = [];
  for (const l of Array.isArray(raw) ? raw : []) {
    if (!isObj(l) || !isObj(l.object)) continue;
    const a = prAddress(str(l.object.url));
    if (!a) continue;
    const status = isObj(l.object.status) ? l.object.status : {};
    out.push({ canon: a.url, globalId: str(l.globalId), link: { url: a.url, number: a.number, title: str(l.object.title), resolved: status.resolved === true } });
  }
  return out;
}

/** What the card's remote links hold: the pull requests (as ever) and every link as a row. */
export interface JiraRemoteLinks { links: JiraPrLink[]; web: CardWebLink[] }

/** The card's remote links: one request, whether the caller wants the pull requests, every address, or both. A link with no global id counts like any other. */
export async function remoteLinksAll(creds: JiraCreds, key: string): Promise<JiraResult<JiraRemoteLinks>> {
  if (!ISSUE_KEY.test(key)) return { ok: false, error: "That is not a Jira card id" };
  const r = await jiraCall<unknown>(creds, remoteLinksPath(creds, key));
  if (!r.ok) return { ...r, data: undefined };
  const seen = new Set<string>();
  return { ok: true, data: { links: prLinksIn(r.data).map((x) => x.link).filter((l) => !seen.has(l.url) && !!seen.add(l.url)), web: webLinksOf(r.data) } };
}
/** The pull requests this card is linked to on the site: one request. */
export async function remoteLinks(creds: JiraCreds, key: string): Promise<JiraResult<JiraPrLink[]>> {
  const r = await remoteLinksAll(creds, key);
  return r.ok && r.data ? { ok: true, data: r.data.links } : { ...r, data: undefined };
}
export const remoteLinksStored = (key: string): Promise<JiraResult<JiraPrLink[]>> => withStored((c) => remoteLinks(c, key));
export const remoteLinksAllStored = (key: string): Promise<JiraResult<JiraRemoteLinks>> => withStored((c) => remoteLinksAll(c, key));

export type LinkOutcome = { ok: true; linked: boolean; url: string } | { ok: false; error: string; unauthorised?: boolean };

const TITLE_MAX = 200;

/**
 * Put one pull request on a card as a remote link, once.
 *
 * Idempotent by reading first: the card's links are read (one request) and an
 * address already there is left alone. Existing links on a real site carry no
 * global id, so the global id alone cannot say "already linked"; the
 * canonical address of every link is compared, with or without one. A read
 * that fails stops the write: a link posted blind is a link that may be a
 * second one. The link is written with the canonical address as `globalId`, so
 * a later post of the same address updates rather than adds.
 *
 * Writes are off unless switched on, and everything refused is a sentence of
 * ours: Jira's own error text never reaches the answer.
 * Ceiling: the title and state on the link are written once and not refreshed.
 */
export async function linkPullRequest(creds: JiraCreds, key: string, address: string, title = ""): Promise<LinkOutcome> {
  if (!jiraWriteEnabled()) return { ok: false, error: WRITE_OFF };
  if (!ISSUE_KEY.test(key)) return { ok: false, error: "That is not a Jira card id" };
  const pr = prAddress(address);
  if (!pr) return { ok: false, error: "That is not a pull request address" };

  const seen = await jiraCall<unknown>(creds, remoteLinksPath(creds, key), { fresh: true });
  if (!seen.ok) {
    return { ok: false, unauthorised: seen.unauthorised, error: `Nothing was changed: could not read the card's links first. ${seen.error ?? "Jira did not answer"}` };
  }
  if (prLinksIn(seen.data).some((l) => l.canon === pr.url || l.globalId === pr.url)) return { ok: true, linked: false, url: pr.url };

  // eslint-disable-next-line no-control-regex
  const said = title.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
  const label = `${pr.slug}#${pr.number}`;
  const post = await jiraCall<unknown>(creds, remoteLinksPath(creds, key), {
    method: "POST",
    body: { globalId: pr.url, object: { url: pr.url, title: said ? `${label}: ${said}` : label } },
  });
  if (!post.ok) {
    if (post.status === 400) return { ok: false, error: "Jira did not accept that link" };
    return { ok: false, unauthorised: post.unauthorised, error: post.error ?? "Jira did not accept that link" };
  }
  return { ok: true, linked: true, url: pr.url };
}

export async function linkPullRequestStored(key: string, address: string, title = ""): Promise<LinkOutcome> {
  const c = storedCreds();
  return c ? linkPullRequest(c, key, address, title) : { ok: false, error: NOT_CONNECTED };
}

/** The stored connection's moves, or the sentence that says there is none. */
export const movesStored = (key: string): Promise<JiraResult<JiraMoves>> => withStored((c) => movesOf(c, key));

export async function moveStored(key: string, transitionId: string, updated: number, fields?: unknown): Promise<WriteOutcome> {
  const c = storedCreds();
  return c ? moveIssue(c, key, transitionId, updated, fields) : { ok: false, error: NOT_CONNECTED };
}

// ---------------------------------------------------------------------------
// who is on a card, and the hand-off
// ---------------------------------------------------------------------------

/*
 * A Jira card has one assignee. Cloud names a person by `accountId`, Data
 * Center by login `name` (its `key` is not what an assignee write takes), so a
 * person handed to the picker carries both what a write sends (`key`) and the
 * id a card's `people[].key` holds (`id`), and nothing has to guess which.
 *
 * `"-1"` is Jira's word for "the project's default assignee": it is refused
 * here, never sent. `null` is "nobody".
 */

const PEOPLE_MAX = 20;
const QUERY_MAX = 100;
/** A Cloud account id or a Data Center login: no spaces, no control characters. */
const PERSON_KEY = /^[^\s\u0000-\u001f\u007f]{1,255}$/;

/** The id a card's people carry, from a raw user object: the order `toTask` and `whoAmI` use. */
export const personId = (u: unknown): string => (isObj(u) ? str(u.accountId) || str(u.key) || str(u.name) : "");
export const personName = (u: unknown): string => (isObj(u) ? str(u.displayName) || str(u.name) || personId(u) : "");

function toPerson(u: unknown, v: 2 | 3): JiraPerson | null {
  if (!isObj(u) || u.active === false) return null;
  const key = v === 3 ? str(u.accountId) : str(u.name);
  if (!key || !PERSON_KEY.test(key)) return null;
  const avatar = isObj(u.avatarUrls) ? str(u.avatarUrls["48x48"]) : "";
  return { key, id: personId(u), name: personName(u), ...(avatar.startsWith("https://") ? { avatar } : null) };
}

/**
 * Who the card can be given to, matching what was typed.
 *
 * Jira looks through the first thousand people of the directory and filters
 * those, so an answer shorter than asked is NOT "that is everybody": the
 * caller must never read it as the end of the list. `transitionId` asks who
 * can be given the card during that move (the hand-off's own question).
 * Remembered per card, move and text for ten minutes, so typing back over a
 * name costs nothing.
 */
export function assignable(creds: JiraCreds, key: string, query: string, transitionId = ""): Promise<JiraResult<JiraPerson[]>> {
  if (!ISSUE_KEY.test(key)) return Promise.resolve({ ok: false, error: "That is not a Jira card id" });
  if (transitionId && !/^\d{1,10}$/.test(transitionId)) return Promise.resolve({ ok: false, error: "That is not one of this card's moves" });
  const q = query.trim().slice(0, QUERY_MAX);
  const v = apiOf(creds);
  const params = new URLSearchParams({ issueKey: key.toUpperCase(), [v === 3 ? "query" : "username"]: q, maxResults: String(PEOPLE_MAX) });
  if (transitionId) params.set("actionDescriptorId", transitionId);
  return memoOk<JiraPerson[]>(creds, `assignable|${key.toUpperCase()}|${transitionId}|${q.toLowerCase()}`, async () => {
    const r = await jiraCall<unknown>(creds, `/rest/api/${v}/user/assignable/search?${params}`);
    if (!r.ok) return { ...r, data: undefined };
    const list = Array.isArray(r.data) ? r.data : [];
    return { ok: true, data: list.map((u) => toPerson(u, v)).filter((p): p is JiraPerson => !!p) };
  });
}

export const assignableStored = (key: string, query: string, transitionId = ""): Promise<JiraResult<JiraPerson[]>> =>
  withStored((c) => assignable(c, key, query, transitionId));

export const assigneeBody = (creds: JiraCreds, who: string | null) => (apiOf(creds) === 3 ? { accountId: who } : { name: who });

/** A person key a write may carry: never the default-assignee word. */
export function badPerson(to: unknown): string | null {
  if (to === null) return null;
  if (typeof to !== "string" || !PERSON_KEY.test(to)) return "That is not somebody Jira knows";
  if (to.trim() === "-1") return "That is not somebody Jira knows";
  return null;
}

/** The card's stamp and people before a write, or the sentence that stops it. */
export async function readBefore(creds: JiraCreds, key: string, fields: string): Promise<{ f: Record<string, unknown>; id: string } | { stop: WriteOutcome }> {
  const seen = await jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/issue/${encodeURIComponent(key)}?fields=${fields}`, { fresh: true });
  if (!seen.ok) {
    return { stop: { ok: false, unauthorised: seen.unauthorised, error: `Nothing was changed: could not check the card first. ${seen.error ?? "Jira did not answer"}` } };
  }
  return { f: isObj(seen.data) && isObj(seen.data.fields) ? seen.data.fields : {}, id: isObj(seen.data) ? idText(seen.data.id) : "" };
}

/** A read whose `updated` cannot be parsed proves nothing about the card: no write goes behind it. */
export const unreadable = (): WriteOutcome => ({ ok: false, error: "Nothing was changed: could not tell whether the card moved since you opened it. Reload it and try again" });
export const stale = (): WriteOutcome => ({ ok: false, conflict: true, error: "Somebody changed this card while you had it open, reloaded" });

/** Why Jira refused an assignee write, in our words. */
export function assignRefusal(r: JiraResult<unknown>): WriteOutcome {
  if (r.status === 400) return { ok: false, error: "Jira did not take that person: they may not be assignable to this card" };
  if (r.status === 403) return { ok: false, error: "Your Jira account cannot assign this card" };
  return { ok: false, unauthorised: r.unauthorised, error: r.error };
}

/**
 * Give the card to somebody, or to nobody (`to: null`).
 *
 * The same shape as a move: the write switch, the inputs, a read of `updated`
 * (a conflict when it is not the one the person saw), the PUT, a read back.
 * Three requests. Jira documents no conditional assignee write, so the window
 * between the check and the PUT is one round trip; that is the ceiling.
 */
export async function setAssignee(creds: JiraCreds, key: string, to: string | null, updated: number): Promise<WriteOutcome> {
  if (!jiraWriteEnabled()) return { ok: false, error: WRITE_OFF };
  if (!ISSUE_KEY.test(key)) return { ok: false, error: "That is not a Jira card id" };
  const bad = badPerson(to);
  if (bad) return { ok: false, error: bad };
  if (!Number.isFinite(updated) || updated <= 0) return { ok: false, error: "Nothing was changed: reload the card and try again" };
  const before = await readBefore(creds, key, "updated,status,assignee");
  if ("stop" in before) return before.stop;
  const now = epoch(before.f.updated);
  if (!now) return unreadable();
  if (now !== updated) return stale();

  const put = await jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/issue/${encodeURIComponent(key)}/assignee`, {
    method: "PUT",
    body: assigneeBody(creds, to),
  });
  if (!put.ok) return assignRefusal(put);
  const back = await readIssue(creds, key, { fresh: true });
  if (!back.ok || !back.data) return { ok: false, error: `The card was changed, but could not be read back. Reload it. ${back.error ?? ""}`.trim() };
  return { ok: true, task: back.data };
}

export async function setAssigneeStored(key: string, to: string | null, updated: number): Promise<WriteOutcome> {
  const c = storedCreds();
  return c ? setAssignee(c, key, to, updated) : { ok: false, error: NOT_CONNECTED };
}

// --- the hand-off's settings ------------------------------------------------

const STATUS_ID = /^\d{1,12}$/;

/** A stored rule, or null for anything that is not one: a hand-edited file is not trusted. */
function toRule(v: unknown): JiraHandoffRule | null {
  if (!isObj(v)) return null;
  const to = isObj(v.to) && STATUS_ID.test(str(v.to.id)) && str(v.to.name)
    ? { id: str(v.to.id), name: str(v.to.name).slice(0, 120) }
    : null;
  return { to, askTo: v.askTo === true, clear: v.clear === true, askClear: v.askClear === true };
}

export function handoffRules(): Record<string, JiraHandoffRule> {
  const raw = readSettingsFile().handoff;
  const out: Record<string, JiraHandoffRule> = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const r = projectKey(k) ? toRule(v) : null;
    if (r) out[k] = r;
  }
  return out;
}

export function jiraSettings(): JiraSettings {
  return { writes: jiraWriteEnabled(), handoff: handoffRules() };
}

/** One project's rule, or `null` to drop it. Nothing here talks to Jira. */
export function setHandoffRule(project: unknown, rule: unknown): { ok: boolean; error?: string; settings?: JiraSettings } {
  if (!projectKey(project)) return { ok: false, error: "That is not a Jira project key" };
  const all = handoffRules();
  if (rule === null) delete all[project];
  else {
    const r = toRule(rule);
    if (!r) return { ok: false, error: "That is not a hand-off" };
    if (isObj(rule) && rule.to != null && !r.to) return { ok: false, error: "That is not one of the project's statuses" };
    all[project] = r;
  }
  writeSettingsKey("handoff", all);
  return { ok: true, settings: jiraSettings() };
}

/** A project's statuses, for the settings row: one list across its issue types, by id. Remembered ten minutes. */
export function projectStatuses(creds: JiraCreds, project: string): Promise<JiraResult<{ id: string; name: string; kind: "open" | "done" | "other" }[]>> {
  if (!projectKey(project)) return Promise.resolve({ ok: false, error: "That is not a Jira project key" });
  return memoOk(creds, `statuses|${project}`, async () => {
    const r = await jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/project/${encodeURIComponent(project)}/statuses`);
    if (!r.ok) return { ...r, data: undefined };
    const seen = new Map<string, { id: string; name: string; kind: "open" | "done" | "other" }>();
    for (const type of Array.isArray(r.data) ? r.data : []) {
      for (const s of isObj(type) && Array.isArray(type.statuses) ? type.statuses : []) {
        const id = isObj(s) ? idText(s.id) : "";
        if (!id || !str(s.name)) continue;
        const cat = isObj(s.statusCategory) ? str(s.statusCategory.key) : "";
        seen.set(id, { id, name: str(s.name), kind: cat === "done" ? "done" : cat === "new" || cat === "indeterminate" ? "open" : "other" });
      }
    }
    return { ok: true, data: [...seen.values()] };
  });
}

export const projectStatusesStored = (project: string) => withStored((c) => projectStatuses(c, project));

// --- the hand-off itself ----------------------------------------------------

/** A move as the hand-off needs it: where it leads, and whether its screen has the assignee on it. */
export interface HandoffMove { id: string; toId: string; toName: string; needs: string[]; takesAssignee: boolean }

export function handoffMoves(raw: unknown): HandoffMove[] {
  const list = isObj(raw) && Array.isArray(raw.transitions) ? raw.transitions : [];
  const out: HandoffMove[] = [];
  for (const t of list) {
    if (!isObj(t) || t.isAvailable === false) continue;
    const to = isObj(t.to) ? t.to : {};
    const id = idText(t.id);
    const toId = idText(to.id);
    if (!id || !toId) continue;
    const fields = isObj(t.fields) ? t.fields : {};
    const needs = Object.entries(fields).filter(([k, v]) => isObj(v) && v.required === true && FIELD_KEY.test(k)).map(([k]) => k);
    out.push({ id, toId, toName: str(to.name), needs, takesAssignee: "assignee" in fields });
  }
  return out;
}

export interface HandoffChoice {
  /** The status to end in, by id; absent is the project's setting. */
  to?: string;
  /** Take the assignee off; absent is the project's setting. */
  clear?: boolean;
}

/**
 * Move the card to the hand-off status and, when asked, take its assignee off,
 * as ONE request from the client: the server orders the writes, never the UI.
 *
 * The trap this is built around: two writes guarded by one `updated` stamp.
 * The move changes `updated`, so a second write that checks the stamp the
 * person saw is refused (or, unchecked, overwrites somebody). So the stamp is
 * checked once, before anything is written, and the second write's
 * precondition is "the assignee is still who it was", read after the move.
 *
 *   1. Read `updated`, status, assignee. A stamp that moved is a conflict, no write.
 *   2. Find the move into the destination from where the card is. None, or one
 *      whose screen asks for a field, is refused with no write.
 *   3. Clearing, and the move's screen has the assignee: one POST carrying
 *      `assignee: null`. Atomic.
 *   4. Otherwise the move first (moving is the point: a card moved and still
 *      assigned is visible and fixable, one unassigned and not moved has lost
 *      its owner quietly), then a read of the assignee, then a PUT of nobody
 *      only if it is still the person from step 1. Somebody else on it (a
 *      workflow step, or a person) is left on it, and said.
 *
 * What lands short of the whole is `ok` with `partial`, a sentence the UI shows
 * as a warning. Ceiling: between the read in step 4 and the PUT is one round
 * trip in which somebody could be put on the card; Jira has no conditional
 * assignee write to close it.
 */
/** A hand-off's answer. `moved`: the card moved but could not be read back, as much of it as the watch needs. */
export type HandoffOutcome = WriteOutcome & { moved?: ProviderTask; /** What each block of a step did; a step run says it, the older hand-off does not. */ blocks?: JiraBlockOutcome[] };

export async function handOff(creds: JiraCreds, key: string, updated: number, choice: HandoffChoice = {}): Promise<HandoffOutcome> {
  if (!jiraWriteEnabled()) return { ok: false, error: WRITE_OFF };
  if (!ISSUE_KEY.test(key)) return { ok: false, error: "That is not a Jira card id" };
  if (!Number.isFinite(updated) || updated <= 0) return { ok: false, error: "Nothing was changed: reload the card and try again" };
  if (choice.to !== undefined && !STATUS_ID.test(choice.to)) return { ok: false, error: "That is not one of the project's statuses" };
  const v = apiOf(creds);
  const K = key.toUpperCase();

  // 1.
  const before = await readBefore(creds, key, "updated,status,assignee,project");
  if ("stop" in before) return before.stop;
  const f = before.f;
  const now = epoch(f.updated);
  if (!now) return unreadable();
  if (now !== updated) return stale();
  const status = isObj(f.status) ? f.status : {};
  const statusName = str(status.name);
  const project = isObj(f.project) ? str(f.project.key) : K.slice(0, K.lastIndexOf("-"));
  const rule = handoffRules()[project];
  const toId = choice.to ?? rule?.to?.id;
  const clear = choice.clear ?? rule?.clear ?? false;
  if (!toId) return { ok: false, error: `No hand-off is set for ${project}: choose where it goes in Settings` };
  const was = personId(f.assignee);
  const wasName = personName(f.assignee);

  if (idText(status.id) === toId) return { ok: false, error: `${K} is already in ${statusName || rule?.to?.name || "that status"}` };

  // 2.
  const listed = await jiraCall<unknown>(creds, movesPath(creds, key), { fresh: true });
  if (!listed.ok) return { ok: false, unauthorised: listed.unauthorised, error: `Nothing was changed: could not read the card's moves. ${listed.error ?? "Jira did not answer"}` };
  const into = handoffMoves(listed.data).filter((m) => m.toId === toId);
  const destName = into[0]?.toName || (rule?.to?.id === toId ? rule.to.name : "") || "that status";
  if (!into.length) return { ok: false, error: `${K} cannot go to ${destName} from ${statusName || "where it is"}` };
  // Of two moves into one status, one with no form, and with the assignee on its screen when it is to come off.
  const free = into.filter((m) => !m.needs.length);
  if (!free.length) return { ok: false, error: `That move needs ${into[0]!.needs.join(", ")}, which cannot be filled in here yet` };
  const move = (clear && was ? free.find((m) => m.takesAssignee) : undefined) ?? free[0]!;

  const transitionsAt = `/rest/api/${v}/issue/${encodeURIComponent(key)}/transitions`;
  const moveFailed = (r: JiraResult<unknown>): WriteOutcome =>
    r.status === 409 ? { ok: false, conflict: true, error: "Somebody changed this card while you were moving it, reloaded" }
      : r.status === 400 ? { ok: false, error: NOT_ACCEPTED }
        : { ok: false, unauthorised: r.unauthorised, error: r.error };
  const readBack = async (partial?: string): Promise<HandoffOutcome> => {
    const back = await readIssue(creds, key, { fresh: true });
    if (!back.ok || !back.data) {
      // Enough of the card for the watch to know the move was ours.
      const moved = { id: before.id || K, customId: K, title: "", status: destName } as ProviderTask;
      return { ok: true, was: statusName, moved, partial: `${partial ? `${partial}. ` : ""}Moved to ${destName}, but the card could not be read back: reload it` };
    }
    return { ok: true, task: back.data, was: statusName, ...(partial ? { partial } : null) };
  };

  // 3.
  if (clear && was && move.takesAssignee) {
    const post = await jiraCall<unknown>(creds, transitionsAt, { method: "POST", body: { transition: { id: move.id }, fields: { assignee: null } } });
    if (!post.ok) return moveFailed(post);
    const out = await readBack();
    // A workflow step that puts somebody on the card on the way in runs after the screen.
    const on = out.task?.people?.[0];
    // The same person still on it: Jira kept the field as it was, nothing took them off.
    if (on && on.key === was) return { ...out, partial: `Moved to ${destName}, but ${on.name} is still assigned: Jira did not take them off` };
    if (on) return { ...out, partial: `Moved to ${destName}; ${on.name} was put on it by the workflow` };
    return out;
  }

  // 4.
  const post = await jiraCall<unknown>(creds, transitionsAt, { method: "POST", body: { transition: { id: move.id } } });
  if (!post.ok) return moveFailed(post);
  if (!clear || !was) return readBack();
  const after = await jiraCall<unknown>(creds, `/rest/api/${v}/issue/${encodeURIComponent(key)}?fields=assignee,updated`, { fresh: true });
  if (!after.ok) return readBack(`Moved to ${destName}, but who is on it could not be checked, so ${wasName} was left on it`);
  const af = isObj(after.data) && isObj(after.data.fields) ? after.data.fields : {};
  const nowOn = personId(af.assignee);
  // NOT `updated`: the move just changed it, and comparing it is the trap above.
  if (nowOn !== was) {
    return readBack(nowOn ? `Moved to ${destName}; ${personName(af.assignee)} was put on it meanwhile, so nobody was taken off` : undefined);
  }
  const put = await jiraCall<unknown>(creds, `/rest/api/${v}/issue/${encodeURIComponent(key)}/assignee`, { method: "PUT", body: assigneeBody(creds, null) });
  if (!put.ok) return readBack(`Moved to ${destName}, but ${wasName} is still assigned: ${assignRefusal(put).error ?? "Jira refused"}`);
  return readBack();
}

export async function handOffStored(key: string, updated: number, choice: HandoffChoice = {}): Promise<HandoffOutcome> {
  const c = storedCreds();
  return c ? handOff(c, key, updated, choice) : { ok: false, error: NOT_CONNECTED };
}
