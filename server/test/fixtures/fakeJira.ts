import boardFixture from "./jira/boards.json";
import errors from "./jira/errors.json";
import fieldFixture from "./jira/fields.json";
import boardExtras from "./jira/issues-board.json";
import cardExtras from "./jira/card-extras.json";
import issueSeeds from "./jira/issues.json";
import linkTypes from "./jira/link-types.json";
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
 * Boards and saved filters (boards.json) are served as Jira Software does: the
 * agile endpoints live at `/rest/agile/1.0` on BOTH flavors, outside the
 * `/rest/api/N` prefix, so they are logged whole; `GET /filter/{id}` and
 * `/filter/favourite` are platform endpoints under the prefix. The deprecated
 * `/board/{id}/issue` is deliberately not served: a client that calls it gets
 * the 404 below, and a test can see it.
 *
 * What a board needs, served beside the above and named only when asked, so
 * every answer that existed before is unchanged: `GET /field` (the site's
 * fields; the Cloud list has a sprint, two story-point fields of one type, a
 * rank and a team, the Data Center list a sprint of legacy strings, two plain
 * number fields, a rank and no team); on an issue, `issuelinks`, `subtasks` and
 * those custom fields, each `null` when the card has none, as a real site
 * answers a requested empty field; `GET /issueLinkType`; board configuration
 * with an `estimation` field on two boards and none on the others; a search
 * that orders by the stored `rank`; and `GET|POST /issue/{key}/remotelink`,
 * where a post that names a known `globalId` updates that link and one
 * without a `globalId` always adds. `shuffleProjectStatuses` makes
 * `GET /project/{key}/statuses` list the statuses in an order that is no
 * board's. Unverified against a real site: the status of a remote-link update
 * (200 here, 201 for an add) and the exact `object.status` shape.
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
 * clauses and `order by key|updated|rank`; the permission model is a list of
 * denied issue keys per action, not a role system; there is no pagination on
 * comments. There are no sprint endpoints (a sprint is only the value on a
 * card), no field types on transition screens, no link write, no permission
 * model for remote links, and subtasks are listed from the fixture rather than
 * derived from `parent`.
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

export interface FakeHistory {
  id: string;
  author: string;
  created: string;
  items: { field: string; fieldtype?: string; from?: string | null; fromString?: string | null; to?: string | null; toString?: string | null }[];
}

export interface FakeWorklog { id: string; author: string; started: string; created: string; timeSpentSeconds: number; comment?: string }

export interface FakeComment {
  id: string;
  author: string;
  created: string;
  updated: string;
  body: unknown;
  /** The comment this one answers (Cloud's threads). */
  parentId?: string;
  /** Who may see it, when not everybody. */
  visibility?: { type: string; value: string };
}

export interface FakeIssue {
  id: string;
  key: string;
  projectKey: string;
  summary: string;
  issueType: string;
  priorityId: string;
  /** The due date, `YYYY-MM-DD`; absent or null for none. */
  dueDate?: string | null;
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
  /** The lexicographic rank a board orders by; the seed matches key order. */
  rank: string;
  sprints: FakeSprint[];
  /** Story points; null when the card has none. Zero is a value. */
  points: number | null;
  /** Which of the site's two points fields carries it. */
  pointsIn: "primary" | "alt";
  team: string | null;
  subtasks: string[];
  /** What `card-extras.json` gives one card: files, components, versions, time, the flag, a start date, and which fields its edit screen offers. */
  attachments?: { id: string; filename: string; size: number; mimeType: string; created: string; author: string }[];
  components?: string[];
  fixVersions?: string[];
  versions?: string[];
  timetracking?: { originalEstimate?: string; remainingEstimate?: string; timeSpent?: string };
  flagged?: string | null;
  startDate?: string | null;
  /** The change history, oldest first, as the site keeps it; `changelogCount` makes that many status flips instead (a card with a long history). */
  changelog?: FakeHistory[];
  changelogCount?: number;
  /** Work logged, oldest first; `worklogCount` makes that many short ones. */
  worklogs?: FakeWorklog[];
  worklogCount?: number;
  /** The fields `expand=editmeta` lists; the default is a project with none of components, versions or time tracking. */
  editmeta?: string[];
}

export interface FakeSprint { id: number; name: string; state: "active" | "closed" | "future" }

/** `from` blocks `to` when the type is Blocks: "to" is blocked by "from". */
export interface FakeLink { id: string; type: string; from: string; to: string }

export interface FakeRemoteLink {
  id: number;
  globalId?: string;
  application?: { type?: string; name?: string };
  relationship?: string;
  object: { url: string; title?: string; status?: { resolved?: boolean } };
}

export interface FakeState {
  issues: Record<string, FakeIssue>;
  workflow: FakeWorkflow;
  /** Issue keys the caller may not act on: transitions list is `[]` (200),
   *  the transition POST is 400, an assignee write or a comment is 403. */
  deny: { transition: string[]; assign: string[]; comment: string[] };
  /** What `GET /field` answers; a test drops one to play a site that has no sprints. */
  fields: Record<string, any>[];
  /** The boards the agile endpoints serve; a test reorders a column to play a board its project did not start with. */
  boards: (typeof boardFixture.boards)[number][];
  /** How many comments the issue read carries before the rest must be paged; null is all of them, as before. */
  commentCap: number | null;
  links: FakeLink[];
  remoteLinks: Record<string, FakeRemoteLink[]>;
  nextRemoteLinkId: number;
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
  /** Boards per page of `GET /board`, capped at 50. Default 50. */
  boardPageSize?: number;
  /** List `GET /project/{key}/statuses` in an order that is no board's. Default: workflow order. */
  shuffleProjectStatuses?: boolean;
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
  // Rank follows key order until a test moves a card, so a board reads as it always did.
  const keyOrder = Object.values(issues).sort((a, b) => a.projectKey.localeCompare(b.projectKey) || Number(a.key.split("-")[1]) - Number(b.key.split("-")[1]));
  keyOrder.forEach((i, n) => {
    const more = (boardExtras.issues as Record<string, Partial<FakeIssue>>)[i.key] ?? {};
    Object.assign(i, { rank: `0|i${String(n).padStart(5, "0")}:`, sprints: [], points: null, pointsIn: "primary", team: null, subtasks: [] }, structuredClone(more));
    Object.assign(i, structuredClone((cardExtras.issues as Record<string, Partial<FakeIssue>>)[i.key] ?? {}));
    // A long history and a long work log, made rather than written out, for the cards that page.
    if (i.changelogCount) {
      i.changelog = Array.from({ length: i.changelogCount }, (_, n) => ({
        id: String(50000 + n), author: n % 2 ? "acc-0001" : "acc-0002", created: stamp(n + 1),
        items: [{ field: "status", fieldtype: "jira", from: n % 2 ? "10001" : "10000", fromString: n % 2 ? "In Progress" : "To Do", to: n % 2 ? "10000" : "10001", toString: n % 2 ? "To Do" : "In Progress" }],
      }));
    }
    if (i.worklogCount) {
      i.worklogs = Array.from({ length: i.worklogCount }, (_, n) => ({
        id: String(60000 + n), author: n % 2 ? "acc-0001" : "acc-0002", started: stamp(n + 1), created: stamp(n + 1), timeSpentSeconds: 900 * (n % 4 + 1),
      }));
    }
  });
  return {
    issues, workflow, deny: { transition: [], assign: [], comment: [] }, searchLags: false, tick: 0,
    fields: structuredClone(flavor === "datacenter" ? fieldFixture.datacenter : fieldFixture.cloud),
    boards: structuredClone(boardFixture.boards),
    links: structuredClone([...boardExtras.links, ...cardExtras.links]),
    remoteLinks: structuredClone(boardExtras.remoteLinks) as Record<string, FakeRemoteLink[]>,
    nextRemoteLinkId: 20000,
    commentCap: null,
  };
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
    duedate: i.dueDate ?? null,
    parent: parent ? { id: parent.id, key: parent.key, fields: { summary: parent.summary, issuetype: { name: parent.issueType } } } : undefined,
    description: i.description,
    resolution: i.resolution ? { name: i.resolution } : null,
    created: i.created,
    updated: i.updated,
    comment: { comments: i.comments.slice(0, state.commentCap ?? undefined).map((c) => commentObject(c, dc)), maxResults: state.commentCap ?? i.comments.length, total: i.comments.length },
  };
}

/** The ids the site gave its custom fields; they differ by flavor so nothing can lean on one. */
const FIELD_IDS = {
  cloud: { sprint: "customfield_10020", points: { primary: "customfield_10016", alt: "customfield_10027" }, rank: "customfield_10019", team: "customfield_10001", start: "customfield_10015", flag: "customfield_10021" },
  datacenter: { sprint: "customfield_10104", points: { primary: "customfield_10106", alt: "customfield_10109" }, rank: "customfield_10105", team: null, start: "customfield_10110", flag: "customfield_10111" },
} as const;

const linkedIssue = (k: string, state: FakeState, dc: boolean) => {
  const o = state.issues[k]!;
  return { id: o.id, key: o.key, self: `${prefixOf(dc ? "datacenter" : "cloud")}/issue/${o.id}`, fields: { summary: o.summary, status: statusObject(o.statusId), issuetype: { name: o.issueType } } };
};

/** Fields that answer only when asked by name (or `*all`): a request that names none sees what it always saw. */
function boardFields(i: FakeIssue, state: FakeState, dc: boolean): Record<string, unknown> {
  const ids = FIELD_IDS[dc ? "datacenter" : "cloud"];
  const typeOf = (name: string) => linkTypes.issueLinkTypes.find((t) => t.name === name)!;
  const links = state.links.flatMap((l): Record<string, unknown>[] => {
    const t = typeOf(l.type);
    const type = { id: t.id, name: t.name, inward: t.inward, outward: t.outward };
    if (l.from === i.key) return [{ id: l.id, type, outwardIssue: linkedIssue(l.to, state, dc) }];
    if (l.to === i.key) return [{ id: l.id, type, inwardIssue: linkedIssue(l.from, state, dc) }];
    return [];
  });
  // Cloud sends sprints as objects; older Data Center as the bean's own text.
  const sprint = i.sprints.map((s) => (dc
    ? `com.atlassian.greenhopper.service.sprint.Sprint@1b2c3d[id=${s.id},rapidViewId=3,state=${s.state.toUpperCase()},name=${s.name},startDate=2026-01-05T09:00:00.000Z,endDate=2026-01-19T09:00:00.000Z,completeDate=<null>,sequence=${s.id}]`
    : { id: s.id, name: s.name, state: s.state, boardId: 3 }));
  const out: Record<string, unknown> = {
    issuelinks: links,
    subtasks: i.subtasks.map((k) => linkedIssue(k, state, dc)),
    [ids.sprint]: sprint.length ? sprint : null,
    [ids.points.primary]: i.pointsIn === "primary" ? i.points : null,
    [ids.points.alt]: i.pointsIn === "alt" ? i.points : null,
    [ids.rank]: i.rank,
    attachment: (i.attachments ?? []).map((a) => ({ id: a.id, filename: a.filename, size: a.size, mimeType: a.mimeType, created: a.created, author: userObject(a.author, dc) })),
    components: (i.components ?? []).map((name, n) => ({ id: String(10300 + n), name })),
    fixVersions: (i.fixVersions ?? []).map((name, n) => ({ id: String(10400 + n), name })),
    versions: (i.versions ?? []).map((name, n) => ({ id: String(10500 + n), name })),
    timetracking: i.timetracking ?? {},
    worklog: { startAt: 0, maxResults: 20, total: (i.worklogs ?? []).length, worklogs: (i.worklogs ?? []).slice(0, 20).map((w) => worklogObject(w, dc)) },
    [ids.start]: i.startDate ?? null,
    [ids.flag]: i.flagged ? [{ id: "10600", value: i.flagged }] : null,
  };
  if (ids.team) out[ids.team] = i.team ? { id: `team-${i.team.toLowerCase().replace(/\W+/g, "-")}`, name: i.team } : null;
  return out;
}

/** `fields` is a comma list; absent or `*navigable` means everything but the
 *  comment block, which a real site also leaves out unless asked for, and but
 *  the board fields, which only a name or `*all` brings. */
function issueObject(i: FakeIssue, state: FakeState, dc: boolean, fieldsParam?: string | null, expandParam?: string | null) {
  const base = issueFields(i, state, dc) as Record<string, unknown>;
  const board = boardFields(i, state, dc);
  const asked = (fieldsParam ?? "").split(",").map((f) => f.trim()).filter(Boolean);
  const all = { ...base, ...board };
  let fields: Record<string, unknown>;
  if (asked.length === 0 || asked.includes("*all") || asked.includes("*navigable")) {
    const { comment: _c, ...rest } = base;
    fields = asked.includes("*all") ? all : rest;
  } else {
    fields = Object.fromEntries(asked.filter((f) => f in all).map((f) => [f, all[f]]));
  }
  const ids = FIELD_IDS[dc ? "datacenter" : "cloud"];
  // The edit screen's field list, by the site's own ids; only when `expand` asks, as a real site does.
  const editmeta = (expandParam ?? "").split(",").includes("editmeta")
    ? { editmeta: { fields: Object.fromEntries((i.editmeta ?? ["summary", "description", "labels", "priority", "duedate", "assignee", "reporter"])
        .map((n) => [n === "startDate" ? ids.start : n === "flagged" ? ids.flag : n, { name: n, required: false }])) } }
    : {};
  // The whole history rides inside the issue only when asked: this is the cost the card read never pays on open.
  const hs = (i.changelog ?? []).map((h) => historyObject(h, dc));
  const changelog = (expandParam ?? "").split(",").includes("changelog") ? { changelog: { startAt: 0, maxResults: 100, total: hs.length, histories: hs.slice(0, 100) } } : {};
  return { id: i.id, key: i.key, self: `${prefixOf(dc ? "datacenter" : "cloud")}/issue/${i.id}`, ...editmeta, ...changelog, fields };
}

function historyObject(h: FakeHistory, dc: boolean) {
  return { id: h.id, author: userObject(h.author, dc), created: h.created, items: h.items.map((it) => ({ fieldtype: "jira", ...it })) };
}

function worklogObject(w: FakeWorklog, dc: boolean) {
  const secs = w.timeSpentSeconds;
  const human = `${secs >= 3600 ? `${Math.floor(secs / 3600)}h` : ""}${secs % 3600 ? `${secs >= 3600 ? " " : ""}${(secs % 3600) / 60}m` : ""}`;
  const doc = (t: string) => (dc ? t : { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] });
  return { id: w.id, author: userObject(w.author, dc), started: w.started, created: w.created, updated: w.created, timeSpent: human, timeSpentSeconds: secs, ...(w.comment ? { comment: doc(w.comment) } : {}) };
}

/** `listed` is the comment endpoint's shape, which carries `parentId`; the comments inside an issue read do not (measured on a real site). */
function commentObject(c: FakeComment, dc: boolean, listed = false) {
  return {
    id: c.id, author: userObject(c.author, dc), body: c.body, created: c.created, updated: c.updated,
    // A number, as a real site sends it.
    ...(listed && c.parentId && !dc ? { parentId: Number(c.parentId) } : {}),
    ...(c.visibility ? { visibility: c.visibility } : {}),
  };
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

function filterObject(f: (typeof boardFixture.filters)[number]) {
  return { id: f.id, name: f.name, jql: f.jql, favourite: f.favourite, owner: { displayName: userById(f.owner)?.displayName ?? "" }, self: `${prefixOf("cloud")}/filter/${f.id}`, viewUrl: "", searchUrl: "" };
}

/** Splits on `AND` at the top level only, so `status in (1, 2)` and a
 *  parenthesised group stay whole. A clause wrapped in one pair of brackets is
 *  opened and split again. */
function splitAnd(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quote = !quote;
    else if (quote) continue;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && /^\sand\s/i.test(text.slice(i, i + 5))) {
      out.push(text.slice(from, i).trim());
      from = i + 5;
      i += 4;
    }
  }
  out.push(text.slice(from).trim());
  return out.flatMap((c) => {
    const open = /^\(([\s\S]*)\)$/.exec(c);
    // Only a pair that encloses the whole clause: `(a) AND (b)` was split already.
    return open && balanced(open[1]) ? splitAnd(open[1]) : [c];
  });
}

const balanced = (t: string): boolean => {
  let d = 0;
  for (const ch of t) { d += ch === "(" ? 1 : ch === ")" ? -1 : 0; if (d < 0) return false; }
  return d === 0;
};

/** Cloud wants a bounded query: at least one clause before any `order by`.
 *  Data Center accepts an empty restriction and names people by login or key. */
function runJql(jql: string, issues: Record<string, FakeIssue>, dc: boolean): FakeIssue[] | { error: string } {
  const order = /(^|\s)order\s+by\s+/i.exec(jql);
  const restriction = (order ? jql.slice(0, order.index) : jql).trim();
  if (!restriction && !dc) return { error: "unbounded" };
  let rows = Object.values(issues);
  // An assignee as the flavor spells it: an account id, or a login name or key.
  const person = (s: string) => (dc ? userDirectory.find((u) => u.name === s || u.key === s)?.accountId : userById(s)?.accountId);
  for (const clause of restriction ? splitAnd(restriction) : []) {
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
    else if ((m = /^status\s+in\s*\(([^)]*)\)$/i.exec(c))) {
      // By id or by name, the way Jira takes either.
      const want = m[1].split(",").map((v) => q(v.trim()).toLowerCase()).filter(Boolean);
      rows = rows.filter((i) => { const s = statusById(i.statusId); return want.includes(s.id) || want.includes(s.name.toLowerCase()); });
    }
    else if ((m = /^status\s*(!?=)\s*(.+)$/i.exec(c))) rows = rows.filter((i) => (statusById(i.statusId).name.toLowerCase() === q(m![2]).toLowerCase()) === (m![1] === "="));
    else if ((m = /^issuetype\s*(!?=)\s*(.+)$/i.exec(c))) rows = rows.filter((i) => (i.issueType.toLowerCase() === q(m![2]).toLowerCase()) === (m![1] === "="));
    else if ((m = /^statusCategory\s*(!?=)\s*(.+)$/i.exec(c))) {
      rows = rows.filter((i) => {
        const k = workflow.categories[statusById(i.statusId).category];
        const hit = [k.key, k.name.toLowerCase()].includes(q(m![2]).toLowerCase());
        return hit === (m![1] === "=");
      });
    } else if ((m = /^key\s*=\s*(.+)$/i.exec(c))) rows = rows.filter((i) => i.key === q(m![1]).toUpperCase());
    else return { error: `Error in the JQL Query: the fake does not understand "${c}".` };
  }
  // `Rank` is the board order: the stored rank, which starts out as key order.
  const by = order ? /^(key|updated|rank)\s*(asc|desc)?/i.exec(jql.slice(order.index + order[0].length).trim()) : null;
  const field = by?.[1].toLowerCase() ?? "key";
  const dir = (by?.[2] ?? (field === "updated" ? "desc" : "asc")).toLowerCase() === "desc" ? -1 : 1;
  const num = (k: string) => Number(k.split("-")[1]);
  rows.sort((a, b) => dir * (field === "updated" ? a.updated.localeCompare(b.updated) : field === "rank" ? (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0) : a.projectKey.localeCompare(b.projectKey) || num(a.key) - num(b.key)));
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
  const boardPageSize = opts.boardPageSize ?? 50;
  const scanCap = opts.assignableScanCap ?? 3;
  const shuffleStatuses = opts.shuffleProjectStatuses ?? false;
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

    // A project's statuses, grouped by issue type (the same on both flavors).
    // One workflow serves every project here, so every type lists all of them.
    if (m === "GET" && (r = /^\/project\/([^/]+)\/statuses$/.exec(path))) {
      const p = projects.find((x) => x.key === decodeURIComponent(r![1]!) || x.id === decodeURIComponent(r![1]!));
      if (!p) return json(404, { errorMessages: [`No project could be found with key '${decodeURIComponent(r[1]!)}'.`], errors: {} });
      // Shuffled: no board puts To Do after QA, and a client that trusts this order shows it.
      const listed = shuffleStatuses ? ["4", "2", "5", "1", "3"].flatMap((id) => live.workflow.statuses.filter((s) => s.id === id)) : live.workflow.statuses;
      const statuses = listed.map((s) => ({ ...statusObject(s.id), self: `${PREFIX}/status/${s.id}`, description: "" }));
      return json(200, ["Task", "Bug"].map((name, i) => ({ id: String(10001 + i), name, subtask: false, self: `${PREFIX}/issuetype/${10001 + i}`, statuses })));
    }

    // Jira Software, outside the platform prefix and the same on both flavors.
    if (m === "GET" && path.startsWith("/rest/agile/1.0/")) {
      const boards = live.boards;
      const projectOf = (key: string) => projects.find((p) => p.key === key)!;
      const asBoard = (b: (typeof boards)[number]) => ({
        id: b.id, self: `${base}/rest/agile/1.0/board/${b.id}`, name: b.name, type: b.type,
        location: { projectId: Number(projectOf(b.projectKey).id), projectKey: b.projectKey, projectName: projectOf(b.projectKey).name, displayName: `${projectOf(b.projectKey).name} (${b.projectKey})`, projectTypeKey: "software" },
      });
      if (path === "/rest/agile/1.0/board") {
        const start = Math.max(0, Number(query.startAt ?? 0) || 0);
        const max = Math.min(Number(query.maxResults ?? 50) || 50, 50, boardPageSize);
        const name = (query.name ?? "").toLowerCase();
        const project = query.projectKeyOrId;
        const all = boards.filter((b) => (!name || b.name.toLowerCase().includes(name)) && (!project || b.projectKey === project || projectOf(b.projectKey).id === project));
        if (project && !projects.some((p) => p.key === project || p.id === project)) return json(404, { errorMessages: [`No project could be found with key '${project}'.`], errors: {} });
        return json(200, { maxResults: max, startAt: start, total: all.length, isLast: start + max >= all.length, values: all.slice(start, start + max).map(asBoard) });
      }
      if ((r = /^\/rest\/agile\/1\.0\/board\/(\d+)(\/configuration)?$/.exec(path))) {
        const b = boards.find((x) => x.id === Number(r![1]));
        if (!b) return json(404, { errorMessages: [`The requested board cannot be viewed because it either does not exist or you do not have permission to view it.`], errors: {} });
        if (!r[2]) return json(200, asBoard(b));
        const p = projectOf(b.projectKey);
        return json(200, {
          id: b.id, name: b.name, type: b.type, self: `${base}/rest/agile/1.0/board/${b.id}/configuration`,
          location: { type: "project", key: b.projectKey, id: p.id, self: `${PREFIX}/project/${p.id}`, name: p.name },
          filter: { id: b.filterId, self: `${PREFIX}/filter/${b.filterId}` },
          // Boards that state an estimate name the field; the others say nothing, as a kanban board does.
          ...("estimation" in b && b.estimation
            ? { estimation: { type: "field", field: { fieldId: FIELD_IDS[dc ? "datacenter" : "cloud"].points[b.estimation as "primary" | "alt"], displayName: "Estimate" } } }
            : {}),
          ...("subQuery" in b && b.subQuery ? { subQuery: { query: b.subQuery } } : {}),
          columnConfig: {
            columns: b.columns.map((c) => ({ name: c.name, statuses: c.statusIds.map((id) => ({ id, self: `${PREFIX}/status/${id}` })) })),
            constraintType: "none",
          },
        });
      }
      // The deprecated card list is not served: asking for it is a mistake worth seeing.
      return json(404, { errorMessages: [`The fake does not serve ${m} ${path}.`], errors: {} });
    }

    if (m === "GET" && path === "/filter/favourite") {
      return json(200, boardFixture.filters.filter((f) => f.favourite && f.visible !== false).map(filterObject));
    }
    if ((r = /^\/filter\/(\d+)$/.exec(path)) && m === "GET") {
      const f = boardFixture.filters.find((x) => x.id === r![1]);
      if (!f || f.visible === false) return json(404, { errorMessages: ["The filter does not exist or you do not have permission to view it."], errors: {} });
      return json(200, filterObject(f));
    }

    if (m === "GET" && path === "/field") return json(200, live.fields);
    if (m === "GET" && path === "/issueLinkType") return json(200, linkTypes);

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

    // One comment by id: read, change and delete. Whoever the token is may change their own; another's is a 403, as for a non-admin.
    if ((r = /^\/issue\/([^/]+)\/comment\/(\d+)$/.exec(path))) {
      const issue = live.issues[decodeURIComponent(r[1])];
      if (!issue) return notFound(decodeURIComponent(r[1]));
      const c = issue.comments.find((x) => x.id === r![2]);
      if (!c) return json(404, { errorMessages: ["Can not find a comment for the given id."], errors: {} });
      if (m === "GET") return json(200, commentObject(c, dc, true));
      const limit = limited(issue.key);
      if (limit) return limit;
      if (c.author !== myselfFixture.accountId) return json(403, { errorMessages: ["You do not have permission to edit this comment."], errors: {} });
      if (m === "DELETE") {
        issue.comments.splice(issue.comments.indexOf(c), 1);
        bump(issue);
        return json(204, null);
      }
      if (m === "PUT") {
        const sent = (body as { body?: unknown } | undefined)?.body;
        if (dc ? typeof sent !== "string" || !sent.trim() : !sent || typeof sent !== "object" || (sent as { type?: string }).type !== "doc") return bad({}, ["Comment body can not be empty!"]);
        c.body = sent;
        c.updated = stamp((live.tick += 2));
        issue.updated = c.updated;
        return json(200, commentObject(c, dc, true));
      }
    }

    // Cloud's label autocomplete and Data Center's suggest route: the labels cards carry, matching what was typed.
    if (m === "GET" && ((!dc && path === "/jql/autocompletedata/suggestions") || (dc && path === "/rest/api/1.0/labels/suggest"))) {
      const q = (query.fieldValue ?? query.query ?? "").toLowerCase();
      const all = [...new Set(Object.values(live.issues).flatMap((i) => i.labels))].filter((l) => l.toLowerCase().startsWith(q)).sort();
      return dc ? json(200, { token: q, suggestions: all.map((l) => ({ label: l, html: l })) }) : json(200, { results: all.map((l) => ({ value: l, displayName: l })) });
    }

    if ((r = /^\/issue\/([^/]+)(?:\/(transitions|assignee|comment|remotelink|changelog|worklog))?$/.exec(path))) {
      const key = decodeURIComponent(r[1]);
      const sub = r[2];
      const issue = live.issues[key];
      if (!issue) return notFound(key);

      if (!sub && m === "GET") return json(200, issueObject(issue, live, dc, query.fields, query.expand));

      if (m !== "GET") {
        const limit = limited(key);
        if (limit) return limit;
      }

      // A field edit. The fake is as forgiving as Jira: it takes a field the card's edit screen does not list, so a test that
      // expects a refusal is proving OUR guard and not the fake's. Answered 204: on a real site `returnIssue` answers with only
      // the fields the PUT changed and no `updated`, so nothing here pretends it is the card read back.
      if (!sub && m === "PUT") {
        const b = (body ?? {}) as { fields?: Record<string, unknown>; update?: Record<string, { add?: string; remove?: string }[]> };
        const ids = FIELD_IDS[dc ? "datacenter" : "cloud"];
        const f = b.fields ?? {};
        if ("summary" in f) {
          if (typeof f.summary !== "string" || !f.summary.trim()) return bad({ summary: "You must specify a summary of the issue." });
          issue.summary = f.summary;
        }
        if ("priority" in f) {
          const id = (f.priority as { id?: string } | null)?.id;
          if (!id || !priorities.some((p) => p.id === id)) return bad({ priority: "The priority selected is invalid." });
          issue.priorityId = id;
        }
        if ("duedate" in f) issue.dueDate = (f.duedate as string | null) ?? null;
        if (ids.start in f) issue.startDate = (f[ids.start] as string | null) ?? null;
        if (ids.flag in f) issue.flagged = Array.isArray(f[ids.flag]) ? String((f[ids.flag] as { value?: string }[])[0]?.value ?? "") || null : null;
        if ("timetracking" in f) {
          const t = { ...(issue.timetracking ?? {}), ...(f.timetracking as Record<string, string>) };
          // As Jira does: the empty string takes an estimate off, and `null` is accepted and changes nothing.
          for (const k of Object.keys(t) as (keyof typeof t)[]) if (t[k] === "") delete t[k];
          issue.timetracking = t;
        }
        if ("parent" in f) {
          const k = (f.parent as { key?: string } | null)?.key ?? null;
          if (k && !live.issues[k]) return bad({ parent: "Issue does not exist." });
          issue.parentKey = k;
        }
        for (const op of b.update?.labels ?? []) {
          if (op.add && !issue.labels.includes(op.add)) issue.labels = [...issue.labels, op.add];
          if (op.remove) issue.labels = issue.labels.filter((l) => l !== op.remove);
        }
        bump(issue);
        return json(204, null);
      }


      // The paged change history is Cloud's; Data Center answers the same history only inside the issue (`expand=changelog`).
      if (sub === "changelog" && m === "GET") {
        if (dc) return json(404, { errorMessages: ["Not Found"], errors: {} });
        const hs = (issue.changelog ?? []).map((h) => historyObject(h, dc));
        const start = Math.max(0, Number(query.startAt) || 0);
        const size = Math.min(Number(query.maxResults) || 100, 100);
        return json(200, { self: "", maxResults: size, startAt: start, total: hs.length, isLast: start + size >= hs.length, values: hs.slice(start, start + size) });
      }

      if (sub === "worklog" && m === "GET") {
        const ws = issue.worklogs ?? [];
        const start = Math.max(0, Number(query.startAt) || 0);
        const size = Math.min(Number(query.maxResults) || 1048576, 5000);
        return json(200, { startAt: start, maxResults: size, total: ws.length, worklogs: ws.slice(start, start + size).map((w) => worklogObject(w, dc)) });
      }

      if (sub === "remotelink" && m === "GET") {
        return json(200, (live.remoteLinks[key] ?? []).map((l) => ({ ...l, self: `${PREFIX}/issue/${issue.id}/remotelink/${l.id}` })));
      }

      if (sub === "remotelink" && m === "POST") {
        const b = (body ?? {}) as Partial<FakeRemoteLink>;
        if (typeof b.object?.url !== "string" || !b.object.url) return bad({ url: "'url' is required." });
        const list = (live.remoteLinks[key] ??= []);
        // A known `globalId` names the same link again: it is replaced, never doubled.
        const known = typeof b.globalId === "string" && b.globalId ? list.find((l) => l.globalId === b.globalId) : undefined;
        const link: FakeRemoteLink = { id: known?.id ?? live.nextRemoteLinkId++, ...b, object: b.object };
        if (known) list[list.indexOf(known)] = link; else list.push(link);
        return json(known ? 200 : 201, { id: link.id, self: `${PREFIX}/issue/${issue.id}/remotelink/${link.id}` });
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
        const all = query.orderBy === "-created" ? [...issue.comments].reverse() : issue.comments;
        const start = Math.max(0, Number(query.startAt) || 0);
        const size = Math.min(Number(query.maxResults) || 50, 100);
        return json(200, { startAt: start, maxResults: size, total: all.length, comments: all.slice(start, start + size).map((c) => commentObject(c, dc, true)) });
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
        const parentId = (body as { parentId?: string } | undefined)?.parentId;
        if (parentId !== undefined && (dc || !issue.comments.some((x) => x.id === parentId))) return bad({}, ["Parent comment not found."]);
        const c: FakeComment = { id: String(30100 + live.tick), author: myselfFixture.accountId, created: when, updated: when, body: text, ...(parentId ? { parentId } : {}) };
        issue.comments.push(c);
        issue.updated = when;
        return json(201, commentObject(c, dc, true));
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
