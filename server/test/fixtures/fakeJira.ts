import errors from "./jira/errors.json";
import issueSeeds from "./jira/issues.json";
import myselfFixture from "./jira/myself.json";
import priorities from "./jira/priorities.json";
import projects from "./jira/projects.json";
import richDescription from "./jira/description-rich.json";
import userDirectory from "./jira/users.json";
import wiki from "./jira/wiki.json";
import workflowFixture from "./jira/workflow.json";

/*
 * A stateful stand-in for the Jira REST endpoints a card needs, in two
 * personalities picked by `startFakeJira({ flavor })`.
 *
 * "cloud" (the default) is Jira Cloud: REST v3, Atlassian Document Format for
 * descriptions and comments, Basic auth with an email and an API token, people
 * identified by `accountId`, a token-paged `POST /search/jql` with no total.
 *
 * "datacenter" is Jira Data Center (and Server): REST v2 only, wiki markup
 * strings for descriptions and comments (an ADF body is refused with 400),
 * `Authorization: Bearer <personal access token>` (a name and password over
 * Basic also works), people identified by `name` and `key` with no `accountId`
 * anywhere, `POST|GET /search` paged by `startAt` with a `total`, an unbounded
 * JQL allowed, `GET /project` as one unpaged array, `GET /priority` as the
 * current endpoint, and no rate-limit headers. Both answer `GET
 * /rest/api/2/serverInfo` without credentials, as the real ones do.
 *
 * Why stateful: the risky moves are state moves. A transition changes the
 * status and may run a post-function that assigns somebody; an assignee write
 * changes `updated`. A stub that answers fixed JSON cannot show that a hand-off
 * ended on the wrong person, and that is the failure worth catching.
 *
 * What it is NOT: proof Jira looks like this. Every shape here comes from the
 * published OpenAPI document, and the ones marked "unverified" below have not
 * been seen in a real response yet. When a real response differs, this file is
 * fixed first and the code under test second.
 *
 * Ceilings, so a limit that was chosen is not mistaken for a gap that was
 * missed: one workflow serves every project (a real site has one per project
 * and issue type); the JQL reader understands only `AND`-joined equality
 * clauses and `order by key|updated`; the permission model is a list of denied
 * issue keys per action, not a role system; there is no pagination on comments.
 * Data Center in particular: wiki markup is stored and returned as given, never
 * parsed or rendered; people are the fixed directory, with the email always
 * shown; one version's behaviour (9.x) stands for all of Server and Data Center.
 */

export const FAKE_EMAIL = "ada@acme.example";
export const FAKE_TOKEN = "fake-token";
export const FAKE_AUTH = `Basic ${Buffer.from(`${FAKE_EMAIL}:${FAKE_TOKEN}`).toString("base64")}`;

export type FakeFlavor = "cloud" | "datacenter";

/** A Data Center personal access token, and the name and password that also work there. */
export const FAKE_PAT = "pat-orbit-1042";
export const FAKE_PAT_AUTH = `Bearer ${FAKE_PAT}`;
export const FAKE_DC_USER = "ada";
export const FAKE_DC_PASSWORD = "pw-orbit";
export const FAKE_DC_BASIC = `Basic ${Buffer.from(`${FAKE_DC_USER}:${FAKE_DC_PASSWORD}`).toString("base64")}`;

const SERVER_INFO = "/rest/api/2/serverInfo";
const prefixOf = (f: FakeFlavor) => (f === "datacenter" ? "/rest/api/2" : "/rest/api/3");
const CLOCK_BASE = Date.parse("2026-01-15T10:00:00.000Z");

export interface FakeTransition {
  id: string;
  name: string;
  toStatusId: string;
  requiredFields: string[];
  acceptsAssignee: boolean;
  /** A workflow post-function: this account becomes the assignee on entry. */
  postAssign?: string;
}

export interface FakeWorkflow {
  categories: Record<string, { id: number; key: string; name: string; colorName: string }>;
  statuses: { id: string; name: string; category: string }[];
  transitions: Record<string, FakeTransition[]>;
}

const workflow: FakeWorkflow = workflowFixture;

export interface FakeComment {
  id: string;
  author: string;
  created: string;
  updated: string;
  body: unknown;
}

export interface FakeIssue {
  id: string;
  key: string;
  projectKey: string;
  summary: string;
  issueType: string;
  priorityId: string;
  labels: string[];
  parentKey: string | null;
  reporter: string;
  created: string;
  statusId: string;
  /** The directory id (`accountId` on Cloud; Data Center shows `name`/`key`), or null when unassigned. */
  assignee: string | null;
  resolution: string | null;
  description: unknown | null;
  updated: string;
  comments: FakeComment[];
}

export interface FakeState {
  issues: Record<string, FakeIssue>;
  workflow: FakeWorkflow;
  /** Issue keys the caller may not act on: transitions list is `[]` (200),
   *  the transition POST is 400, an assignee write or a comment is 403. */
  deny: { transition: string[]; assign: string[]; comment: string[] };
  /** When true, search answers from the data as it was at the last reset,
   *  the way a real index can trail a write. */
  searchLags: boolean;
  tick: number;
}

export interface LoggedRequest {
  method: string;
  /** Without the flavor's `/rest/api/N` prefix; a path outside it, and serverInfo, are logged whole. */
  path: string;
  query: Record<string, string>;
  /** The raw Authorization header, or null. */
  auth: string | null;
  /** Parsed JSON, or the raw text when it did not parse, or undefined. */
  body: unknown;
}

export interface FailRule {
  /** Path as logged. A trailing `*` matches any suffix. */
  path: string;
  method?: string;
  /** Answer with this status and the matching body from errors.json. */
  status?: 400 | 401 | 403 | 404 | 409 | 429 | 500;
  /** 429 only: seconds for Retry-After (default 5). */
  retryAfter?: number;
  /** 429 only: the RateLimit-Reason value (default jira-burst-based). */
  reason?: string;
  /** Hold the answer this long, then carry on (or fail, if `status` is set). */
  delayMs?: number;
  /** Break the connection mid-answer instead of replying. */
  drop?: boolean;
  /** Answer 200 with a body that is not JSON. */
  garbage?: boolean;
  /** Search only: answer with no issues and `isLast`, to tell it from a 500. */
  empty?: boolean;
  /** How many requests the rule applies to; unlimited when absent. */
  times?: number;
}

export interface FakeJiraOptions {
  /** Which Jira this is. Default "cloud". */
  flavor?: FakeFlavor;
  /** What `serverInfo` says. `deploymentType: null` leaves the field out; a
   *  string replaces it (Data Center reports "Server", Cloud "Cloud"). */
  serverInfo?: { deploymentType?: string | null; version?: string };
  /** Issues per search page, capped by the caller's maxResults. Default 4. */
  pageSize?: number;
  /** How many directory users the assignable search scans before it filters
   *  (the real one scans 1000 and so returns fewer than asked). Default 3. */
  assignableScanCap?: number;
}

export interface FakeJira {
  flavor: FakeFlavor;
  /** Origin, no path: what `__setJiraBase` takes. */
  base: string;
  /** `base` plus `/rest/api/3` (Cloud) or `/rest/api/2` (Data Center). */
  api: string;
  requests: LoggedRequest[];
  state: FakeState;
  fail(rule: FailRule): void;
  /** Value of `X-RateLimit-Remaining` on every response; null drops the header. */
  setRemaining(n: number | null): void;
  /** Back to the seed: state, request log, rules, limiter, header. */
  reset(): void;
  stop(): Promise<void>;
}

const statusById = (id: string) => workflow.statuses.find((s) => s.id === id)!;
const userById = (id: string) => userDirectory.find((u) => u.accountId === id);

function stamp(tick: number): string {
  return new Date(CLOCK_BASE + tick * 1000).toISOString().replace("Z", "+0000");
}

function seedState(flavor: FakeFlavor): FakeState {
  const dc = flavor === "datacenter";
  const issues: Record<string, FakeIssue> = {};
  for (const s of issueSeeds) {
    const { richDescription: rich, ...rest } = s;
    const issue = structuredClone({ ...rest, description: rich ? (dc ? wiki.description : richDescription) : null }) as FakeIssue;
    // The same comment, as wiki text where the site speaks wiki markup.
    if (dc) for (const c of issue.comments) c.body = (wiki.comments as Record<string, string>)[c.id] ?? "";
    issues[s.key] = issue;
  }
  return { issues, workflow, deny: { transition: [], assign: [], comment: [] }, searchLags: false, tick: 0 };
}

/** A person as the caller of the given flavor sees them. */
function userObject(id: string | null, dc: boolean, asSelf = false) {
  if (!id) return null;
  const u = userById(id);
  if (!u) return null;
  // Data Center knows no account id: a login `name` and an opaque `key`, and
  // shows the email unless the site hid it, which the fake does not model.
  if (dc) {
    return {
      self: `${prefixOf("datacenter")}/user?username=${u.name}`,
      key: u.key,
      name: u.name,
      emailAddress: u.email,
      displayName: u.displayName,
      active: u.active,
      avatarUrls: { "48x48": `https://avatar.acme.example/${u.key}/48.png` },
      timeZone: "Europe/London",
    };
  }
  return {
    accountId: u.accountId,
    accountType: "atlassian",
    displayName: u.displayName,
    active: u.active,
    avatarUrls: { "48x48": `https://avatar.acme.example/${u.accountId}/48.png` },
    // A hidden email is omitted, not null: that is what the spec says.
    ...(asSelf || u.emailVisible ? { emailAddress: u.email } : {}),
  };
}

function statusObject(id: string) {
  const s = statusById(id);
  return { id: s.id, name: s.name, statusCategory: workflow.categories[s.category] };
}

function issueFields(i: FakeIssue, state: FakeState, dc: boolean) {
  const pr = priorities.find((p) => p.id === i.priorityId)!;
  const parent = i.parentKey ? state.issues[i.parentKey] : null;
  return {
    summary: i.summary,
    status: statusObject(i.statusId),
    assignee: userObject(i.assignee, dc),
    reporter: userObject(i.reporter, dc),
    priority: { id: pr.id, name: pr.name },
    issuetype: { name: i.issueType },
    project: { key: i.projectKey, name: projects.find((p) => p.key === i.projectKey)!.name },
    labels: i.labels,
    parent: parent ? { id: parent.id, key: parent.key, fields: { summary: parent.summary, issuetype: { name: parent.issueType } } } : undefined,
    description: i.description,
    resolution: i.resolution ? { name: i.resolution } : null,
    created: i.created,
    updated: i.updated,
    comment: { comments: i.comments.map((c) => commentObject(c, dc)), total: i.comments.length },
  };
}

/** `fields` is a comma list; absent or `*all`/`*navigable` means everything but
 *  the comment block, which a real site also leaves out unless asked for. */
function issueObject(i: FakeIssue, state: FakeState, dc: boolean, fieldsParam?: string | null) {
  const all = issueFields(i, state, dc) as Record<string, unknown>;
  const asked = (fieldsParam ?? "").split(",").map((f) => f.trim()).filter(Boolean);
  let fields: Record<string, unknown>;
  if (asked.length === 0 || asked.includes("*all") || asked.includes("*navigable")) {
    const { comment: _c, ...rest } = all;
    fields = asked.includes("*all") ? all : rest;
  } else {
    fields = Object.fromEntries(asked.filter((f) => f in all).map((f) => [f, all[f]]));
  }
  return { id: i.id, key: i.key, self: `${prefixOf(dc ? "datacenter" : "cloud")}/issue/${i.id}`, fields };
}

function commentObject(c: FakeComment, dc: boolean) {
  return { id: c.id, author: userObject(c.author, dc), body: c.body, created: c.created, updated: c.updated };
}

function transitionObject(t: FakeTransition, withFields: boolean, dc: boolean) {
  const base = {
    id: t.id,
    name: t.name,
    to: statusObject(t.toStatusId),
    hasScreen: t.requiredFields.length > 0 || t.acceptsAssignee,
    isGlobal: false,
    isInitial: false,
    // Availability and conditions are reported by Cloud only.
    ...(dc ? {} : { isAvailable: true, isConditional: false }),
  };
  if (!withFields) return base;
  // Unverified: the exact shape of a screen field on a real site.
  const fields: Record<string, unknown> = {};
  for (const k of t.requiredFields) {
    fields[k] = { required: true, key: k, name: k[0].toUpperCase() + k.slice(1), hasDefaultValue: false, operations: ["set"] };
  }
  if (t.acceptsAssignee) fields.assignee = { required: false, key: "assignee", name: "Assignee", hasDefaultValue: false, operations: ["set"] };
  return { ...base, fields };
}

/** Cloud wants a bounded query: at least one clause before any `order by`.
 *  Data Center accepts an empty restriction and names people by login or key. */
function runJql(jql: string, issues: Record<string, FakeIssue>, dc: boolean): FakeIssue[] | { error: string } {
  const order = /(^|\s)order\s+by\s+/i.exec(jql);
  const restriction = (order ? jql.slice(0, order.index) : jql).trim();
  if (!restriction && !dc) return { error: "unbounded" };
  let rows = Object.values(issues);
  // An assignee as the flavor spells it: an account id, or a login name or key.
  const person = (s: string) => (dc ? userDirectory.find((u) => u.name === s || u.key === s)?.accountId : userById(s)?.accountId);
  for (const clause of restriction ? restriction.split(/\s+and\s+/i) : []) {
    const c = clause.trim();
    let m: RegExpExecArray | null;
    const q = (s: string) => s.replace(/^"|"$/g, "");
    if ((m = /^project\s*(!?=)\s*(.+)$/i.exec(c))) rows = rows.filter((i) => (i.projectKey === q(m![2]).toUpperCase()) === (m![1] === "="));
    else if (/^assignee\s*=\s*currentUser\(\)$/i.test(c)) rows = rows.filter((i) => i.assignee === myselfFixture.accountId);
    else if ((m = /^assignee\s+is\s+(not\s+)?empty$/i.exec(c))) rows = rows.filter((i) => (i.assignee === null) === !m![1]);
    else if ((m = /^assignee\s*=\s*(.+)$/i.exec(c))) {
      const who = person(q(m[1]));
      if (!who) return { error: `The value '${q(m[1])}' does not exist for the field 'assignee'.` };
      rows = rows.filter((i) => i.assignee === who);
    }
    else if ((m = /^status\s*(!?=)\s*(.+)$/i.exec(c))) rows = rows.filter((i) => (statusById(i.statusId).name.toLowerCase() === q(m![2]).toLowerCase()) === (m![1] === "="));
    else if ((m = /^statusCategory\s*(!?=)\s*(.+)$/i.exec(c))) {
      rows = rows.filter((i) => {
        const k = workflow.categories[statusById(i.statusId).category];
        const hit = [k.key, k.name.toLowerCase()].includes(q(m![2]).toLowerCase());
        return hit === (m![1] === "=");
      });
    } else if ((m = /^key\s*=\s*(.+)$/i.exec(c))) rows = rows.filter((i) => i.key === q(m![1]).toUpperCase());
    else return { error: `Error in the JQL Query: the fake does not understand "${c}".` };
  }
  const by = order ? /^(key|updated)\s*(asc|desc)?/i.exec(jql.slice(order.index + order[0].length).trim()) : null;
  const field = by?.[1].toLowerCase() ?? "key";
  const dir = (by?.[2] ?? (field === "updated" ? "desc" : "asc")).toLowerCase() === "desc" ? -1 : 1;
  const num = (k: string) => Number(k.split("-")[1]);
  rows.sort((a, b) => dir * (field === "updated" ? a.updated.localeCompare(b.updated) : a.projectKey.localeCompare(b.projectKey) || num(a.key) - num(b.key)));
  return rows;
}

// More than 20 writes in 2 s on one issue. The 100-in-30-s limit is not here:
// no test can reach it without waiting.
const WRITE_WINDOW_MS = 2_000;
const WRITE_MAX = 20;

export function startFakeJira(opts: FakeJiraOptions = {}): FakeJira {
  const flavor: FakeFlavor = opts.flavor ?? "cloud";
  const dc = flavor === "datacenter";
  const PREFIX = prefixOf(flavor);
  const pageSize = opts.pageSize ?? 4;
  const scanCap = opts.assignableScanCap ?? 3;
  const requests: LoggedRequest[] = [];
  let rules: (FailRule & { left: number })[] = [];
  // Data Center sends no rate-limit headers unless a test asks for one.
  const seedRemaining = dc ? null : 100;
  let remaining: number | null = seedRemaining;
  let writes = new Map<string, number[]>();
  let seedSnapshot = seedState(flavor);
  // Handed out once; reset() refills it in place so a test holding it still sees the live object.
  const live = seedState(flavor);

  const headersFor = (extra?: Record<string, string>) => {
    const h = new Headers({ "content-type": "application/json;charset=UTF-8", ...extra });
    if (remaining !== null) h.set("X-RateLimit-Remaining", String(remaining));
    return h;
  };
  const json = (status: number, body: unknown, extra?: Record<string, string>) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: headersFor(extra) });
  const bad = (errs: Record<string, string> = {}, messages: string[] = []) => json(400, { errorMessages: messages, errors: errs });
  const notFound = (key: string) => json(404, { ...errors["404"], errorMessages: [`Issue does not exist or you do not have permission to see it. (${key})`] });

  const statusReply = (rule: FailRule): Response => {
    const status = rule.status!;
    if (status === 429) {
      const secs = rule.retryAfter ?? 5;
      // Reset time and reason are Cloud's; Data Center's rate limiting sends Retry-After alone.
      return json(429, errors["429"], dc ? { "Retry-After": String(secs) } : {
        "Retry-After": String(secs),
        "X-RateLimit-Reset": new Date(Date.now() + secs * 1000).toISOString(),
        "RateLimit-Reason": rule.reason ?? "jira-burst-based",
      });
    }
    const extra = status === 401 ? { "WWW-Authenticate": dc ? 'Bearer realm="jira"' : 'Basic realm="jira"' } : undefined;
    return json(status, errors[String(status) as keyof typeof errors], extra);
  };

  const limited = (key: string): Response | null => {
    if (dc) return null; // the per-issue write limit is Cloud's
    const now = Date.now();
    const stamps = (writes.get(key) ?? []).filter((t) => now - t < WRITE_WINDOW_MS);
    stamps.push(now);
    writes.set(key, stamps);
    if (stamps.length <= WRITE_MAX) return null;
    return statusReply({ path: "", status: 429, retryAfter: WRITE_WINDOW_MS / 1000, reason: "jira-per-issue-on-write" });
  };

  const bump = (i: FakeIssue) => {
    i.updated = stamp(++live.tick);
  };

  const pageToken = (offset: number) => Buffer.from(`o:${offset}`).toString("base64url");
  const readToken = (t: string): number | null => {
    const m = /^o:(\d+)$/.exec(Buffer.from(t, "base64url").toString());
    return m ? Number(m[1]) : null;
  };

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // serverInfo is logged whole on both flavors: it is the one path both serve.
    const path = url.pathname !== SERVER_INFO && url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) || "/" : url.pathname;
    const query = Object.fromEntries(url.searchParams);
    let body: unknown;
    if (req.method === "POST" || req.method === "PUT") {
      const text = await req.text();
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
    }
    requests.push({ method: req.method, path, query, auth: req.headers.get("authorization"), body });

    const rule = rules.find((r) => r.left > 0 && (!r.method || r.method === req.method) && (r.path.endsWith("*") ? path.startsWith(r.path.slice(0, -1)) : r.path === path));
    if (rule) {
      rule.left--;
      if (rule.delayMs) await Bun.sleep(rule.delayMs);
      if (rule.drop) {
        // Promise a long body, send a few bytes, then end the stream early: the client sees a connection cut mid-answer.
        const cut = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"accountId": "acc'));
            setTimeout(() => c.close(), 20);
          },
        });
        return new Response(cut, { headers: headersFor({ "content-length": "500" }) });
      }
      if (rule.garbage) return new Response('{"issues": [{"id": ', { status: 200, headers: headersFor() });
      if (rule.status) return statusReply(rule);
    }

    const m = req.method;
    let r: RegExpExecArray | null;

    // Answered to anybody, on both flavors, before the credentials are judged.
    if (m === "GET" && path === SERVER_INFO) {
      const said = opts.serverInfo ?? {};
      const type = said.deploymentType === undefined ? (dc ? "Server" : "Cloud") : said.deploymentType;
      const version = said.version ?? (dc ? "9.12.0" : "1001.0.0-SNAPSHOT");
      return json(200, {
        baseUrl: base,
        version,
        versionNumbers: version.split(/[.-]/).slice(0, 3).map(Number),
        ...(type === null ? {} : { deploymentType: type }),
        buildNumber: dc ? 912000 : 100307,
        serverTitle: "Acme Jira",
        serverTime: stamp(live.tick),
      });
    }

    const authorized = dc
      ? [FAKE_PAT_AUTH, FAKE_DC_BASIC].includes(req.headers.get("authorization") ?? "")
      : req.headers.get("authorization") === FAKE_AUTH;
    if (!authorized) return statusReply({ path: "", status: 401 });

    if (m === "GET" && path === "/myself") {
      if (dc) return json(200, userObject(myselfFixture.accountId, true));
      return json(200, { ...myselfFixture, self: `${PREFIX}/user?accountId=${myselfFixture.accountId}`, avatarUrls: {} });
    }

    // Data Center lists every project in one array; Cloud pages them.
    if (dc && m === "GET" && path === "/project") {
      return json(200, projects.map(({ defaultAssignee: _d, ...p }) => ({ ...p, self: `${PREFIX}/project/${p.id}`, avatarUrls: {} })));
    }

    if (!dc && m === "GET" && path === "/project/search") {
      const start = Number(query.startAt ?? 0);
      const max = Math.min(Number(query.maxResults ?? 50), 50);
      const q = (query.query ?? "").toLowerCase();
      const all = projects.filter((p) => !q || p.key.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
      const values = all.slice(start, start + max).map(({ defaultAssignee: _d, ...p }) => p);
      return json(200, { startAt: start, maxResults: max, total: all.length, isLast: start + max >= all.length, values });
    }

    if (m === "GET" && path === "/priority") return json(200, priorities);
    if (!dc && m === "GET" && path === "/priority/search") {
      const start = Number(query.startAt ?? 0);
      const max = Math.min(Number(query.maxResults ?? 50), 50);
      return json(200, { startAt: start, maxResults: max, total: priorities.length, isLast: start + max >= priorities.length, values: priorities.slice(start, start + max) });
    }

    if (m === "GET" && path === "/user/assignable/search") {
      // Data Center takes the text as `username` and matches the login, the name and the email.
      const q = (dc ? query.username ?? "" : query.query ?? "").toLowerCase();
      const max = Number(query.maxResults ?? 50);
      const match = (u: (typeof userDirectory)[number]) => u.displayName.toLowerCase().includes(q) || (dc && (u.name.includes(q) || u.email.includes(q)));
      const scanned = userDirectory.slice(0, scanCap).filter((u) => u.active && match(u));
      return json(200, scanned.slice(0, max).map((u) => userObject(u.accountId, dc)));
    }

    if (!dc && path === "/search" && (m === "GET" || m === "POST")) return json(410, errors.goneSearch);
    // Data Center: startAt paging with a total, from a body or from the query string.
    if (dc && path === "/search" && (m === "GET" || m === "POST")) {
      const b = (m === "POST" ? body ?? {} : query) as { jql?: string; fields?: string[] | string; startAt?: number | string; maxResults?: number | string };
      if (rule?.empty) return json(200, { startAt: 0, maxResults: pageSize, total: 0, issues: [] });
      const rows = runJql(b.jql ?? "", live.searchLags ? seedSnapshot.issues : live.issues, true);
      if ("error" in rows) return bad({}, [rows.error]);
      const start = Math.max(0, Number(b.startAt ?? 0) || 0);
      const size = Math.min(Number(b.maxResults ?? pageSize) || pageSize, pageSize);
      const fields = Array.isArray(b.fields) ? b.fields.join(",") : b.fields ?? null;
      return json(200, { expand: "schema,names", startAt: start, maxResults: size, total: rows.length, issues: rows.slice(start, start + size).map((i) => issueObject(i, live, true, fields)) });
    }
    if (!dc && m === "POST" && path === "/search/jql") {
      const b = (body ?? {}) as { jql?: string; fields?: string[]; maxResults?: number; nextPageToken?: string };
      if (rule?.empty) return json(200, { issues: [], isLast: true });
      const rows = runJql(b.jql ?? "", live.searchLags ? seedSnapshot.issues : live.issues, false);
      if ("error" in rows) return rows.error === "unbounded" ? json(400, errors.unboundedJql) : bad({}, [rows.error]);
      let offset = 0;
      if (b.nextPageToken !== undefined) {
        const o = readToken(b.nextPageToken);
        if (o === null) return bad({}, ["The nextPageToken is not valid or has expired."]);
        offset = o;
      }
      const size = Math.min(b.maxResults ?? pageSize, pageSize);
      const slice = rows.slice(offset, offset + size);
      const last = offset + size >= rows.length;
      const fields = Array.isArray(b.fields) ? b.fields.join(",") : null;
      return json(200, { issues: slice.map((i) => issueObject(i, live, false, fields)), isLast: last, ...(last ? {} : { nextPageToken: pageToken(offset + size) }) });
    }

    if ((r = /^\/issue\/([^/]+)(?:\/(transitions|assignee|comment))?$/.exec(path))) {
      const key = decodeURIComponent(r[1]);
      const sub = r[2];
      const issue = live.issues[key];
      if (!issue) return notFound(key);

      if (!sub && m === "GET") return json(200, issueObject(issue, live, dc, query.fields));

      if (m !== "GET") {
        const limit = limited(key);
        if (limit) return limit;
      }

      if (sub === "transitions" && m === "GET") {
        const denied = live.deny.transition.includes(key);
        let list = denied ? [] : live.workflow.transitions[issue.statusId] ?? [];
        if (query.transitionId) list = list.filter((t) => t.id === query.transitionId);
        const withFields = (query.expand ?? "").includes("transitions.fields");
        return json(200, { expand: "transitions", transitions: list.map((t) => transitionObject(t, withFields, dc)) });
      }

      if (sub === "transitions" && m === "POST") {
        const b = (body ?? {}) as { transition?: { id?: unknown }; fields?: Record<string, unknown>; update?: Record<string, unknown> };
        if (b.transition?.id === undefined) return bad({}, ["Transition id is required."]);
        const id = String(b.transition.id);
        const t = live.deny.transition.includes(key) ? undefined : (live.workflow.transitions[issue.statusId] ?? []).find((x) => x.id === id);
        if (!t) return bad({}, [`Transition id '${id}' is not valid for this issue.`]);
        const sent: Record<string, unknown> = { ...b.update, ...b.fields };
        const onScreen = new Set([...t.requiredFields, ...(t.acceptsAssignee ? ["assignee"] : [])]);
        const stray: Record<string, string> = {};
        for (const k of Object.keys(sent)) if (!onScreen.has(k)) stray[k] = `Field '${k}' cannot be set. It is not on the appropriate screen, or unknown.`;
        if (Object.keys(stray).length) return bad(stray);
        const missing: Record<string, string> = {};
        for (const k of t.requiredFields) if (!(k in sent) || sent[k] === null) missing[k] = `${k[0].toUpperCase()}${k.slice(1)} is required.`;
        if (Object.keys(missing).length) return bad(missing);
        const named = sent.assignee as { accountId?: string; name?: string } | null | undefined;
        // Data Center names a person by login; an account id means nothing to it, and the other way round.
        const who = named ? (dc ? userDirectory.find((u) => u.name === named.name)?.accountId : userById(named.accountId ?? "")?.accountId) : null;
        if (named && !who) return bad({ assignee: `User '${(dc ? named.name : named.accountId) ?? ""}' does not exist.` });
        issue.statusId = t.toStatusId;
        if ("assignee" in sent) issue.assignee = who ?? null;
        if (t.requiredFields.includes("resolution")) issue.resolution = String((sent.resolution as { name?: string } | undefined)?.name ?? "Done");
        // A workflow post-function runs after the screen fields, so it wins.
        if (t.postAssign) issue.assignee = t.postAssign;
        bump(issue);
        return json(204, null);
      }

      if (sub === "assignee" && m === "PUT") {
        if (live.deny.assign.includes(key)) return json(403, { errorMessages: ["You do not have permission to assign issues."], errors: {} });
        // The field that names the person: `accountId` on Cloud, `name` on Data Center.
        const field = dc ? "name" : "accountId";
        const b = body as Record<string, string | null> | undefined;
        if (!b || !(field in b)) return bad({}, [`${field} is required.`]);
        const given = b[field];
        if (given === null) issue.assignee = null;
        // "-1" is the project's default assignee, which a caller must never send.
        else if (given === "-1") issue.assignee = projects.find((p) => p.key === issue.projectKey)!.defaultAssignee;
        else {
          const found = dc ? userDirectory.find((u) => u.name === given) : userById(String(given));
          if (!found) return bad({ assignee: `User '${given}' does not exist.` });
          issue.assignee = found.accountId;
        }
        bump(issue);
        return json(204, null);
      }

      if (sub === "comment" && m === "GET") {
        return json(200, { startAt: 0, maxResults: issue.comments.length, total: issue.comments.length, comments: issue.comments.map((c) => commentObject(c, dc)) });
      }

      if (sub === "comment" && m === "POST") {
        if (live.deny.comment.includes(key)) return json(403, { errorMessages: ["You do not have permission to comment on this issue."], errors: {} });
        const sent = (body as { body?: unknown } | undefined)?.body;
        let text: unknown;
        if (dc) {
          // Wiki markup is a string; a Document object is a v3 thing and is refused.
          if (typeof sent !== "string" || !sent.trim()) return bad({}, ["Comment body can not be empty!"]);
          text = sent;
        } else {
          const doc = sent as { type?: string; version?: number; content?: unknown } | undefined;
          if (!doc || typeof doc !== "object" || doc.type !== "doc" || doc.version !== 1 || !Array.isArray(doc.content)) {
            return bad({}, ["Operation value must be an Atlassian Document (see the Atlassian Document Format documentation)"]);
          }
          text = doc;
        }
        const when = stamp(++live.tick);
        const c: FakeComment = { id: String(30000 + live.tick), author: myselfFixture.accountId, created: when, updated: when, body: text };
        issue.comments.push(c);
        issue.updated = when;
        return json(201, commentObject(c, dc));
      }
    }

    return json(404, { errorMessages: [`The fake does not serve ${m} ${path}.`], errors: {} });
  }

  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle });
  const base = `http://127.0.0.1:${server.port}`;

  return {
    flavor,
    base,
    api: base + PREFIX,
    requests,
    state: live,
    fail(rule) {
      rules.push({ ...rule, left: rule.times ?? Infinity });
    },
    setRemaining(n) {
      remaining = n;
    },
    reset() {
      const fresh = seedState(flavor);
      for (const k of Object.keys(live)) delete (live as unknown as Record<string, unknown>)[k];
      Object.assign(live, fresh);
      seedSnapshot = seedState(flavor);
      requests.length = 0;
      rules = [];
      writes = new Map();
      remaining = seedRemaining;
    },
    async stop() {
      await server.stop(true);
    },
  };
}
