/*
 * ClickUp, read over its own API.
 *
 * The second task provider, and the first that lives on the other side of a
 * network. That difference is most of this file: Taskwarrior is a process on
 * this machine that either answers or is not installed, while this can be slow,
 * rate-limited, refused, or simply unreachable because the wifi dropped — and
 * each of those needs a different sentence on screen.
 *
 * A personal token rather than OAuth. OAuth would mean registering an
 * application, a client secret and a redirect the app has to catch, which is a
 * great deal of machinery for a local tool used by the person who owns the
 * token. Personal tokens do not expire, and the exchange is one header.
 *
 * That header is `Authorization: <token>` with NO `Bearer` prefix, which is
 * unusual enough to be worth stating: ClickUp's personal tokens are sent bare,
 * and adding `Bearer` produces a 401 that looks exactly like a wrong token.
 */
import { singleFlight } from "./singleflight.ts";
import { cardIdDigits, mentionsCardId } from "../../shared/cardRef.ts";
import * as Index from "./clickupindex.ts";
import { writesAllowed } from "./clickupviews.ts";
import { secretFor, annotate, redacted, fingerprint } from "./credentials.ts";
import { markdownToDelta, type MentionPerson } from "./clickupDelta.ts";
import type {
  ListMember, TaskReply, ProviderTask, ClickUpUser, ClickUpWorkspace, ListStatus, ListField, ListPlace, TaskDetail,
  CardEvent, CardFieldKind, CardPr } from "../../shared/providers.ts";

const CLICKUP_API = "https://api.clickup.com/api/v2";

/**
 * Test seam, in two forms.
 *
 * The suite calls `__setClickUpBase` because a test must never depend on
 * somebody's real workspace — nor on there being a network at all. The
 * environment variable is the same seam for a running server, so the panel can
 * be driven end to end against a stub before anybody's real token is involved.
 * It is not a feature: ClickUp is not self-hosted, so there is no legitimate
 * reason to point this anywhere else.
 */
let base = process.env.AGENTGLASS_CLICKUP_BASE || CLICKUP_API;
export function __setClickUpBase(url: string | null): void {
  base = url ?? process.env.AGENTGLASS_CLICKUP_BASE ?? CLICKUP_API;
  reset();
}

/*
 * Two limits, because the two calls are not the same shape.
 *
 * `/user` and `/team` are small and answer immediately; if one of those takes
 * eight seconds something is genuinely wrong and saying so quickly is right.
 *
 * The task query is not that. It filters the whole workspace by assignee, and
 * on a real one — measured, not guessed — eight seconds was not enough: the
 * first connection to an actual workspace came back "ClickUp did not answer in
 * time" at exactly 8.00s, which is the shape of our own abort rather than a
 * slow service. A read that is allowed to take twenty seconds and succeeds is
 * better than a fast failure that tells you nothing.
 */
const TIMEOUT_MS = 8_000;
const LIST_TIMEOUT_MS = 25_000;

/**
 * What the last call learned about our budget.
 *
 * ClickUp allows 100 requests a minute on most plans and answers 429 past it,
 * and a 429 is not a thing to discover by hitting it: every response carries
 * `X-RateLimit-Remaining`, so the cheap move is to read it and back off before
 * the wall rather than after. Kept here rather than passed around because it is
 * a property of the token, not of any one call.
 */
let budget: { remaining: number; resetAt: number } | null = null;
export const rateBudget = (): { remaining: number; resetAt: number } | null => budget;

/** Anything under this and we stop making optional calls until the window
 *  turns over. Five, not one: a poll and a click can race, and the click is
 *  the one that must not be the request that gets refused. */
const RESERVE = 5;

export interface CallResult<T> {
  ok: boolean;
  data?: T;
  /** For the person, never a raw body. */
  error?: string;
  /** True when the token was rejected — the one error that means "reconnect"
   *  rather than "try later". */
  unauthorised?: boolean;
  /** True when we were refused for rate, or held back before being refused. */
  throttled?: boolean;
}

/**
 * One call, with every failure turned into a sentence.
 *
 * The `catch` covers the case that matters most on a laptop: no network at all.
 * A thrown fetch and a 500 are the same to the caller — "could not ask" — and
 * neither is allowed to look like "you have no tasks", which is the wrong
 * answer people act on.
 */
async function call<T>(pathname: string, token: string, timeoutMs = TIMEOUT_MS): Promise<CallResult<T>> {
  if (budget && budget.remaining <= RESERVE && Date.now() < budget.resetAt) {
    return { ok: false, throttled: true, error: "Holding off — ClickUp's rate limit is nearly used up" };
  }
  const ctl = new AbortController();
  const kill = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}${pathname}`, {
      // Bare, not `Bearer`. See the note at the top of this file.
      headers: { Authorization: token, "content-type": "application/json" },
      signal: ctl.signal,
    });
    // A MISSING header is not a budget of zero, and this used to say it was:
    // `Number(null)` is 0 and `Number.isFinite(0)` is true, so any response that
    // did not carry the header parked the budget at zero and made the next
    // sixty seconds of calls answer "Holding off — ClickUp's rate limit is
    // nearly used up" without asking anybody. Found by measuring T27: the first
    // poll against a revoked token correctly said "ClickUp refused this token",
    // and the second overwrote it with a rate-limit sentence that was not true
    // and had a different remedy. Real ClickUp always sends the header; a
    // proxy, a captive portal or an error page in front of it does not, and
    // those are exactly the moments the message matters.
    const remainingRaw = r.headers.get("x-ratelimit-remaining");
    const remaining = remainingRaw === null ? NaN : Number(remainingRaw);
    const reset = Number(r.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(remaining)) {
      budget = {
        remaining,
        // The header is unix SECONDS. Treating it as milliseconds would put the
        // reset in 1970 and disable the guard entirely.
        resetAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + 60_000,
      };
    }
    if (r.status === 401 || r.status === 403) {
      return { ok: false, unauthorised: true, error: "ClickUp refused this token" };
    }
    if (r.status === 429) {
      return { ok: false, throttled: true, error: "ClickUp is rate-limiting this token — trying again shortly" };
    }
    if (!r.ok) return { ok: false, error: `ClickUp answered ${r.status}` };
    return { ok: true, data: (await r.json()) as T };
  } catch (e) {
    const aborted = (e as { name?: string })?.name === "AbortError";
    return { ok: false, error: aborted ? "ClickUp did not answer in time" : "Could not reach ClickUp" };
  } finally {
    clearTimeout(kill);
  }
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/**
 * Who this token belongs to.
 *
 * Used to validate a token the moment it is pasted, and that ordering is the
 * point: a token that is stored first and checked later gives a "Connected"
 * badge that turns out to be a lie on the next poll. Either it answers with a
 * user or nothing is saved.
 */
export async function whoAmI(token: string): Promise<CallResult<ClickUpUser>> {
  const r = await call<{ user: { id: number; username: string; email: string } }>("/user", token);
  if (!r.ok) return { ...r, data: undefined };
  const u = r.data?.user;
  if (!u) return { ok: false, error: "ClickUp answered without a user" };
  return { ok: true, data: { id: String(u.id), name: u.username || u.email, email: u.email } };
}

/** The workspaces this token can see. ClickUp calls them teams in the API and
 *  Workspaces everywhere a person looks, so they are Workspaces here. */
export async function workspaces(token: string): Promise<CallResult<ClickUpWorkspace[]>> {
  const r = await call<{ teams: { id: string; name: string }[] }>("/team", token);
  if (!r.ok) return { ...r, data: undefined };
  return { ok: true, data: (r.data?.teams ?? []).map((t) => ({ id: String(t.id), name: t.name })) };
}

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

/** ClickUp's own shape, only the parts that are read. Everything else on a task
 *  is left alone rather than modelled — the same rule tasks.ts follows. */
interface RawTask {
  id: string;
  custom_id?: string | null;
  name: string;
  url?: string;
  status?: { status?: string; type?: string; color?: string; orderindex?: number };
  due_date?: string | number | null;
  date_updated?: string | number | null;
  priority?: { priority?: string } | null;
  tags?: { name?: string }[];
  list?: { id?: string; name?: string } | null;
  assignees?: { id?: string | number; username?: string; initials?: string; color?: string; profilePicture?: string }[];
  locations?: { id?: string; name?: string }[];
  points?: number | null;
  custom_fields?: RawField[];
  time_estimate?: number | null;
  time_spent?: number | null;
  date_created?: string | number | null;
  start_date?: string | number | null;
  subtasks_count?: number;
  dependencies?: { task_id?: string; depends_on?: string; type?: number }[];
}

interface RawField {
  id: string;
  name: string;
  type: string;
  value?: unknown;
  type_config?: { options?: { id: string; name?: string; label?: string; orderindex?: number; color?: string | null }[] };
}

/** ClickUp's epoch-milliseconds-as-a-string, as the local calendar date the
 *  rest of the app speaks. Local, not UTC: a task due at 00:30 Madrid time is
 *  due today to the person reading it, and yesterday to `toISOString`. */
function localDay(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  const ms = Number(v);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const PRIORITY = new Set(["urgent", "high", "normal", "low"]);

/**
 * A sprint's name, minus the dates nobody reads in a column.
 *
 * They arrive as `Sprint 137 (26/7/29 - 26/8/4)`. The number is the part that
 * identifies it in conversation; the range is thirty characters that push the
 * task title off the row. Kept whole when it does not match that shape, because
 * a workspace that names its sprints differently should still see its own name.
 */
function shortSprint(name: string | undefined): string | null {
  if (!name) return null;
  const m = /^([^(]+?)\s*\(/.exec(name);
  return (m?.[1] ?? name).trim() || null;
}

/**
 * Which of a card's lists is the SPRINT.
 *
 * This has to be recognised rather than positioned, and that is the whole
 * lesson. A card in a sprint is a card in two or three lists at once, and they
 * arrive as one flat `locations` array whose order is not stable — measured on
 * a real workspace, the same card answers `['Miscellaneous', 'Sprint 138 …']`
 * from the workspace query and `['Sprint 138 …', 'Miscellaneous']` from its own
 * endpoint. "The first one that is not the primary list" therefore picked
 * whichever happened to be first, and a column headed SPRINT spent its life
 * saying "Miscellaneous" and "Bugs".
 *
 * Two signatures, because ClickUp's own Sprint feature writes both and neither
 * is guaranteed: the name begins with "Sprint", or it ends in the parenthesised
 * date range ClickUp appends when a sprint has dates. Measured on the same
 * workspace: `Sprint 138 (26/8/5 - 26/8/11)` has both and `Sprint 118` has only
 * the first, so requiring the range would have dropped a real sprint.
 *
 * Nothing matching means nothing shown. A list name under a heading that says
 * Sprint is not a near miss, it is a different fact — and the version that
 * guessed is exactly what sent somebody to ClickUp to find out which sprint a
 * card was really in.
 */
const SPRINT_NAMED = /^sprint\b/i;
const SPRINT_DATED = /\(\s*\d{1,4}[/\-.]\d{1,2}[^)]*[–—-][^)]*\)\s*$/;
export const looksLikeSprint = (name: string): boolean => {
  const n = name.trim();
  return !!n && (SPRINT_NAMED.test(n) || SPRINT_DATED.test(n));
};

/** The sprint a card is in, or nothing. Its own list counts: a card can live
 *  directly in a sprint list rather than being added to one. */
export function sprintOf(locations: { name?: string }[] | undefined, listName?: string | null): string | null {
  const names = [...(locations ?? []).map((l) => l.name ?? ""), listName ?? ""];
  return shortSprint(names.find((n) => n && looksLikeSprint(n)));
}

/** Two letters from a name, for a column that has room for two letters. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  return ((parts[0]![0] ?? "") + (parts.length > 1 ? parts[parts.length - 1]![0] ?? "" : "")).toUpperCase();
}

/** A comment as ClickUp sends it. Only the parts we read. */
interface RawComment {
  id: string | number;
  comment?: { type?: string; text?: string; user?: { id?: string | number } }[];
  comment_text?: string;
  /* The three the row draws beside the name: ClickUp sends a picture when the
     person has one and initials in their own colour when they do not. */
  user?: { id?: string | number; username?: string; profilePicture?: string; initials?: string; color?: string };
  date?: string | number;
}

export function toTask(raw: RawTask, myId?: string): ProviderTask {
  const kind = raw.status?.type;
  const assignees = raw.assignees ?? [];
  return {
    id: String(raw.id),
    customId: raw.custom_id ? String(raw.custom_id) : undefined,
    title: raw.name ?? "(untitled)",
    url: raw.url ?? "",
    status: raw.status?.status ?? "",
    statusColor: raw.status?.color || undefined,
    /*
     * ClickUp's status TYPE is the only portable thing about a status.
     *
     * Measured on a real board with seventeen of them: the working states are
     * all `custom` — shaping, in development, code review, blocked — while
     * "ready for deployment", "in staging", "in production", "released" and
     * "won't fix / obsolete" are `done`, and only "completed" is `closed`.
     *
     * That is why `include_closed=false` was not enough on its own and half the
     * list read as finished work: those rows are done to a person and open to
     * the API. Folding `done` in with `closed` here is what lets the panel hide
     * them by default without anybody having to configure a thing.
     */
    statusKind: kind === "done" || kind === "closed" ? "done" : kind === "open" ? "open" : "other",
    priority: PRIORITY.has(raw.priority?.priority ?? "") ? (raw.priority!.priority as ProviderTask["priority"]) : null,
    due: localDay(raw.due_date),
    updated: Number(raw.date_updated) || 0,
    tags: (raw.tags ?? []).map((t) => t.name ?? "").filter(Boolean),
    list: raw.list?.name ?? null,
    listId: raw.list?.id ? String(raw.list.id) : undefined,
    /* Free — it rides on the same response, on every endpoint that returns a
       task — and it is the difference between "this card is in Defects" and
       "this card is in Defects and in the two lists you actually work from". */
    ...(Array.isArray(raw.locations) && raw.locations.length
      ? { alsoIn: raw.locations.map((l) => ({ id: String(l?.id ?? ""), name: String(l?.name ?? "") })).filter((l) => l.id && l.name) }
      : {}),
    assignees: assignees.map((a) => a.username ?? "").filter(Boolean),
    people: assignees.map((a) => ({
      id: a.id != null ? Number(a.id) : undefined,
      name: a.username ?? "",
      initials: a.initials || initialsOf(a.username ?? ""),
      color: a.color || undefined,
      avatar: a.profilePicture || undefined,
      me: myId ? String(a.id ?? "") === myId : undefined,
    })).filter((x) => x.name || x.initials),
    // A sprint is another LIST the card also lives in. `locations` holds those,
    // minus the one it belongs to primarily.
    sprint: sprintOf(raw.locations, raw.list?.name),
    // Resolved here, against the connected account. The browser has no business
    // knowing your ClickUp user id, and a client-side comparison would need it.
    mine: myId ? assignees.some((a) => String(a.id ?? "") === myId) : undefined,
    points: typeof raw.points === "number" ? raw.points : null,
    // Hours, not milliseconds. The API speaks one and people plan in the other.
    estimateHours: raw.time_estimate ? Math.round((Number(raw.time_estimate) / 3_600_000) * 10) / 10 : null,
    spentHours: raw.time_spent ? Math.round((Number(raw.time_spent) / 3_600_000) * 10) / 10 : null,
    created: Number(raw.date_created) || undefined,
    start: localDay(raw.start_date),
    subtasks: typeof raw.subtasks_count === "number" ? raw.subtasks_count : undefined,
    /*
     * ClickUp's dependency rows are directional and both directions arrive on
     * both cards. `type: 1` is "waiting on"; anything else is the other side.
     * Split here rather than at the call site because the field is one array
     * where a reader needs two lists with opposite meanings.
     */
    waitsOn: (raw.dependencies ?? []).filter((d) => d.type === 1 && d.task_id === String(raw.id)).map((d) => d.depends_on).filter(Boolean) as string[],
    blocks: (raw.dependencies ?? []).filter((d) => d.type === 1 && d.depends_on === String(raw.id)).map((d) => d.task_id).filter(Boolean) as string[],
    custom: (raw.custom_fields ?? [])
      .map((f) => ({ id: f.id, name: f.name, ...fieldValue(f) }))
      .filter((f) => f.value),
  };
}

/**
 * A custom field, ready to draw: a value in words, a colour when the workspace gave
 * one, and — the part that was missing — WHAT IT IS.
 *
 * ClickUp answers with raw storage, and the card was rendering it verbatim. Three
 * cells were wrong on every bug card in the workspace this was measured against:
 *
 *   drop_down   the INDEX of the option, so a squad printed "3" (already resolved).
 *   labels      an array of option IDS, so an impacted application printed
 *               `cd6fb8c0-4ee8-…` — a UUID, in a cell whose whole job is a name.
 *   date        milliseconds, so a triage date printed 1783414800000.
 *   users       an array of objects keyed `username`, read as `name` — so the
 *               person who reported the bug printed as nothing at all.
 *
 * `kind` collapses ClickUp's eleven types into the five things a card does
 * differently with a value, because that is the decision the layout has to make: a
 * paragraph goes with the description, a date is formatted where the reader is, a
 * chip gets its colour, a URL is a link. An unknown type answers `text`, which shows
 * the words rather than guessing at a shape.
 */
function fieldValue(f: RawField): { value: string; color?: string; kind: CardFieldKind; at?: number; href?: string } {
  const v = f.value;
  const opts = f.type_config?.options ?? [];
  const optName = (o: { name?: string; label?: string }) => o.name ?? o.label ?? "";
  if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return { value: "", kind: "text" };

  if (f.type === "drop_down") {
    const hit = opts.find((o) => o.orderindex === Number(v) || o.id === String(v));
    const value = hit ? optName(hit) : "";
    return { value, kind: "chip", ...(hit?.color ? { color: hit.color } : null) };
  }

  /* A label field holds option IDs, and the options carry the names and colours. The
     first colour wins for the cell: two labels of different colours in one value is a
     shape the row cannot draw, and a name each is what a reader needs. */
  if (f.type === "labels") {
    const ids = (Array.isArray(v) ? v : [v]).map(String);
    const hits = ids.map((id) => opts.find((o) => o.id === id)).filter(Boolean) as typeof opts;
    const value = hits.map(optName).filter(Boolean).join(", ");
    const color = hits.find((o) => o.color)?.color;
    return { value: value || "", kind: "chip", ...(color ? { color } : null) };
  }

  if (f.type === "date") {
    const at = Number(v);
    if (!Number.isFinite(at) || at <= 0) return { value: "", kind: "text" };
    /* The milliseconds travel; the WORDS are the client's to choose, because a date
       belongs in the reader's locale and this process has no idea where they are. */
    return { value: new Date(at).toISOString(), kind: "date", at };
  }

  if (f.type === "users") {
    const list = Array.isArray(v) ? v : [v];
    const names = list.map((u) => {
      const o = u as { username?: string; name?: string; email?: string };
      return (o?.username || o?.name || o?.email || "").trim();
    }).filter(Boolean);
    return { value: names.join(", "), kind: "people" };
  }

  if (f.type === "url") {
    const href = String(v);
    /* Shown without its scheme and query, which is what makes a row of links
       readable; the whole address is what the press opens. */
    let text = href;
    try { const u = new URL(href); text = `${u.host}${u.pathname}`.replace(/\/$/, ""); } catch { /* not a URL we can shorten */ }
    return { value: text, kind: "url", href };
  }

  if (f.type === "currency" || f.type === "number") {
    return { value: String(v), kind: "number" };
  }

  /* `list_relationship` and `tasks` arrive as arrays of task objects: their names are
     the readable part, and they behave like chips. */
  if (Array.isArray(v)) {
    const names = v.map((x) => (typeof x === "object" && x ? String((x as { name?: string }).name ?? "") : String(x))).filter(Boolean);
    return { value: names.join(", "), kind: "chip" };
  }
  if (typeof v === "object") return { value: String((v as { username?: string; name?: string }).username ?? (v as { name?: string }).name ?? ""), kind: "chip" };

  /* Everything else is words. `text` is a paragraph and `short_text` is a line, and
     the difference decides where the card puts it. */
  return { value: String(v), kind: f.type === "text" ? "text" : "chip" };
}

export interface TaskPage {
  tasks: ProviderTask[];
  /** True when ClickUp returned a full page, so there is more behind it. Said
   *  out loud rather than silently truncated — a list that stops at 100 with no
   *  note reads as "that is all of them". */
  more: boolean;
  /**
   * The statuses SEEN on this page, rather than the ones a list accepts.
   *
   * A workspace-wide query has no single list to ask, and `listMeta` is the
   * wrong question here: the rows came from a dozen lists, and asking each of
   * them costs two calls apiece against a 100-a-minute budget to describe
   * statuses that are mostly the same words. What the page itself carries is
   * enough for the two jobs the panel has — group the rows in workflow order,
   * and offer them as filters — and it costs nothing extra.
   *
   * NOT enough to MOVE a card with: a status this page happens to contain need
   * not exist on the list the card you are looking at lives in. That picker asks
   * the card's own list, on demand.
   */
  statuses: ListStatus[];
}

/**
 * The statuses a batch of rows was actually in, in something like workflow order.
 *
 * `orderindex` is per-list, so across lists it is a hint rather than a truth —
 * but every board numbers its own workflow left to right, so "0" is the column
 * work starts in on all of them and the hint is a good one. Deduplicated by
 * name, keeping the earliest index anyone gave it, and the finished ones are
 * sorted to the end regardless: five kinds of done interleaved with the work is
 * the one ordering that is worse than none.
 */
function statusesSeen(rows: RawTask[]): ListStatus[] {
  const by = new Map<string, ListStatus>();
  for (const r of rows) {
    const name = r.status?.status;
    if (!name) continue;
    const at = Number(r.status?.orderindex);
    const had = by.get(name);
    const orderindex = Number.isFinite(at) ? at : 999;
    if (!had) by.set(name, { status: name, type: r.status?.type ?? "custom", orderindex, color: r.status?.color });
    else if (orderindex < had.orderindex) had.orderindex = orderindex;
  }
  const done = (s: ListStatus) => (s.type === "done" || s.type === "closed" ? 1 : 0);
  return [...by.values()].sort((a, b) => done(a) - done(b) || a.orderindex - b.orderindex || a.status.localeCompare(b.status));
}

/**
 * The tasks assigned to you in one workspace.
 *
 * Filtered server-side by assignee, because the alternative is downloading a
 * workspace. `include_closed` stays off: a done task is not work you owe, and
 * they outnumber the open ones by an order of magnitude within a month.
 */
export async function fetchTasks(
  token: string, workspaceId: string, userId: string, page = 0,
): Promise<CallResult<TaskPage>> {
  /*
   * Measured against a real workspace, not chosen from the documentation.
   *
   *   subtasks + order_by   25.0s   13 tasks
   *   without subtasks      12.5s   13 tasks
   *   without order_by      13.4s   13 tasks
   *   neither               14.6s   13 tasks
   *
   * `subtasks=true` DOUBLED the time and returned not one extra row, so it is
   * gone. `order_by` is kept: it costs nothing measurable and means the first
   * page is the soonest work rather than an arbitrary thirteen — which starts
   * to matter the moment somebody has more than a page of them.
   *
   * Twelve seconds is still slow, and it is ClickUp's floor for this query, not
   * ours: the minimal version is no faster. That is what the cache is for.
   */
  const q = new URLSearchParams({
    page: String(page),
    order_by: "due_date",
    include_closed: "false",
  });
  q.append("assignees[]", userId);
  const r = await call<{ tasks: RawTask[] }>(`/team/${encodeURIComponent(workspaceId)}/task?${q}`, token, LIST_TIMEOUT_MS);
  if (!r.ok) return { ...r, data: undefined };
  const raw = r.data?.tasks ?? [];
  return {
    ok: true,
    data: { tasks: raw.map((t) => toTask(t, userId)), more: raw.length >= 100, statuses: statusesSeen(raw) },
  };
}

/**
 * What has moved on MY cards since a moment in time.
 *
 * The narrow cousin of the query above, and it exists because a notification is
 * a DIFF, not a list. Asking for everything assigned to me costs twelve seconds
 * and returns thirteen rows that are almost always the same thirteen; asking
 * for what changed since the last look costs six and usually returns nothing,
 * which is the answer a poll wants most of the time.
 *
 * `date_updated_gt` is ClickUp's own filter, so the work is done on their side.
 * Measured against a real workspace: 6.0s, 5 rows for a day's worth of change,
 * and it cost 2 of a 10,000-an-hour budget.
 *
 * Closed cards are included here, unlike the list above: "moved to done" is
 * exactly the kind of change worth being told about, and excluding it would
 * make a card vanish rather than finish.
 */
/**
 * How many pages a "what changed" read will walk before giving up.
 *
 * ClickUp answers 100 rows a page and says nothing about how many there are.
 * One page was the whole of this until 2026-09-01, and one page is not enough
 * — measured against the real workspace over the 17 lists behind his saved
 * boards: 32 cards changed in a day, but 178 in a week, of which the poll read
 * the first 100 and never learned about the other 78.
 *
 * The window is "since I last looked", so a day of that is fine and a weekend
 * away is not. Four pages carries a fortnight of his volume; past that the
 * read reports itself short rather than pretending, and pollCards refuses to
 * move its high-water mark. See `truncated`.
 */
const CHANGE_PAGES = 4;

/** A page's worth of ClickUp, and whether there might be more behind it. */
async function changedPages(
  team: string, token: string, accountId: string,
  base: URLSearchParams, extra: [string, string][],
): Promise<CallResult<{ tasks: ProviderTask[]; truncated: boolean }>> {
  const out: ProviderTask[] = [];
  for (let page = 0; page < CHANGE_PAGES; page++) {
    const q = new URLSearchParams(base);
    for (const [k, v] of extra) q.append(k, v);
    q.set("page", String(page));
    const r = await call<{ tasks: RawTask[] }>(`/team/${encodeURIComponent(team)}/task?${q}`, token, LIST_TIMEOUT_MS);
    /* A page that fails after others worked is NOT an answer here, and this is
       the difference between a search and a diff. A search that misses a card
       is a search you run again; a diff that misses one moves the high-water
       mark past it and nobody is ever told. So it says it fell short. */
    if (!r.ok) return out.length
      ? { ok: true, data: { tasks: out, truncated: true } }
      : { ...r, data: undefined };
    const raw = r.data?.tasks ?? [];
    out.push(...raw.map((x) => toTask(x, accountId)));
    /* Short page, no more behind it. ClickUp's page size is 100 and it does not
       say so anywhere in the response, which is why this compares rather than
       reading a total. */
    if (raw.length < 100) return { ok: true, data: { tasks: out, truncated: false } };
  }
  /* Every page came back full: there is very likely more, and this is the case
     the caller must not treat as "I have seen everything since last time". */
  return { ok: true, data: { tasks: out, truncated: true } };
}

export async function changedForMe(sinceMs: number): Promise<CallResult<{ tasks: ProviderTask[]; truncated: boolean }>> {
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "ClickUp is not connected" };
  const me = redacted("clickup");
  if (!me?.workspaceId || !me.accountId) return { ok: false, error: "No ClickUp workspace chosen yet" };
  const q = new URLSearchParams({
    date_updated_gt: String(Math.floor(sinceMs)),
    include_closed: "true",
    order_by: "updated",
  });
  return changedPages(me.workspaceId, token, me.accountId, q, [["assignees[]", me.accountId]]);
}

/* ------------------------------------------------------- searching by text */

/**
 * Text search across the workspace, since ClickUp's API has none.
 *
 * MEASURED first, because the shape of this is decided by one number: a single
 * page of `/team/{id}/task` on his workspace takes **16.6 seconds** and returns
 * a hundred rows. There is no `?query=` on v2 with a personal token — the
 * search in ClickUp's own web app is not an endpoint anybody else can call — so
 * the only honest options were "sweep and filter here" or "nothing".
 *
 * Sweeping every page would be minutes. So this takes the most RECENTLY UPDATED
 * few hundred, which is what a search for "that card I was just looking at"
 * actually wants, keeps them for ten minutes, and filters in memory. The panel
 * says which of the two it is showing — what is on the board, instantly, and
 * what came out of this, after a wait it warned about.
 */
const SWEEP_PAGES = 3;
/** How long a sweep that lost a page is allowed to stand in for a whole one. */
const PARTIAL_TTL_MS = 45_000;
const SWEEP_TTL_MS = 10 * 60_000;
/* The sweep WITH bodies is the expensive one — 21 seconds for a page of a
   hundred cards against the real workspace, measured — and a card's body is
   also the thing that changes least. Half an hour of it is the difference
   between a search that is instant most of the time and one that is never
   instant. */
const SWEEP_BODIES_TTL_MS = 30 * 60_000;
/**
 * Two caches, because they hold different things.
 *
 * The plain sweep is what every text search uses. The other carries each
 * card's BODY, which is what finding "who mentions ORBIT-1042" needs and what
 * nothing else does — so it is fetched only for a query shaped like a card id,
 * and kept apart rather than replacing the cheap one. One slot would mean an
 * id search poisons the next text search into paying for bodies it will not
 * read, or a text search throws away bodies an id search just paid for.
 */
/**
 * HOW FAR BACK A SWEEP REACHED, which is the number nobody had.
 *
 * `SWEEP_PAGES = 3` is 300 cards, and 300 cards is not an amount of workspace
 * — it is an amount of TIME, and how much depends entirely on how busy the
 * place is. Measured against the real one on 2026-09-01, walking the pages by
 * hand: page 7 was still full, so there are more than 800 cards to walk, and
 * the 300th was updated THE SAME DAY. "Search the workspace" means "search
 * what was touched today" there, and it answered "nothing in the last 300
 * cards" — which reads as "it does not exist".
 *
 * So the sweep records the oldest card it saw and whether it stopped because
 * it ran out of cards or because it ran out of pages. A caller can then say
 * which window it searched instead of a card count nobody can convert.
 */
interface Reach {
  /** `date_updated` of the oldest card in the sweep, epoch ms. */
  oldest: number;
  /** The last page came back full: there is more behind the cap. */
  capped: boolean;
}
let sweep: { at: number; tasks: ProviderTask[]; reach: Reach } | null = null;
let sweepBodies: { at: number; tasks: SweptTask[]; reach: Reach } | null = null;

/** A swept card plus the text of its description, which never leaves this
 *  process: the panel is sent matches, not bodies. */
type SweptTask = ProviderTask & { body?: string };

/** Test seam, and the button in the panel: forget what was fetched. */
export function __clearSearchCache(): void { sweep = null; sweepBodies = null; }

async function sweepWorkspace(
  force = false, withBodies = false,
  /* Told about each page as it lands. The sweep is three sequential pages and
     it used to answer only when all three were in — forty seconds of nothing
     for a reader who could have been looking at the first ten matches after
     twelve. A held cache still answers in one go, which is the fast path. */
  onPage?: (tasks: SweptTask[], page: number) => void,
  /* `partial` rides alongside rather than inside `CallResult`: it is not a
     failure — the answer is usable — it is a caveat about how much of the
     workspace it covers, and only this function's callers can act on it. */
): Promise<CallResult<SweptTask[]> & { partial?: boolean; reach?: Reach }> {
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "ClickUp is not connected" };
  const me = redacted("clickup");
  if (!me?.workspaceId) return { ok: false, error: "No ClickUp workspace chosen yet" };
  const held = withBodies ? sweepBodies : sweep;
  const fresh = held && Date.now() - held.at < (withBodies ? SWEEP_BODIES_TTL_MS : SWEEP_TTL_MS);
  if (fresh && !force) return { ok: true, data: held!.tasks, reach: held!.reach };
  const out: SweptTask[] = [];
  /* Held in a local: inside the callback below, TypeScript no longer knows the
     guard above ruled out `undefined`. */
  const team = me.workspaceId;
  /*
   * THE PAGES AT THE SAME TIME.
   *
   * They were read one after another, and with bodies each one takes about
   * twenty seconds — so three pages was a minute of waiting for an answer the
   * first of them usually holds. They do not depend on each other: page 2 is
   * page 2 whatever page 1 said. What is lost is the early exit when a page
   * comes back short, which costs two requests against a small workspace and
   * saves forty seconds against a large one.
   */
  const pages = await Promise.all(
    Array.from({ length: SWEEP_PAGES }, (_unused, page) => {
    const q = new URLSearchParams({
      page: String(page),
      /*
       * THE NEWEST CARDS, WHICH IS NOT WHAT THIS ASKED FOR.
       *
       * `reverse: "true"` reads like "newest first" and is the opposite.
       * Measured against the real workspace on 2026-09-01: with it, page 0
       * opens on a card last touched in JUNE 2022, and three pages of sweep
       * cover the three hundred OLDEST cards in a workspace of thousands —
       * client records nobody has opened in four years. Without it, page 0
       * opens on a card updated today.
       *
       * So every "search the workspace" ever run here searched the wrong end
       * of it. It surfaced when a card that plainly mentions another by id
       * came back with nothing: 38 cards carry that id, and not one of them
       * was inside the slice being swept.
       */
      order_by: "updated",
      include_closed: "true",
      subtasks: "true",
      /* ClickUp's v2 API has no text search at all, so the body has to be
         carried here or not looked at. Asked for only when the query is a card
         id: it makes every page of the sweep considerably larger, and this
         sweep is already the slowest thing the panel does. */
      ...(withBodies ? { include_markdown_description: "true" } : {}),
    });
      /*
       * A LONGER DEADLINE FOR THE HEAVY ONE, because three of them at once are
       * slower than three in a row.
       *
       * Measured after making the pages parallel: with bodies, the sweep came
       * back having scanned 100 cards instead of 300 — pages 1 and 2 had hit
       * the 25s deadline while page 0 used the connection. The answer is not
       * to go back to waiting a minute; it is to let the slow ones finish.
       */
      return call<{ tasks: RawTask[] }>(
        `/team/${encodeURIComponent(team)}/task?${q}`, token,
        withBodies ? LIST_TIMEOUT_MS * 3 : LIST_TIMEOUT_MS,
      );
    }),
  );
  // A page that fails when others worked is still an answer: better a partial
  // search that says so than a minute and an error.
  if (pages.every((r) => !r.ok)) return { ...pages[0]!, data: undefined };
  /* "That says so" — and until now nothing did. A sweep missing a page came
     back looking exactly like a complete one, was stored in the cache as
     complete, and answered every question for the next ten minutes from a
     third of the workspace. `scanned` was the only hint and it reads as "the
     workspace is small". */
  const missed = pages.filter((r) => !r.ok).length;
  let oldest = Number.POSITIVE_INFINITY;
  /* The cap bit if the LAST page came back full. A short page means the
     workspace ran out first, which is the only case where "everything" is
     honest. */
  const last = pages.at(-1);
  const capped = !!last?.ok && (last.data?.tasks?.length ?? 0) >= 100;
  for (const r of pages) {
    if (!r.ok) continue;
    const raw = r.data?.tasks ?? [];
    for (const x of raw) {
      const ms = Number((x as { date_updated?: string }).date_updated);
      if (Number.isFinite(ms) && ms > 0 && ms < oldest) oldest = ms;
    }
    const mapped = raw.map((t) => {
      const task: SweptTask = toTask(t, me.accountId);
      /* Both spellings: `markdown_description` is what the flag above adds,
         `description` is the plain text ClickUp sends anyway on some shapes.
         Kept on the server's copy only. */
      if (withBodies) {
        const body = (t as { markdown_description?: string; description?: string });
        const text = body.markdown_description || body.description || "";
        if (text) task.body = text;
      }
      return task;
    });
    out.push(...mapped);
    /* Written down as it is read: a sweep that takes 45 seconds is already
       useful to the next question after its first page. */
    Index.remember(mapped);
    onPage?.(mapped, out.length);
  }
  /* A PARTIAL SWEEP IS NOT CACHED FOR TEN MINUTES.
     Held long enough that the three questions somebody asks in a row are still
     one fetch, and not so long that a single slow page decides what the
     workspace contains until the next coffee. */
  const at = missed ? Date.now() - (withBodies ? SWEEP_BODIES_TTL_MS : SWEEP_TTL_MS) + PARTIAL_TTL_MS : Date.now();
  const reach: Reach = { oldest: Number.isFinite(oldest) ? oldest : 0, capped };
  if (withBodies) sweepBodies = { at, tasks: out, reach };
  else sweep = { at, tasks: out, reach };
  return { ok: true, data: out, partial: missed > 0, reach };
}

/** Every word has to be in the title or the id somewhere. Not a fuzzy match:
 *  this is a list somebody is scanning, and a fuzzy hit they cannot see the
 *  reason for reads as noise. */
export function matchesText(t: Pick<ProviderTask, "title" | "customId" | "id" | "list">, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const hay = `${t.title} ${t.customId ?? ""} ${t.id} ${t.list ?? ""}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * Text search, and — when the text is a card id — who REFERS to that card.
 *
 * "if I search 1042 or ORBIT-1042 I should get not only that card but also
 * the ones that refer to that card". His example is real:
 * ORBIT-2077's body links ORBIT-1042 under "How this was found", and until now
 * nothing here could see it — `matchesText` reads the title, the ids and the
 * list, and the body was never even fetched.
 *
 * The body is fetched only for a query shaped like a card id. That is the
 * whole reason this branches: the sweep was measured at sixteen seconds on his
 * workspace WITHOUT bodies, and asking for them makes every page bigger. A
 * search for "pagination arrows" gains nothing from them, so it does not pay.
 *
 * A reference is a card id in prose, not a bare number — see `mentionsCardId`.
 * Matching `1042` alone would return every card whose body holds those four
 * digits in a date, a count or a hash.
 *
 * The card itself is not excluded from the answer. It matches on its own id
 * through `matchesText` and belongs at the top of a list of "everything about
 * this card"; the panel is what decides whether to also jump to it.
 */
/**
 * The same search, reported as it goes.
 *
 * "at least show me what it finds as it goes, no?" — and the sweep is
 * three sequential pages of a workspace with thousands of cards, so the
 * difference between answering per page and answering at the end is the
 * difference between a list that fills and a spinner. Matching runs on each
 * page as it lands; the caller decides what to do with a partial answer.
 *
 * A cached sweep skips all of it and calls `onSome` once, which is what makes
 * a repeat search feel instant.
 */
/**
 * Read the expensive half of the search before anybody asks for it.
 *
 * Measured on the real workspace: three hundred cards WITH their bodies take
 * about 45 seconds, and the same search a minute later takes 24ms. So the
 * whole difference between "this is instant" and "this is unusable" is whether
 * somebody paid for the read already — and nobody wants to be the one who
 * pays. Called when the board is opened, in the background, and it does
 * nothing at all when the sweep is still warm.
 *
 * Never awaited by a route. Failures are silent on purpose: this is a
 * convenience, and a warm-up that reports an error is a warm-up that has
 * become somebody's problem.
 */
export function warmBodySweep(): void {
  if (!secretFor("clickup")) return;
  if (sweepBodies && Date.now() - sweepBodies.at < SWEEP_BODIES_TTL_MS) return;
  void sweepWorkspace(false, true).catch(() => { /* the search will do it */ });
}

export async function searchTasksStream(
  q: string, force: boolean,
  onSome: (tasks: ProviderTask[]) => void,
): Promise<CallResult<{ scanned: number; refs: number; partial: boolean; since?: number; capped?: boolean }>> {
  const text = String(q ?? "").trim();
  if (text.length < 2) return { ok: false, error: "type at least two characters" };
  const digits = cardIdDigits(text);
  const seen = new Set<string>();
  const referring: SweptTask[] = [];
  const say = (rows: SweptTask[]) => {
    const fresh = rows.filter((t) => !seen.has(t.id));
    for (const t of fresh) seen.add(t.id);
    if (fresh.length) onSome(fresh.map(({ body: _b, ...t }) => t));
  };

  /*
   * THE INDEX FIRST, BEFORE ANY NETWORK AT ALL.
   *
   * Everything a previous sweep read is on this machine, bodies included, so
   * the first answer is a local query — milliseconds, cold or warm. The sweeps
   * below still run: the index knows what it has seen, not what is true, and
   * whatever it missed arrives a moment later through the same callback.
   */
  try {
    say(Index.named(text));
    if (digits !== null) say(Index.mentioning(digits));
  } catch { /* an index that cannot be read is a slower search, not a broken one */ }

  /*
   * THE CHEAP HALF FIRST.
   *
   * A page of a hundred cards WITH their bodies took 21 seconds against the
   * real workspace; without them it is a couple. Title and id matches need no
   * body at all, so they are asked for on the light sweep and are on screen
   * while the heavy one is still reading — and the light sweep is the one the
   * board already keeps warm, so most of the time it costs nothing.
   */
  const light = await sweepWorkspace(force, false, (page) => say(page.filter((t) => matchesText(t, text))));
  if (light.ok && light.data) say(light.data.filter((t) => matchesText(t, text)));
  /* Nothing else to look for: mentions live in bodies, and a query that is not
     a card id has none to look for. */
  if (digits === null) return { ok: true, data: {
    scanned: light.data?.length ?? 0, refs: 0, partial: light.partial === true,
    /* The window this answer covers, in time. A card count is not something a
       reader can convert into "did it look at last week". */
    ...(light.reach ? { since: light.reach.oldest, capped: light.reach.capped } : {}),
  } };

  const r = await sweepWorkspace(force, true, (page) => {
    /* The card itself first, then whoever points at it — the same order the
       whole-answer version uses, applied one page at a time. */
    say(page.filter((t) => matchesText(t, text)));
    const refs = page.filter((t) => !seen.has(t.id) && mentionsCardId(t.body ?? "", digits));
    referring.push(...refs);
    say(refs);
  });
  if (!r.ok || !r.data) return { ...r, data: undefined };
  /* A cache hit never went through the callback: the whole answer is here. */
  if (!seen.size) {
    const named = r.data.filter((t) => matchesText(t, text));
    say(named);
    if (digits !== null) {
      const refs = r.data.filter((t) => !seen.has(t.id) && mentionsCardId(t.body ?? "", digits));
      referring.push(...refs);
      say(refs);
    }
  }
  return { ok: true, data: {
    scanned: r.data.length, refs: referring.length, partial: r.partial === true,
    ...(r.reach ? { since: r.reach.oldest, capped: r.reach.capped } : {}),
  } };
}

export async function searchTasks(q: string, force = false): Promise<CallResult<{ tasks: ProviderTask[]; scanned: number; at: number; refs?: number; partial?: boolean; since?: number; capped?: boolean; more?: boolean }>> {
  const text = String(q ?? "").trim();
  if (text.length < 2) return { ok: false, error: "type at least two characters" };
  const digits = cardIdDigits(text);
  const r = await sweepWorkspace(force, digits !== null);
  if (!r.ok || !r.data) return { ...r, data: undefined };
  const named = r.data.filter((t) => matchesText(t, text));
  const referring = digits === null ? [] : r.data.filter((t) =>
    !named.some((n) => n.id === t.id) && mentionsCardId(t.body ?? "", digits));
  /* The card first, then who points at it. Both are answers to "1042"; only
     one of them is the card, and it is the one the reader asked for by name. */
  const all = [...named, ...referring];
  /* Sixty is a screenful and then some, and a list that stops at sixty without
     saying so is a list that claims there were sixty. */
  const SHOWN_MAX = 60;
  const tasks = all.slice(0, SHOWN_MAX);
  return {
    ok: true,
    data: {
      tasks: tasks.map(({ body: _b, ...t }) => t),
      scanned: r.data.length,
      at: (digits !== null ? sweepBodies?.at : sweep?.at) ?? Date.now(),
      ...(digits === null ? {} : { refs: referring.length }),
      /* Only when true. "Nothing matched" and "nothing matched in the part of
         the workspace I could reach" are different sentences, and the panel
         cannot tell them apart from a count. */
      ...(r.partial ? { partial: true } : {}),
      ...(r.reach ? { since: r.reach.oldest, capped: r.reach.capped } : {}),
      /* Only when it bit. A flag that is always there stops being read. */
      ...(all.length > SHOWN_MAX ? { more: true } : {}),
    },
  };
}

/**
 * What has moved on the boards you follow, whoever it belongs to.
 *
 * The companion to `changedForMe`, and it exists for one case that one cannot
 * see: somebody mentioning you on a card that is not yours. Scoped to the lists
 * behind your saved boards rather than the whole workspace — a company's
 * workspace moves constantly and none of it is yours to be told about.
 *
 * Measured on a real board: one card moved in the last hour. So this is a call
 * that almost always answers "nothing", which is what makes asking every few
 * minutes reasonable.
 */
export async function changedOnLists(sinceMs: number, listIds: string[]): Promise<CallResult<{ tasks: ProviderTask[]; truncated: boolean }>> {
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "ClickUp is not connected" };
  const me = redacted("clickup");
  /* `accountId` is in the guard because `toTask` needs it to mark a card as
     yours, and an unmarked card reads as somebody else's on every surface. */
  if (!me?.workspaceId || !me.accountId || !listIds.length) return { ok: true, data: { tasks: [], truncated: false } };
  const q = new URLSearchParams({ date_updated_gt: String(Math.floor(sinceMs)), include_closed: "true" });
  /* The busiest of the two reads by a long way: it watches every list behind a
     saved board rather than one person's cards. Measured on his: 32 changed in
     a day against 178 in a week — the one that overflows a page first. */
  return changedPages(me.workspaceId, token, me.accountId, q, listIds.map((l) => ["list_ids[]", l]));
}

/**
 * The comments on one card, newest first, as ClickUp returns them.
 *
 * A mention is not a string match. It arrives as a block of its own —
 * `{ type: "tag", user: { id } }` — so "somebody mentioned ME" is an id
 * comparison rather than a guess at a name, which matters on a workspace with
 * two people called Ada in it.
 *
 * Cheap, measured: about 300ms. That is what makes per-card polling viable at
 * all, and it is only ever asked of cards a cheaper query already said had
 * moved — a comment bumps the card's `date_updated`, verified against real
 * cards where the two timestamps match to the minute.
 */
export interface CardComment {
  id: string;
  who: string;
  /** The commenter's ClickUp id, so our own comments can be left out. */
  whoId: string;
  text: string;
  at: number;
  /** Ids mentioned with an `@` inside the comment. */
  mentions: string[];
}

export async function commentsOn(taskId: string): Promise<CallResult<{ comments: CardComment[] }>> {
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "ClickUp is not connected" };
  const r = await call<{ comments?: RawComment[] }>(`/task/${encodeURIComponent(taskId)}/comment`, token);
  if (!r.ok) return { ...r, data: undefined };
  const comments = (r.data?.comments ?? []).map((c) => ({
    id: String(c.id),
    who: c.user?.username ?? "Somebody",
    whoId: String(c.user?.id ?? ""),
    text: (c.comment_text ?? "").trim(),
    at: Number(c.date) || 0,
    mentions: (c.comment ?? [])
      .filter((b) => b.type === "tag" && b.user?.id != null)
      .map((b) => String(b.user!.id)),
  }));
  return { ok: true, data: { comments } };
}

/**
 * Every page of it, up to a point.
 *
 * Three pages, not the ten a view is allowed. The cap is not about the rows, it
 * is about the clock: a view answers a page in about a second, and this query
 * takes twelve — so following ten pages would be two minutes of somebody
 * watching a spinner to find out they have more than three hundred open cards
 * assigned to them, which they already knew. Three is past any real inbox and
 * the truncation is said out loud rather than hidden.
 */
const ASSIGNED_MAX_PAGES = 3;

export async function assignedTasks(
  token: string, workspaceId: string, userId: string,
): Promise<CallResult<{ tasks: ProviderTask[]; statuses: ListStatus[]; truncated: boolean }>> {
  const out: ProviderTask[] = [];
  const seen: ListStatus[] = [];
  for (let page = 0; page < ASSIGNED_MAX_PAGES; page++) {
    const r = await fetchTasks(token, workspaceId, userId, page);
    // A page that failed after some already arrived is a short answer, not no
    // answer — the same call the view reader makes.
    if (!r.ok || !r.data) {
      return out.length ? { ok: true, data: { tasks: out, statuses: statusMerge(seen), truncated: true } } : { ...r, data: undefined };
    }
    out.push(...r.data.tasks);
    seen.push(...r.data.statuses);
    if (!r.data.more) return { ok: true, data: { tasks: out, statuses: statusMerge(seen), truncated: false } };
  }
  return { ok: true, data: { tasks: out, statuses: statusMerge(seen), truncated: true } };
}

/** The same dedupe `statusesSeen` does, applied across pages. */
function statusMerge(all: ListStatus[]): ListStatus[] {
  const by = new Map<string, ListStatus>();
  for (const s of all) {
    const had = by.get(s.status);
    if (!had) by.set(s.status, { ...s });
    else if (s.orderindex < had.orderindex) had.orderindex = s.orderindex;
  }
  const done = (s: ListStatus) => (s.type === "done" || s.type === "closed" ? 1 : 0);
  return [...by.values()].sort((a, b) => done(a) - done(b) || a.orderindex - b.orderindex || a.status.localeCompare(b.status));
}

// ---------------------------------------------------------------------------
// the cached view the panel reads
// ---------------------------------------------------------------------------

export interface ClickUpSnapshot {
  at: number;
  tasks: ProviderTask[];
  more: boolean;
  /** Present when the LAST attempt failed. The tasks are still whatever we last
   *  saw, deliberately: a network blip must not empty somebody's list, because
   *  an empty list is read as "nothing to do" and acted on. */
  error?: string;
  unauthorised?: boolean;
}

let snap: ClickUpSnapshot | null = null;
const TTL_MS = 60_000;

export function __reset(): void { snap = null; budget = null; }
const reset = __reset;

/**
 * The list, at most once a minute however many callers ask.
 *
 * One minute against a 100-per-minute budget leaves 99 for everything a person
 * actually clicks, and a task list that is 60 seconds stale has never been the
 * problem — the same trade `tasks.ts` makes for its own store.
 */
/**
 * What we already know, without going and asking.
 *
 * `clickupTasks()` fetches when its cache is cold, and ClickUp's own floor for
 * that query is ten to twelve seconds — measured, and documented on
 * fetchTasks(). That is the right trade for the panel that exists to show the
 * list. It is the wrong one for a caller that only wants to know whether the
 * token works, because it makes that caller wait ten seconds for an answer it
 * was not asking for.
 *
 * Returns null when there is nothing cached, and asks for nothing. A getter
 * that quietly starts a network call is a getter whose caller cannot reason
 * about what it costs — and in the test suite it was a request arriving in the
 * middle of an unrelated test's page count. Warming the cache is the caller's
 * decision, made where the caller can see it: see `/providers`.
 */
export function clickupCached(): ClickUpSnapshot | null {
  return snap;
}

export async function clickupTasks(force = false): Promise<ClickUpSnapshot> {
  if (!force && snap && Date.now() - snap.at < TTL_MS) return snap;
  return singleFlight("clickup:tasks", async () => {
    if (!force && snap && Date.now() - snap.at < TTL_MS) return snap;
    const token = secretFor("clickup");
    if (!token) {
      snap = { at: Date.now(), tasks: [], more: false, error: "ClickUp is not connected" };
      return snap;
    }
    const { workspaceId, userId } = await identity(token);
    if (!workspaceId || !userId) {
      snap = {
        at: Date.now(), tasks: snap?.tasks ?? [], more: false,
        error: "Could not work out which ClickUp workspace to read",
      };
      return snap;
    }
    const r = await fetchTasks(token, workspaceId, userId);
    if (!r.ok) {
      // Keep what we had. See ClickUpSnapshot.error.
      snap = {
        at: Date.now(), tasks: snap?.tasks ?? [], more: snap?.more ?? false,
        error: r.error, unauthorised: r.unauthorised,
      };
      return snap;
    }
    snap = { at: Date.now(), tasks: r.data!.tasks, more: r.data!.more };
    return snap;
  });
}

/**
 * The workspace and user to read for, resolved once and remembered.
 *
 * Stored on the credential rather than asked every poll: it costs two calls to
 * work out and never changes for a given token. The first successful connect
 * writes it; this is the fallback for a credential written before that, and for
 * one whose workspace was cleared.
 */
export async function identity(token: string): Promise<{ workspaceId?: string; userId?: string }> {
  const { redacted } = await import("./credentials.ts");
  const known = redacted("clickup");
  if (known?.workspaceId && known.accountId) return { workspaceId: known.workspaceId, userId: known.accountId };
  const me = await whoAmI(token);
  if (!me.ok || !me.data) return {};
  const ws = await workspaces(token);
  const first = ws.data?.[0];
  if (!first) return {};
  annotate("clickup", {
    account: me.data.name, accountId: me.data.id,
    workspace: first.name, workspaceId: first.id, verifiedAt: Date.now(),
  });
  return { workspaceId: first.id, userId: me.data.id };
}

/** For a log line that needs to name a token without printing one. */
export const tokenLabel = (): string => fingerprint(secretFor("clickup") ?? "");

// ---------------------------------------------------------------------------
// views, pasted rather than navigated
// ---------------------------------------------------------------------------

/**
 * The identifiers inside a ClickUp address.
 *
 * Deliberately matched on the PATH and not the host. Two reasons, and only one
 * of them is about this repository: the shape `/{workspace}/v/{kind}/{id}` is
 * the stable part — ClickUp serves the same app from more than one hostname and
 * has changed which one it prefers — and a matcher anchored to a hostname would
 * quietly stop working the day that changes. The host is checked separately,
 * loosely, for the domain rather than the subdomain.
 *
 * The `kind` segment says what you pasted: `l` is a view, `li` a bare list, and
 * `b`, `gantt`, `cal` and friends are views too. A view id carries hyphens
 * (`6-901700123456-1`); the number in the middle of one is the LIST behind it,
 * which is worth having because a list knows its own statuses and a view does
 * not. Verified against a real board: the full hyphenated string resolves,
 * the middle number alone 404s as a view and 200s as a list.
 */
export interface ParsedViewUrl {
  workspaceId?: string;
  kind: "view" | "list" | "assigned";
  viewId?: string;
  listId?: string;
}

const VIEW_PATH = /\/(\d+)\/v\//i;
/** What an id actually looks like, so a stray path segment cannot be mistaken
 *  for one. A list is digits; a view is `6-901700123456-1`. */
const LIST_ID = /^\d{6,}$/;
const VIEW_ID = /^\d+-\d{6,}-\d+$/;
/*
 * THE OTHER VIEW ID, and it is the common one.
 *
 * `dm84m-3308037` — a short workspace-wide prefix, a hyphen, digits. The
 * pattern above only knew `6-901700123456-1`, so every address of this shape
 * fell through the parser and was refused as "that does not look like a
 * ClickUp board address". Which it plainly was: it is what the browser's own
 * bar shows when you open a list.
 *
 * I first measured this as a 404 and wrote a whole branch on the strength of
 * it — "an id the web understands and the API does not". That was wrong. The
 * API answers 200 for it, three times out of three, and returns the view. The
 * first reading was a false negative I did not repeat before building on it.
 *
 * The prefix is per workspace rather than per view, so nothing here can check
 * it beyond its shape — which is fine: the id is resolved against ClickUp
 * before anything is saved, and that is the check that matters.
 */
const SLUG_VIEW_ID = /^[a-z0-9]{3,12}-\d{4,}$/i;
/**
 * The My Work page, which is the one address with nothing in it to resolve.
 *
 * `https://example.clickup.com/9000001/my-work/tasks` names no view and no list —
 * it is a question ("what is assigned to me"), not a place — so the resolver
 * could only ever refuse it, and refusing the page somebody is most likely to
 * paste is the wrong answer to give them. Recognised here and answered with the
 * built-in board instead.
 */
const MY_WORK_PATH = /\/(\d+)\/my-work(\/|$)/i;

export function parseViewUrl(raw: string): ParsedViewUrl | null {
  const text = (raw || "").trim();
  if (!text) return null;

  // A bare id, pasted on its own. Checked BEFORE the URL parse, because
  // `new URL("https://6-901700123456-1")` is a perfectly valid URL whose host
  // is that string — so an id would be judged as coming from the wrong domain
  // and thrown away.
  if (!text.includes("/") && /^\d+-\d{6,}-\d+$/.test(text)) {
    return { kind: "view", viewId: text, listId: text.split("-")[1] };
  }
  /* A LIST id on its own. The picker sends one when somebody clicks a list
     that sits directly in a space: there is no address to build for it that
     would not be this id with ceremony around it. */
  if (!text.includes("/") && LIST_ID.test(text)) return { kind: "list", listId: text };
  /* And the slug view id, pasted bare — same reasoning as the shape above. */
  if (!text.includes("/") && SLUG_VIEW_ID.test(text)) return { kind: "view", viewId: text };

  let host = "", path = text;
  try {
    const u = new URL(text.startsWith("http") ? text : `https://${text}`);
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    // Not a URL — maybe somebody pasted just the path, or just an id.
  }
  // The domain, not the subdomain. Anything else is not ours to interpret.
  // The `.` matters: a bare endsWith("clickup.com") also accepts
  // `notclickup.com` and `evilclickup.com`, which are somebody else's hosts.
  if (host && host !== "clickup.com" && !host.endsWith(".clickup.com")) return null;

  const mine = MY_WORK_PATH.exec(path);
  if (mine) return { workspaceId: mine[1], kind: "assigned" };

  const m = VIEW_PATH.exec(path);
  if (m) {
    const [, workspaceId] = m as unknown as [string, string];
    /*
     * Walk to the id rather than assume it is the next segment.
     *
     * Reported from a real paste: `/9000001/v/l/li/901700654321` — an `l` AND
     * an `li`, two kind tokens in a row, which happens when somebody stitches an
     * address together from two of ClickUp's own forms. Taking "whatever follows
     * the kind" made the id the literal string `li`, and the panel then reported
     * "ClickUp answered 404" for an address whose real id was sitting one
     * segment further along, untouched.
     *
     * So the id is RECOGNISED — digits for a list, `6-901700123456-1` for a view
     * — and anything before it that is not one is treated as another kind token.
     * The last kind seen wins, because that is the one nearest the thing it
     * describes.
     */
    const segs = path.split("/").filter(Boolean);
    const at = segs.findIndex((x) => x.toLowerCase() === "v");
    let kind = "";
    let id = "";
    for (let i = at + 1; i < segs.length; i++) {
      const seg = segs[i]!;
      if (LIST_ID.test(seg) || VIEW_ID.test(seg) || SLUG_VIEW_ID.test(seg)) { id = seg; break; }
      if (/^[a-z]+$/i.test(seg)) kind = seg.toLowerCase();
    }
    if (!id) return null;
    if (kind === "li") return { workspaceId, kind: "list", listId: id };
    /* The slug form carries no list id inside it — `dm84m-3308037` is one
       view, not a view within a list — so it goes straight through and the
       split below is only for the older three-part shape. */
    if (SLUG_VIEW_ID.test(id) && !VIEW_ID.test(id)) return { workspaceId, kind: "view", viewId: id };
    // A view id looks like `6-901700123456-1`; the middle segment is the list.
    const parts = id.split("-");
    const listId = parts.length >= 2 && LIST_ID.test(parts[1]!) ? parts[1] : undefined;
    // Digits alone under a view kind is a list id however it was labelled —
    // there is no view whose id is bare digits.
    if (!listId && LIST_ID.test(id)) return { workspaceId, kind: "list", listId: id };
    return { workspaceId, kind: "view", viewId: id, listId };
  }
  return null;
}

/** What ClickUp calls this view, so a saved entry is named by the service
 *  rather than by whoever pasted the link. */
export async function viewMeta(token: string, viewId: string): Promise<CallResult<{ name: string; type: string; listId?: string }>> {
  /* `parent` names what the view hangs off — for a view inside a list, that is
     the list. The slug form of a view id carries no list inside it, so this is
     the only way to learn which list a pasted view belongs to, and without it
     the board has no statuses, no custom fields and no colour. */
  const r = await call<{ view?: { name?: string; type?: string; parent?: { id?: string; type?: number } } }>(
    `/view/${encodeURIComponent(viewId)}`, token,
  );
  if (!r.ok) return { ...r, data: undefined };
  const v = r.data?.view;
  if (!v) return { ok: false, error: "ClickUp did not recognise that view" };
  /* type 6 is a list. Anything else — a folder view, a space view — has no
     single list behind it and must not claim one. */
  const listId = v.parent?.type === 6 && v.parent.id ? String(v.parent.id) : undefined;
  return { ok: true, data: { name: v.name || "Untitled view", type: v.type || "list", ...(listId ? { listId } : {}) } };
}


/**
 * A ClickUp comment, as markdown.
 *
 * ClickUp stores a comment the way its editor works — a Quill delta: a flat run
 * of `{ text, attributes }` pieces where the ATTRIBUTES OF A LINE live on the
 * piece whose text is the newline that ends it. Reading only `text` and joining
 * it, which is what this did, throws every one of those away: a comment that in
 * a browser is a heading, three bold bullets and a fenced block of test output
 * arrived here as one grey paragraph, and the block of output — the evidence
 * the comment was written to carry — was indistinguishable from the prose
 * around it.
 *
 * Measured against a real comment rather than inferred from Quill's docs. The
 * whole vocabulary that card used:
 *
 *   {"bold":true} {"italic":true} {"code":true} {"bold":true,"code":true}
 *   {"header":2} {"header":3}
 *   {"list":{"list":"bullet"}} {"list":{"list":"ordered"}}
 *   {"code-block":{"code-block":"css"}}
 *
 * `link` is handled too — it is the one common attribute that card happened not
 * to use, and dropping a URL is the same class of loss as dropping a fence.
 *
 * Markdown rather than HTML for the same reason `tableMarkdown` chose it: the
 * panel already renders markdown for descriptions, so this arrives through a
 * path that is already styled, already sanitised and already scrolls a wide
 * table sideways.
 */
interface DeltaBlock {
  text?: string;
  /** ClickUp types a few pieces instead of attributing them. `divider` is the
   *  one that matters: its text is already `---`, but it is a LINE of its own
   *  and carries no newline, so without this it welds itself to whatever the
   *  author wrote under the rule. */
  type?: string;
  attributes?: {
    bold?: boolean; italic?: boolean; code?: boolean; link?: string;
    header?: number;
    list?: { list?: string };
    "code-block"?: { "code-block"?: string };
    blockquote?: boolean;
  };
  "table-embed"?: { rows?: unknown[]; columns?: unknown[]; cells?: Record<string, { content?: { insert?: unknown }[] }> };
}

/**
 * Text that will survive being read as markdown.
 *
 * A run with no attributes is LITERAL — somebody typed `src/**\/*.py` or
 * `a_b_c` and meant those characters. Emitting them into a markdown document
 * unescaped is how a file glob becomes an italic run that swallows the rest of
 * the sentence.
 *
 * Only the characters the renderer actually reads, and only where it reads
 * them: a `#` or a `-` matters at the start of a line and nowhere else, so
 * escaping every one of them would fill ordinary prose with backslashes.
 */
function literal(text: string): string {
  // Only `*`, a backtick and the backslash itself: those are the three the
  // renderer reads inside a line. `_` is deliberately absent — it means nothing
  // to this renderer, and escaping it would put visible backslashes through
  // every `snake_case` name in a comment about code.
  //
  // Nothing is escaped at the START of a line either. A person who typed
  // "1. " into a paragraph ClickUp did not mark as a list still meant a
  // numbered line, and rendering it as one is what they were looking at when
  // they wrote it.
  return text.replace(/([\\`*])/g, "\\$1");
}

/**
 * The language ClickUp says the block is, passed through.
 *
 * Including `css`, which is what it wrote for a block of python test output on
 * the card this was measured against — because that IS what ClickUp renders it
 * as, and what somebody comparing the two windows is looking at. A grammar the
 * app disagrees with produces the same colours as the browser it came from;
 * substituting a cleverer guess produces a THIRD rendering of the same comment,
 * which is the one thing neither window would explain.
 *
 * `plain` and `text` mean "no language" and are the one case worth dropping, so
 * the renderer's own guess gets a turn on a block nobody labelled at all.
 */
const CHOSEN = (lang: string): string => (lang === "plain" || lang === "text" ? "" : lang);

/**
 * One line's runs, as markdown.
 *
 * Adjacent runs that share an emphasis get ONE pair of markers around the lot.
 * Wrapping each run on its own is what produced `**leave ****`required`**** out**`
 * — four asterisks in a row, which no reader parses — because ClickUp splits a
 * bold sentence at every inline code span inside it.
 *
 * Surrounding spaces are moved outside the markers for the same reason: `** x **`
 * is not emphasis in most readers, and the space belongs to the sentence rather
 * than to the emphasised word.
 */
function renderRuns(runs: { text: string; a: DeltaBlock["attributes"] }[]): string {
  const shape = (r: { a: DeltaBlock["attributes"] }) => `${!!r.a?.bold}|${!!r.a?.italic}|${r.a?.link ?? ""}`;
  const out: string[] = [];
  for (let i = 0; i < runs.length;) {
    let j = i;
    while (j < runs.length && shape(runs[j]) === shape(runs[i])) j++;
    const a = runs[i].a;
    const body = runs.slice(i, j)
      .map((r) => (r.a?.code ? "`" + r.text.replace(/`/g, "") + "`" : literal(r.text)))
      .join("");
    const lead = body.match(/^\s*/)![0];
    const tail = body.match(/\s*$/)![0];
    let core = body.slice(lead.length, body.length - tail.length);
    if (core) {
      if (a?.bold) core = "**" + core + "**";
      if (a?.italic) core = "*" + core + "*";
      if (a?.link) core = "[" + core + "](" + a.link + ")";
    }
    out.push(lead + core + tail);
    i = j;
  }
  return out.join("");
}

export function commentMarkdown(blocks: DeltaBlock[]): string {
  const out: string[] = [];
  /** The runs of the line being built, before its newline arrives and says what
   *  kind of line it is. */
  let line: { text: string; a: DeltaBlock["attributes"] }[] = [];
  /** Consecutive `code-block` lines gather into one fence rather than becoming
   *  one fence each. */
  let fence: { lang: string; lines: string[] } | null = null;

  const closeFence = () => {
    if (!fence) return;
    out.push("```" + fence.lang, ...fence.lines, "```");
    fence = null;
  };

  const endLine = (a: DeltaBlock["attributes"]) => {
    const body = renderRuns(line).trimEnd();
    line = [];
    const cb = a?.["code-block"];
    if (cb) {
      // Inside a fence the text is verbatim, so anything `literal` escaped on
      // the way in has to come back off.
      fence ??= { lang: CHOSEN(cb["code-block"] ?? ""), lines: [] };
      fence.lines.push(body.replace(/\\([\\`*])/g, "$1"));
      return;
    }
    closeFence();
    const h = a?.header;
    if (h && h >= 1 && h <= 4 && body) out.push("#".repeat(h) + " " + body);
    else if (a?.list?.list === "bullet") out.push("- " + body);
    else if (a?.list?.list === "ordered") out.push("1. " + body);
    else if (a?.blockquote) out.push("> " + body);
    else out.push(body);
  };

  for (const b of blocks) {
    const tbl = b["table-embed"];
    if (tbl) {
      const md = tableMarkdown(tbl);
      if (md) { endLine(undefined); closeFence(); out.push("", md, ""); }
      continue;
    }
    if (b.type === "divider") { endLine(undefined); closeFence(); out.push("", "---", ""); continue; }
    const raw = typeof b.text === "string" ? b.text : "";
    if (!raw) continue;
    const a = b.attributes;
    // A run can carry its own newlines; each one ends a line under THIS block's
    // attributes, which is exactly what Quill means by them.
    const parts = raw.split("\n");
    parts.forEach((part, i) => {
      if (part) line.push({ text: part, a });
      if (i < parts.length - 1) endLine(a);
    });
  }
  if (line.length) endLine(undefined);
  closeFence();
  // Three or more blank lines are what an editor's empty paragraphs become, and
  // markdown needs only one to separate.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * A ClickUp comment table, as markdown.
 *
 * The one thing its plain-text rendering cannot do — it emits the string
 * "undefined" where a table was, which is how a card's most useful comment
 * arrived with a hole in it. The data is all there in the block: a sparse map
 * of cells keyed `"row:column"`, one-indexed, alongside the row and column
 * counts.
 *
 * Turned into a markdown table rather than into HTML because the panel already
 * renders markdown for descriptions and comments, so this arrives through a
 * path that is already styled, already sanitised, and already scrolls sideways
 * when a table is wider than the pane.
 *
 * The first row is the header, which is what ClickUp's own editor makes it —
 * measured on the real one: every cell in row 1 carries `cell-bg-color: grey`.
 */
function tableMarkdown(t: { rows?: unknown[]; columns?: unknown[]; cells?: Record<string, { content?: { insert?: unknown }[] }> }): string {
  const rows = t.rows?.length ?? 0;
  const cols = t.columns?.length ?? 0;
  if (!rows || !cols || !t.cells) return "";
  const cell = (r: number, c: number): string =>
    (t.cells?.[`${r}:${c}`]?.content ?? [])
      .map((x) => (typeof x.insert === "string" ? x.insert : ""))
      .join("")
      // A newline inside a cell would end the markdown row. `<br>` is what a
      // markdown table has instead, and the renderer passes it through as text
      // rather than as markup, which is the safe half of the trade.
      .replace(/\s*\n\s*/g, " ")
      // The backslash goes FIRST, and the order is the whole point: escaping it
      // after the pipe would re-escape the backslashes this line just wrote and
      // print them. A cell reading `C:\|next` used to come out `C:\\|next`,
      // where markdown reads `\\` as one literal backslash and then meets a
      // BARE pipe — so that cell ended the row and every column after it slid
      // one to the left. Not markup: what this feeds is `<Markdown>`, which
      // builds elements and never sets innerHTML, so the damage is a table
      // drawn wrong, not a tag.
      .replace(/\\/g, "\\\\")
      .replace(/\|/g, "\\|")
      .trim();
  const line = (r: number) => `| ${Array.from({ length: cols }, (_, i) => cell(r, i + 1)).join(" | ")} |`;
  const out = [line(1), `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`];
  for (let r = 2; r <= rows; r++) out.push(line(r));
  return out.join("\n");
}

/** A list's own statuses and custom fields — the two things a view cannot tell
 *  us, and the two a picker needs in order not to guess. */
export async function listMeta(
  token: string, listId: string,
): Promise<CallResult<{ name: string; statuses: ListStatus[]; fields: ListField[]; place: ListPlace; description?: string; color?: string }>> {
  const l = await call<{
    name?: string;
    /** The blurb at the top of a list in ClickUp: the brief, the docs, who is
     *  on it. Plain text through the API — the chips and links it draws in the
     *  browser are rich blocks v2 does not hand out — and empty on most lists,
     *  which is why nothing is drawn for it unless there is something. */
    content?: string;
    statuses?: { status: string; type: string; orderindex: number; color?: string }[];
    // Verified against a real list: `/list/{id}` carries its own space and
    // folder. The breadcrumb therefore costs no call of its own.
    folder?: { name?: string; hidden?: boolean };
    /* Not the list's default STATUS — the colour the tracker paints its icon
       in. `Bugs` is #e5484d, the red of the ladybird beside it. */
    status?: { color?: string } | null;
    space?: { name?: string };
  }>(
    `/list/${encodeURIComponent(listId)}`, token,
  );
  if (!l.ok) return { ...l, data: undefined };
  const f = await call<{ fields?: { id: string; name: string; type: string; type_config?: { options?: { id: string; name?: string; label?: string; color?: string | null }[] } }[] }>(
    `/list/${encodeURIComponent(listId)}/field`, token,
  );
  return {
    ok: true,
    data: {
      name: l.data?.name ?? "",
      /* The colour the tracker draws this list's icon in — see SavedView.color
         for why the colour and not the emoji. */
      ...(l.data?.status?.color ? { color: l.data.status.color } : {}),
      /* Always set, even to "": `undefined` has to keep meaning "never asked",
         which is what lets a cache written before this field existed be told
         apart from a list that genuinely has no blurb. */
      description: String(l.data?.content ?? "").trim() ? String(l.data!.content) : "",
      place: {
        space: l.data?.space?.name || undefined,
        // A folderless list gets a hidden placeholder — see ListPlace.
        folder: l.data?.folder && !l.data.folder.hidden ? l.data.folder.name || undefined : undefined,
        list: l.data?.name ?? "",
      },
      statuses: (l.data?.statuses ?? []).map((s) => ({
        status: s.status, type: s.type, orderindex: s.orderindex, color: s.color,
      })).sort((a, b) => a.orderindex - b.orderindex),
      fields: (f.data?.fields ?? []).map((x) => ({
        id: x.id, name: x.name, type: x.type,
        options: (x.type_config?.options ?? []).map((o) => ({ id: o.id, name: o.name ?? o.label ?? "", ...(o.color ? { color: o.color } : {}) })).filter((o) => o.name),
        // Somebody wrote the warning into the field's own name because the API
        // has nowhere else to put it. Reading it is the least we can do.
        readOnly: /do not edit/i.test(x.name),
      })),
    },
  };
}

/**
 * Every task in a view, following its pages.
 *
 * Measured: page 0 returns 30 and `last_page:false`, page 1 returns the
 * remaining 6 and `last_page:true` — about a second each. Followed to the end
 * rather than stopping at the first page, because a list that silently shows
 * the first thirty of thirty-six is the kind of wrong that is never noticed.
 * Capped anyway: a view with fifty pages is a view nobody works from, and
 * spending the whole rate budget discovering that helps no one.
 */
const MAX_PAGES = 10;

/**
 * The view a list opens on in ClickUp — the thing somebody is actually looking
 * at when they say "that list".
 *
 * Cached because it is a property of the list rather than of its contents: one
 * call, then never again this session.
 */
const listViewCache = new Map<string, { at: number; id: string | null }>();
const LIST_VIEW_TTL_MS = 30 * 60_000;

export async function defaultViewOf(token: string, listId: string): Promise<string | null> {
  const hit = listViewCache.get(listId);
  if (hit && Date.now() - hit.at < LIST_VIEW_TTL_MS) return hit.id;
  const r = await call<{ required_views?: { list?: { id?: string } } }>(
    `/list/${encodeURIComponent(listId)}/view`, token,
  );
  const id = r.ok ? (r.data?.required_views?.list?.id ?? null) : null;
  // A failure is not cached as "no view": the next read should try again rather
  // than fall back to the raw list for the rest of the session.
  if (r.ok) listViewCache.set(listId, { at: Date.now(), id });
  return id;
}

/**
 * The views a list offers — the tabs along the top of it in ClickUp.
 *
 * Only the ones that are a list of tasks. A Gantt and a dashboard are real
 * views and this app has nothing to draw them with, and offering a row that
 * opens a board of nothing is worse than not offering it.
 *
 * The list's own default view is left out on purpose: it is what the list row
 * already opens, and a child that repeats its parent is a row people click by
 * mistake once each.
 */
export async function listViews(token: string, listId: string): Promise<CallResult<{ views: { id: string; name: string }[]; links: { id: string; name: string; type: string }[] }>> {
  const id = String(listId || "").trim();
  if (!/^[0-9]+$/.test(id)) return { ok: false, error: "not a list id" };
  const r = await call<{
    views?: { id?: string; name?: string; type?: string }[];
    required_views?: { list?: { id?: string } };
  }>(`/list/${encodeURIComponent(id)}/view`, token);
  if (!r.ok) return { ...r, data: undefined };
  const home = r.data?.required_views?.list?.id ?? "";
  const all = (r.data?.views ?? []).filter((v) => v?.id && v.id !== home);
  const views = all
    .filter((v) => v.type === "list")
    .map((v) => ({ id: String(v.id), name: String(v.name ?? "View") }));
  /* The ones this app cannot draw — a Gantt, a dashboard, a whiteboard — are
     still worth knowing about: they are one click away in ClickUp, and a team
     that keeps its plan in a Gantt should not have to go and find it. Handed
     over with their TYPE, because that is what decides the address. */
  const links = all
    .filter((v) => v.type && v.type !== "list")
    .map((v) => ({ id: String(v.id), name: String(v.name ?? "View"), type: String(v.type) }));
  return { ok: true, data: { views, links } };
}

export async function viewTasks(
  token: string, viewId: string, myId?: string,
): Promise<CallResult<{ tasks: ProviderTask[]; truncated: boolean }>> {
  const out: ProviderTask[] = [];
  let page = 0;
  for (; page < MAX_PAGES; page++) {
    const r = await call<{ tasks?: RawTask[]; last_page?: boolean }>(
      `/view/${encodeURIComponent(viewId)}/task?page=${page}`, token, LIST_TIMEOUT_MS,
    );
    if (!r.ok) return out.length ? { ok: true, data: { tasks: out, truncated: true } } : { ...r, data: undefined };
    for (const raw of r.data?.tasks ?? []) out.push(toTask(raw, myId));
    if (r.data?.last_page !== false) return { ok: true, data: { tasks: out, truncated: false } };
  }
  return { ok: true, data: { tasks: out, truncated: true } };
}

/**
 * How many comments each card has.
 *
 * The workspace does not put this on a task — measured against a real one:
 * thirty-eight fields and not a count among them — so the only way to know is
 * to ask for the comments and count them, one call per card.
 *
 * SPLIT IN TWO, AND THAT IS THE DESIGN. The first version awaited every card
 * before returning the board, and this board already says "did not answer in
 * time — showing what was last read" when the workspace is slow. Twenty extra
 * calls in front of a list that was already racing a timeout is how a column of
 * small numbers takes a panel down. So the read is instant and comes from the
 * cache; the counting happens behind it, for the next one.
 *
 * The cache key is the card AND its `updated` stamp. A comment moves that
 * stamp, so a card nobody has touched is never counted twice and a board that
 * has not changed costs nothing. The first sight of a board shows blanks and
 * fills in a refresh later — the honest trade for not making it wait.
 */
const commentCounts = new Map<string, number>();

/**
 * Take back the counts a previous run already worked out.
 *
 * The map is memory-only, so a restart empties it — and the very next sweep
 * would then replace cached rows that DID carry a count with fresh ones that do
 * not, blanking a column that was correct a second earlier. The counts survive
 * the restart on the cached board itself (they are fields on the rows, and the
 * board is written to disk), so the cheapest recovery is to read them back off
 * it before applying anything.
 *
 * Keyed by id AND stamp like everything else here, so a card edited while the
 * app was closed is not credited with its old count.
 */
export function seedCommentCounts(tasks: ProviderTask[]): void {
  for (const t of tasks) {
    if (t.comments !== undefined && !commentCounts.has(`${t.id}:${t.updated}`)) {
      commentCounts.set(`${t.id}:${t.updated}`, t.comments);
    }
  }
}

/** Whatever has been counted, applied. Synchronous by design. */
export function applyCommentCounts(tasks: ProviderTask[]): ProviderTask[] {
  return tasks.map((t) => {
    const n = commentCounts.get(`${t.id}:${t.updated}`);
    return n === undefined ? t : { ...t, comments: n };
  });
}

/**
 * Count what has not been counted, behind the request.
 *
 * Never awaited by one. Five in flight because the workspace rate-limits by the
 * minute, and forty cards at once is a burst that gets everything after it
 * refused — including the board's own next read.
 */
export async function refreshCommentCounts(tasks: ProviderTask[], token: string): Promise<void> {
  const need = tasks.filter((t) => !commentCounts.has(`${t.id}:${t.updated}`));
  const LANES = 5;
  for (let i = 0; i < need.length; i += LANES) {
    await Promise.all(need.slice(i, i + LANES).map(async (t) => {
      const r = await call<{ comments?: unknown[] }>(`/task/${encodeURIComponent(t.id)}/comment`, token);
      if (r.ok) commentCounts.set(`${t.id}:${t.updated}`, (r.data?.comments ?? []).length);
    }));
  }
  // Keyed by id+stamp, so an edited card leaves its old entry behind. Cleared
  // wholesale: it is a display count and rebuilding costs one sweep.
  if (commentCounts.size > 2000) commentCounts.clear();
}

// ---------------------------------------------------------------------------
// writing — the half that other people can see
// ---------------------------------------------------------------------------

/**
 * Writes are off unless switched on, and they are off by default.
 *
 * The local task list ships with writes ENABLED and a switch to turn them off,
 * which is the right default for a store that belongs to you. This is the
 * opposite case: it is somebody's company workspace, a status change fires
 * automations and notifies a team, and there is no undo. So the default is
 * read-only and turning it on is a deliberate act — the same reasoning
 * `TASK_WRITE_ENABLED` uses, pointed the other way.
 */
export function clickupWriteEnabled(): boolean {
  // The environment variable is a floor, not the only way in: somebody running
  // the app headless can force it on, and somebody using the app can turn it on
  // from the panel that shows them what it does. Both are explicit acts; asking
  // for an env var to tick a checkbox is not more secure, only less usable.
  if (process.env.AGENTGLASS_CLICKUP_WRITE === "1") return true;
  return writesAllowed();
}

/** @deprecated Read `clickupWriteEnabled()` — this is a snapshot at import. */
export const CLICKUP_WRITE_ENABLED = process.env.AGENTGLASS_CLICKUP_WRITE === "1";

export interface WriteOutcome {
  ok: boolean;
  error?: string;
  /** The task as it stands after the write, re-read rather than assumed. */
  task?: ProviderTask;
  /** Somebody else changed it between the read and the write. */
  conflict?: boolean;
  /**
   * The token was refused — reconnect, rather than try again.
   *
   * `conflict` has always been a field rather than a sentence, and this is the
   * other failure with a different remedy, so it gets the same treatment. The
   * read path (`CallResult`) has carried it all along and the writes computed
   * it and threw it away: `put` classifies 401/403 and then every caller
   * flattened the result to `{ ok: false, error }`.
   *
   * NOT a general error taxonomy, and deliberately not: this provider answers
   * 401 for a card that does not exist (see findTask), so a code claiming to
   * name the cause would be wrong on exactly the case people hit most. Two
   * flags for the two remedies the app can actually offer — reload, reconnect
   * — and prose for the human, which is the only thing that can be honest
   * about the rest.
   */
  unauthorised?: boolean;
}

/**
 * The precondition, as close as this API gets to one.
 *
 * Taskwarrior gave us a fingerprint of the whole store; ClickUp gives nothing
 * of the kind. What it does give is `date_updated`, so the shape is: the client
 * sends the value it was looking at, and the write is refused if the task has
 * moved since. It is weaker than a fingerprint — two edits inside the same
 * millisecond would slip through — and it catches the case that actually
 * happens, which is somebody moving the card while you had it open.
 */
async function guardUnchanged(token: string, taskId: string, expectUpdated?: number): Promise<string | null> {
  if (!expectUpdated) return null;
  const r = await call<RawTask>(`/task/${encodeURIComponent(taskId)}`, token);
  if (!r.ok) return r.error ?? "could not check the task first";
  const now = Number(r.data?.date_updated) || 0;
  if (now && now !== expectUpdated) return "Somebody changed this card while you had it open — reloaded";
  return null;
}

async function put(pathname: string, token: string, body: unknown): Promise<CallResult<RawTask>> {
  const ctl = new AbortController();
  const kill = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${base}${pathname}`, {
      method: "PUT",
      headers: { Authorization: token, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (r.status === 401 || r.status === 403) return { ok: false, unauthorised: true, error: "ClickUp refused this token" };
    if (!r.ok) {
      // ClickUp's own message is worth surfacing here, unlike on a read: it is
      // usually "Status not found" and that is precisely what you need to know.
      const said = await r.text().catch(() => "");
      const m = /"err"\s*:\s*"([^"]+)"/.exec(said);
      return { ok: false, error: m?.[1] ? `ClickUp: ${m[1]}` : `ClickUp answered ${r.status}` };
    }
    return { ok: true, data: (await r.json()) as RawTask };
  } catch (e) {
    const aborted = (e as { name?: string })?.name === "AbortError";
    return { ok: false, error: aborted ? "ClickUp did not answer in time" : "Could not reach ClickUp" };
  } finally { clearTimeout(kill); }
}

/** Put yourself on a card, or take yourself off it. */
export async function assignSelf(taskId: string, on: boolean, expectUpdated?: number): Promise<WriteOutcome> {
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "ClickUp is not connected" };
  if (!clickupWriteEnabled()) return { ok: false, error: "Writing to ClickUp is switched off" };
  const me = redacted("clickup")?.accountId;
  if (!me) return { ok: false, error: "Do not know which ClickUp account this is" };
  const stale = await guardUnchanged(token, taskId, expectUpdated);
  if (stale) return { ok: false, conflict: true, error: stale };
  const n = Number(me);
  const r = await put(`/task/${encodeURIComponent(taskId)}`, token, {
    assignees: on ? { add: [n] } : { rem: [n] },
  });
  __reset();
  return r.ok ? { ok: true, task: toTask(r.data!, me) } : { ok: false, error: r.error, unauthorised: r.unauthorised };
}

/** Move a card to another status. The value must be one the LIST accepts —
 *  the caller offers those and never a free-text box, so this cannot be asked
 *  to invent one. */
/**
 * Who can be put on a card: the members of the list it lives in.
 *
 * The list rather than the workspace, and that is the whole point — a workspace
 * here has everybody in the company in it, and a picker offering all of them to
 * assign one backend card is a picker nobody uses twice. ClickUp publishes
 * membership per list, which is the team that actually works the board.
 */
export async function listMembers(listId: string): Promise<CallResult<{ members: ListMember[] }>> {
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "ClickUp is not connected" };
  const me = redacted("clickup")?.accountId;
  /*
   * The list AND the workspace, because the list alone is wrong here.
   *
   * The comment above was the theory. Measured against a real board: both of
   * his lists answered with the same twenty people — Alex Koh, Brett Carpenter,
   * Canny, Chuck Williams — and not one of the six ClickUp'"'"'s own picker offers
   * for those very cards. Whatever `/list/{id}/member` is reporting, it is not
   * the team that works the board, and it was leaving the people he actually
   * assigns out of the picker entirely.
   *
   * So both sources, de-duplicated: nobody who can be assigned is missing, and
   * the client puts the ones already on this board'"'"'s cards at the top — which
   * is what ClickUp does with its own "Assignees" group.
   */
  const me2 = me ? redacted("clickup") : null;
  const [fromList, fromTeam] = await Promise.all([
    call<{ members?: NonNullable<RawTask["assignees"]>[number][] }>(`/list/${encodeURIComponent(listId)}/member`, token),
    me2?.workspaceId
      ? call<{ teams?: { members?: { user?: NonNullable<RawTask["assignees"]>[number] }[] }[] }>(`/team`, token)
      : Promise.resolve({ ok: false } as CallResult<{ teams?: never[] }>),
  ]);
  if (!fromList.ok && !fromTeam.ok) return { ok: false, error: fromList.error };
  const workspace = (fromTeam.ok ? fromTeam.data?.teams ?? [] : [])
    .filter((t: any) => !me2?.workspaceId || String(t.id) === me2.workspaceId)
    .flatMap((t: any) => (t.members ?? []).map((m: any) => m.user).filter(Boolean));
  const seenIds = new Set<string>();
  const r = { ok: true as const, data: { members: [...(fromList.data?.members ?? []), ...workspace]
    .filter((m: any) => m?.id != null && !seenIds.has(String(m.id)) && seenIds.add(String(m.id))) } };
  const members: ListMember[] = (r.data?.members ?? [])
    .filter((m) => m.id != null)
    .map((m) => ({
      id: Number(m.id),
      name: m.username ?? "",
      initials: m.initials || initialsOf(m.username ?? ""),
      color: m.color || undefined,
      avatar: m.profilePicture || undefined,
      me: me ? String(m.id) === me : undefined,
    }))
    .filter((m) => m.name || m.initials);
  // You, even when the list does not name you.
  //
  // Measured against a real board: a nineteen-member list came back without the
  // connected account in it at all — ClickUp's list membership is not the same
  // question as "who can be assigned here", and somebody working a board they
  // are not formally a member of is ordinary. Without this the picker would
  // silently lose the one thing the old control COULD do, which was put you on
  // the card. So the account is added from `whoAmI` when the list forgot it.
  if (me && !members.some((m) => m.me)) {
    const who = await whoAmI(token);
    if (who.ok && who.data) {
      members.unshift({ id: Number(me), name: who.data.name || "you", initials: initialsOf(who.data.name || "you"), me: true });
    }
  }
  // You first: the commonest assignment on any board is your own.
  members.sort((a, b) => Number(!!b.me) - Number(!!a.me) || a.name.localeCompare(b.name));
  return { ok: true, data: { members } };
}

/**
 * Put somebody on a card, or take them off.
 *
 * `assignSelf` did this for one person — you — because that was the whole
 * feature: the id was the connected account's and there was no way to name
 * anybody else. It is the same PUT; what was missing was being allowed to say
 * who. Add and remove rather than replace, because a ClickUp card holds several
 * assignees and replacing would quietly take off whoever else was on it.
 */
export async function setAssignee(taskId: string, userId: number, on: boolean, expectUpdated?: number): Promise<WriteOutcome> {
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "ClickUp is not connected" };
  if (!clickupWriteEnabled()) return { ok: false, error: "Writing to ClickUp is switched off" };
  if (!Number.isFinite(userId)) return { ok: false, error: "That is not a person" };
  const stale = await guardUnchanged(token, taskId, expectUpdated);
  if (stale) return { ok: false, conflict: true, error: stale };
  const r = await put(`/task/${encodeURIComponent(taskId)}`, token, {
    assignees: on ? { add: [userId] } : { rem: [userId] },
  });
  __reset();
  const me = redacted("clickup")?.accountId;
  return r.ok ? { ok: true, task: toTask(r.data!, me) } : { ok: false, error: r.error, unauthorised: r.unauthorised };
}

/**
 * Everything one visit to a card changed, in one write.
 *
 * The reviewer picker used to send three: add each person, remove each person,
 * then the status — and every one of them carried the same `expectUpdated`, the
 * stamp read when the menu opened. The FIRST write moves that stamp, so
 * ClickUp's honest answer to the second and third was "somebody changed this
 * card while you had it open", and nothing on the screen said so.
 *
 * Measured on a real card: the person went on, the person who asked never came
 * off, the status never moved, and the app reported success.
 *
 * A card is one resource, so this is one PUT. `assignees.add`, `assignees.rem`
 * and `status` travel together: one precondition to satisfy, and no window in
 * which the card is half-moved. Add and remove rather than replace, because a
 * card holds several assignees and replacing would take off whoever else was
 * on it.
 */
export async function setCard(
  taskId: string,
  changes: { add?: number[]; rem?: number[]; status?: string },
  expectUpdated?: number,
): Promise<WriteOutcome> {
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "ClickUp is not connected" };
  if (!clickupWriteEnabled()) return { ok: false, error: "Writing to ClickUp is switched off" };
  const add = (changes.add ?? []).filter((n) => Number.isFinite(n));
  const rem = (changes.rem ?? []).filter((n) => Number.isFinite(n));
  const status = (changes.status ?? "").trim();
  // A no-op is a mistake upstream, not a write: sending one dates somebody
  // else's card for nothing.
  if (!add.length && !rem.length && !status) return { ok: false, error: "nothing to change" };
  const stale = await guardUnchanged(token, taskId, expectUpdated);
  if (stale) return { ok: false, conflict: true, error: stale };
  const body: Record<string, unknown> = {};
  if (add.length || rem.length) {
    body.assignees = { ...(add.length ? { add } : null), ...(rem.length ? { rem } : null) };
  }
  if (status) body.status = status;
  const r = await put(`/task/${encodeURIComponent(taskId)}`, token, body);
  __reset();
  const me = redacted("clickup")?.accountId;
  return r.ok ? { ok: true, task: toTask(r.data!, me) } : { ok: false, error: r.error, unauthorised: r.unauthorised };
}

export async function setStatus(taskId: string, status: string, expectUpdated?: number): Promise<WriteOutcome> {
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "ClickUp is not connected" };
  if (!clickupWriteEnabled()) return { ok: false, error: "Writing to ClickUp is switched off" };
  if (!status.trim()) return { ok: false, error: "no status given" };
  const stale = await guardUnchanged(token, taskId, expectUpdated);
  if (stale) return { ok: false, conflict: true, error: stale };
  const r = await put(`/task/${encodeURIComponent(taskId)}`, token, { status });
  __reset();
  const me = redacted("clickup")?.accountId;
  return r.ok ? { ok: true, task: toTask(r.data!, me) } : { ok: false, error: r.error, unauthorised: r.unauthorised };
}

/**
 * The card's priority — ClickUp's own field, not a custom one.
 *
 * A list can also carry a drop-down somebody named "Urgency", and the two are
 * different fields: the flag is ClickUp's own, it is what its boards sort by,
 * and the drop-down is whatever that list decided to call its own. The panel
 * drew the flag on the row and in the card header and offered no way to move
 * it — so the one field ClickUp orders a board by was the one field this app
 * could not touch.
 *
 * The wire wants a number and the numbers are ClickUp's: 1 urgent, 2 high,
 * 3 normal, 4 low. `null` clears it, and clearing is a real state rather than
 * an escape hatch — most cards have no priority at all, and a control that can
 * only ever raise the flag cannot put it back down.
 */
export const PRIORITY_WIRE: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 };

export async function setPriority(taskId: string, priority: string | null, expectUpdated?: number): Promise<WriteOutcome> {
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "ClickUp is not connected" };
  if (!clickupWriteEnabled()) return { ok: false, error: "Writing to ClickUp is switched off" };
  const wire = !priority ? null : PRIORITY_WIRE[priority];
  if (wire === undefined) return { ok: false, error: "that is not a priority" };
  const stale = await guardUnchanged(token, taskId, expectUpdated);
  if (stale) return { ok: false, conflict: true, error: stale };
  const r = await put(`/task/${encodeURIComponent(taskId)}`, token, { priority: wire });
  __reset();
  const me = redacted("clickup")?.accountId;
  return r.ok ? { ok: true, task: toTask(r.data!, me) } : { ok: false, error: r.error, unauthorised: r.unauthorised };
}

/**
 * Write a comment on a card's activity.
 *
 * `assignee` alongside the text is not decoration. ClickUp's `@Name` inside
 * `comment_text` is plain text — it reads as a mention and notifies nobody,
 * which is the worst of both: the card says somebody was told and they were
 * not. Assigning the comment to them is the documented way to make it arrive,
 * so the two together mean what the sentence claims.
 *
 * `notify_all: false` on purpose. This is a note for one person; waking a whole
 * watching list for it is how a team learns to mute the card.
 */
export async function commentOn(taskId: string, text: string, assignee?: number): Promise<WriteOutcome> {
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "ClickUp is not connected" };
  if (!clickupWriteEnabled()) return { ok: false, error: "Writing to ClickUp is switched off" };
  const body = String(text ?? "").trim();
  // An empty comment is a mistake upstream, not a write. It would still bump
  // the card's date and show up in somebody's inbox as nothing at all.
  if (!body) return { ok: false, error: "nothing to say" };
  const ctl = new AbortController();
  const kill = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${base}/task/${encodeURIComponent(taskId)}/comment`, {
      method: "POST",
      headers: { Authorization: token, "content-type": "application/json" },
      body: JSON.stringify({
        /* Ops rather than `comment_text`, ALWAYS.
           `comment_text` is shown verbatim: a note written with a bold word or
           a bulleted list arrives on the card with its asterisks and dashes
           showing. The ops render, and for a line with no formatting in it they
           render the same line — so there is no case where the plain field is
           the better one, and no branch here deciding between them. */
        comment: markdownToDelta(body, undefined, await workspacePeople(token)),
        notify_all: false,
        ...(Number.isFinite(assignee) ? { assignee } : null),
      }),
      signal: ctl.signal,
    });
    __reset();
    // Classified here rather than through `put`, and saying the same words: a
    // refused token must not be a reconnect prompt on three routes and prose on
    // the fourth.
    if (r.status === 401 || r.status === 403) return { ok: false, unauthorised: true, error: "ClickUp refused this token" };
    if (!r.ok) return { ok: false, error: `ClickUp answered ${r.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not reach ClickUp" };
  } finally { clearTimeout(kill); }
}

/* ------------------------------------------------------------- writing --- */

/**
 * One call, any verb, with the classification every write here has to share.
 *
 * `put` above answers a task and most of what follows does not: a comment, a
 * checklist item, a tag, an empty 200. Rather than four hand-rolled fetches
 * with four slightly different ideas of what a 401 means, everything goes
 * through this — because the panel's remedies (reload, reconnect) are chosen
 * from those flags, and a route that forgets one is a route that offers the
 * wrong button.
 */
async function send(method: string, pathname: string, body?: unknown): Promise<CallResult<unknown>> {
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "ClickUp is not connected" };
  const ctl = new AbortController();
  const kill = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${base}${pathname}`, {
      method,
      headers: { Authorization: token, ...(body === undefined ? null : { "content-type": "application/json" }) },
      ...(body === undefined ? null : { body: JSON.stringify(body) }),
      signal: ctl.signal,
    });
    if (r.status === 401 || r.status === 403) return { ok: false, unauthorised: true, error: "ClickUp refused this token" };
    if (!r.ok) {
      // ClickUp's own message, when it gave one: "Status not found", "Field
      // does not exist" and the like are the whole answer, and hiding them
      // behind the status code costs an afternoon.
      const said = await r.text().catch(() => "");
      const m = /"err"\s*:\s*"([^"]+)"/.exec(said);
      return { ok: false, error: m?.[1] ? `ClickUp: ${m[1]}` : `ClickUp answered ${r.status}` };
    }
    const text = await r.text().catch(() => "");
    try { return { ok: true, data: text ? JSON.parse(text) : {} }; } catch { return { ok: true, data: {} }; }
  } catch (e) {
    const aborted = (e as { name?: string })?.name === "AbortError";
    return { ok: false, error: aborted ? "ClickUp did not answer in time" : "Could not reach ClickUp" };
  } finally { clearTimeout(kill); }
}

/** The two checks every write shares, in the order that makes the message
 *  useful: no token before no permission before a stale card. */
function writable(): string | null {
  if (!secretFor("clickup")) return "ClickUp is not connected";
  if (!clickupWriteEnabled()) return "Writing to ClickUp is switched off";
  return null;
}

const outcome = (r: CallResult<unknown>): WriteOutcome =>
  r.ok ? { ok: true } : { ok: false, error: r.error, unauthorised: r.unauthorised };

/**
 * The card's own fields — the ones that are not custom fields.
 *
 * ClickUp takes them all on a single `PUT /task/{id}`, so they are ONE call
 * here too: a dialog that changes the title and the points should not be two
 * writes, two conflict checks and two chances to half-apply.
 *
 * `points` is the sprint points ClickApp's field and it is native — measured
 * against a real workspace, where the card carried `points: 3` and the same
 * value went back with a 200. It is not a custom field and looking for it
 * among them finds nothing.
 *
 * Dates are milliseconds. `null` clears one, and clearing is a real edit: a due
 * date somebody set by mistake has to come off.
 */
export interface TaskPatch {
  name?: string;
  /** Markdown, as the person wrote it. */
  description?: string;
  due?: number | null;
  start?: number | null;
  points?: number | null;
  /** Milliseconds, like every other duration on the wire. */
  estimate?: number | null;
  archived?: boolean;
}

export async function updateTask(taskId: string, patch: TaskPatch, expectUpdated?: number): Promise<WriteOutcome> {
  const no = writable();
  if (no) return { ok: false, error: no };
  const token = secretFor("clickup")!;
  const stale = await guardUnchanged(token, taskId, expectUpdated);
  if (stale) return { ok: false, conflict: true, error: stale };

  const body: Record<string, unknown> = {};
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.description !== undefined) {
    /* `markdown_content` is the field that keeps the formatting; `description`
       is the plain one and setting it strips the card's headings and lists to
       text. Both are sent because workspaces on the older API only know the
       second, and ClickUp applies the markdown one when it has it. */
    body.markdown_content = patch.description;
    body.description = patch.description;
  }
  if (patch.due !== undefined) { body.due_date = patch.due; body.due_date_time = patch.due != null; }
  if (patch.start !== undefined) { body.start_date = patch.start; body.start_date_time = patch.start != null; }
  if (patch.points !== undefined) body.points = patch.points;
  if (patch.estimate !== undefined) body.time_estimate = patch.estimate;
  if (patch.archived !== undefined) body.archived = patch.archived;
  if (!Object.keys(body).length) return { ok: false, error: "nothing to change" };

  const r = await put(`/task/${encodeURIComponent(taskId)}`, token, body);
  __reset();
  const me = redacted("clickup")?.accountId;
  return r.ok ? { ok: true, task: toTask(r.data!, me) } : { ok: false, error: r.error, unauthorised: r.unauthorised };
}

/** A tag, on or off. Tags are addressed by NAME on this API, not by id, and the
 *  name is part of the path — so one with a slash or a space in it has to be
 *  encoded or the request goes somewhere else entirely. */
export async function setTag(taskId: string, tag: string, on: boolean): Promise<WriteOutcome> {
  const no = writable();
  if (no) return { ok: false, error: no };
  const name = tag.trim();
  if (!name) return { ok: false, error: "a tag needs a name" };
  const r = await send(on ? "POST" : "DELETE", `/task/${encodeURIComponent(taskId)}/tag/${encodeURIComponent(name)}`);
  __reset();
  return outcome(r);
}

/**
 * What a custom field's value has to look like on the wire, by kind.
 *
 * ClickUp is strict and inconsistent about this in equal measure: a date is a
 * number, a checkbox is a boolean, a labels field takes an ARRAY of option ids
 * even when one is chosen, and a drop-down takes the id as a string. Sending
 * the wrong shape is a 400 with a message about the field, so the caller says
 * which kind it means rather than this guessing from a value that is digits
 * either way.
 */
export function fieldWire(kind: string, value: string): unknown {
  switch (kind) {
    case "date": return Number(value);
    case "number": case "currency": case "money": case "emoji": case "rating":
      return Number(value);
    case "checkbox": return value === "true" || value === "1";
    case "labels": case "users":
      // Comma-separated on the way in, because that is what one text box can
      // produce; an empty string is an empty selection, not a `[""]`.
      return value.split(",").map((v) => v.trim()).filter(Boolean);
    default: return value;
  }
}

export async function setField(taskId: string, fieldId: string, optionId: string, kind = "drop_down"): Promise<WriteOutcome> {
  const no = writable();
  if (no) return { ok: false, error: no };
  const r = await send("POST", `/task/${encodeURIComponent(taskId)}/field/${encodeURIComponent(fieldId)}`, { value: fieldWire(kind, optionId) });
  __reset();
  return outcome(r);
}

/** Empty a custom field. Not the same as setting it to "": a drop-down set to
 *  the empty string is a 400, and a cleared one is how you take a choice back. */
export async function clearField(taskId: string, fieldId: string): Promise<WriteOutcome> {
  const no = writable();
  if (no) return { ok: false, error: no };
  const r = await send("DELETE", `/task/${encodeURIComponent(taskId)}/field/${encodeURIComponent(fieldId)}`);
  __reset();
  return outcome(r);
}

/**
 * Move a card to another list — which is how a card changes SPRINT.
 *
 * Measured on a real workspace: a sprint is not a field, it is a list inside
 * the space's sprint folder, and the card carries it in `locations`. There is
 * no "move task" verb on this API; what there is is the multiple-lists app's
 * add and remove, and doing both in that order is a move. Add first on purpose
 * — a failed remove leaves the card in two sprints, which is visible and
 * fixable, where a failed add would leave it in none.
 */
export async function moveToList(taskId: string, listId: string, fromListId?: string): Promise<WriteOutcome> {
  const no = writable();
  if (no) return { ok: false, error: no };
  if (!listId) return { ok: false, error: "no list to move it to" };
  const added = await send("POST", `/list/${encodeURIComponent(listId)}/task/${encodeURIComponent(taskId)}`);
  if (!added.ok) {
    __reset();
    return { ok: false, unauthorised: added.unauthorised,
      error: `${added.error ?? "ClickUp refused the move"} — moving a card between lists needs the Tasks in Multiple Lists app switched on for the workspace` };
  }
  if (fromListId && fromListId !== listId) {
    const gone = await send("DELETE", `/list/${encodeURIComponent(fromListId)}/task/${encodeURIComponent(taskId)}`);
    __reset();
    if (!gone.ok) return { ok: false, error: `Added to the new list, but it is still in the old one: ${gone.error ?? "ClickUp refused"}` };
  }
  __reset();
  return { ok: true };
}

/**
 * The sprints a card could be moved to, and the one it is in.
 *
 * There is no "sprints" endpoint, because a sprint is not a thing on this API:
 * it is a LIST, in a folder, in the card's space — measured on a real workspace,
 * where the card sat in a project list and carried "Sprint 140 (26/8/19 -
 * 26/8/25)" among its locations. So the folder is found by what its lists are
 * called rather than by a name or a type: a workspace can call the folder
 * anything, and it is the lists inside it that have to look like sprints.
 *
 * Two calls, and neither is cheap enough to make per row — this is for a card
 * that is open, when the picker is opened.
 */
export async function sprintLists(taskId: string): Promise<CallResult<{ lists: { id: string; name: string }[]; current: { id: string; name: string } | null }>> {
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "ClickUp is not connected" };
  const t = await call<RawTask & { space?: { id?: string } }>(`/task/${encodeURIComponent(taskId)}`, token);
  if (!t.ok) return { ok: false, error: t.error, unauthorised: t.unauthorised };
  const spaceId = String(t.data?.space?.id ?? "");
  if (!spaceId) return { ok: false, error: "that card does not say which space it is in" };
  const here = (t.data?.locations ?? [])
    .map((l) => ({ id: String((l as { id?: string })?.id ?? ""), name: String(l?.name ?? "") }))
    .find((l) => l.id && looksLikeSprint(l.name)) ?? null;

  const f = await call<{ folders?: { id?: string; name?: string; lists?: { id?: string; name?: string }[] }[] }>(
    `/space/${encodeURIComponent(spaceId)}/folder?archived=false`, token, LIST_TIMEOUT_MS);
  if (!f.ok) return { ok: false, error: f.error, unauthorised: f.unauthorised };
  let best: { id: string; name: string }[] = [];
  for (const folder of f.data?.folders ?? []) {
    const lists = (folder.lists ?? [])
      .map((l) => ({ id: String(l.id ?? ""), name: String(l.name ?? "") }))
      .filter((l) => l.id && looksLikeSprint(l.name));
    // The folder with the MOST sprint-shaped lists, not the first one with any:
    // a project folder with a list called "Sprint planning" in it would
    // otherwise win over the folder holding thirty real sprints.
    if (lists.length > best.length) best = lists;
  }
  if (!best.length) return { ok: false, error: "no sprint lists in this card's space" };
  return { ok: true, data: { lists: best, current: here } };
}

/** A new card, in a list. Everything except the name is optional, and the name
 *  is the one thing ClickUp will not invent. */
export interface NewTask {
  name: string;
  description?: string;
  assignees?: number[];
  priority?: string | null;
  points?: number | null;
  due?: number | null;
  status?: string;
}

export async function createTask(listId: string, t: NewTask): Promise<CallResult<{ id: string; url: string }>> {
  const no = writable();
  if (no) return { ok: false, error: no };
  const name = t.name.trim();
  if (!name) return { ok: false, error: "a card needs a title" };
  const body: Record<string, unknown> = { name };
  if (t.description) { body.markdown_content = t.description; body.description = t.description; }
  if (t.assignees?.length) body.assignees = t.assignees;
  if (t.priority) body.priority = PRIORITY_WIRE[t.priority] ?? null;
  if (t.points != null) body.points = t.points;
  if (t.due != null) { body.due_date = t.due; body.due_date_time = true; }
  if (t.status) body.status = t.status;
  const r = await send("POST", `/list/${encodeURIComponent(listId)}/task`, body);
  __reset();
  if (!r.ok) return { ok: false, error: r.error, unauthorised: r.unauthorised };
  const made = r.data as { id?: string; url?: string };
  return { ok: true, data: { id: String(made.id ?? ""), url: String(made.url ?? "") } };
}

/** A checklist on a card, and its items. Three verbs because ClickUp addresses
 *  them at three different levels, and the ids are not interchangeable. */
export async function addChecklist(taskId: string, name: string): Promise<WriteOutcome> {
  const no = writable();
  if (no) return { ok: false, error: no };
  const r = await send("POST", `/task/${encodeURIComponent(taskId)}/checklist`, { name: name.trim() || "Checklist" });
  __reset();
  return outcome(r);
}

export async function addChecklistItem(checklistId: string, name: string): Promise<WriteOutcome> {
  const no = writable();
  if (no) return { ok: false, error: no };
  if (!name.trim()) return { ok: false, error: "an item needs a name" };
  const r = await send("POST", `/checklist/${encodeURIComponent(checklistId)}/checklist_item`, { name: name.trim() });
  __reset();
  return outcome(r);
}

export async function setChecklistItem(checklistId: string, itemId: string, done: boolean): Promise<WriteOutcome> {
  const no = writable();
  if (no) return { ok: false, error: no };
  const r = await send("PUT", `/checklist/${encodeURIComponent(checklistId)}/checklist_item/${encodeURIComponent(itemId)}`, { resolved: done });
  __reset();
  return outcome(r);
}

/**
 * Everybody in the workspace, for turning `@Name` into a mention that arrives.
 *
 * The workspace and not the card's list, deliberately: the name in a comment is
 * whoever the writer meant, and being formally a member of the list the card
 * lives in is a different question — measured on a real board, list membership
 * left out most of the people who actually work it (see listMembers).
 *
 * Cached for an hour. A roster changes when somebody joins the company; a
 * comment is written far more often than that, and a call per comment on the
 * send path is a delay on the one action that must feel immediate.
 */
const PEOPLE_TTL_MS = 60 * 60 * 1000;
let people: { at: number; who: MentionPerson[] } | null = null;

/** The roster, or nothing at all: a comment still has to post when the token
 *  went or the workspace refused — unnamed, but posted. */
async function roster(): Promise<MentionPerson[]> {
  const token = secretFor("clickup");
  return token ? await workspacePeople(token) : [];
}

async function workspacePeople(token: string): Promise<MentionPerson[]> {
  if (people && Date.now() - people.at < PEOPLE_TTL_MS) return people.who;
  const me = redacted("clickup");
  const r = await call<{ teams?: { id?: string; members?: { user?: { id?: number | string; username?: string; email?: string; initials?: string } }[] }[] }>("/team", token);
  if (!r.ok) return people?.who ?? [];
  const who = (r.data?.teams ?? [])
    .filter((t) => !me?.workspaceId || String(t.id ?? "") === me.workspaceId)
    .flatMap((t) => (t.members ?? []).map((m) => m.user).filter(Boolean))
    .filter((u) => u!.id != null && (u!.username ?? "").trim())
    .map((u) => ({ id: Number(u!.id), name: String(u!.username).trim(), email: u!.email || undefined, initials: u!.initials || undefined }));
  people = { at: Date.now(), who };
  return who;
}

/**
 * Editing, answering and removing a comment.
 *
 * The update endpoint is documented around `comment_text`, which is the plain
 * field — so an edit sent that way would strip the formatting off a comment
 * that had it. The ops go first and the plain text is the fallback if ClickUp
 * refuses them, which is the honest order: the good shape first, and something
 * rather than nothing if this workspace's API is older than the format.
 */
export async function editComment(commentId: string, text: string): Promise<WriteOutcome> {
  const no = writable();
  if (no) return { ok: false, error: no };
  const body = text.trim();
  if (!body) return { ok: false, error: "nothing to say" };
  const first = await send("PUT", `/comment/${encodeURIComponent(commentId)}`, { comment: markdownToDelta(body, undefined, await roster()) });
  if (first.ok) { __reset(); return { ok: true }; }
  const plain = await send("PUT", `/comment/${encodeURIComponent(commentId)}`, { comment_text: body });
  __reset();
  return outcome(plain.ok ? plain : first);
}

export async function replyToComment(commentId: string, text: string): Promise<WriteOutcome> {
  const no = writable();
  if (no) return { ok: false, error: no };
  const body = text.trim();
  if (!body) return { ok: false, error: "nothing to say" };
  const r = await send("POST", `/comment/${encodeURIComponent(commentId)}/reply`, {
    comment: markdownToDelta(body, undefined, await roster()),
    notify_all: false,
  });
  __reset();
  return outcome(r);
}

/** Tick a comment as dealt with, or untick it. */
export async function resolveComment(commentId: string, on: boolean): Promise<WriteOutcome> {
  const no = writable();
  if (no) return { ok: false, error: no };
  const r = await send("PUT", `/comment/${encodeURIComponent(commentId)}`, { resolved: on });
  __reset();
  return outcome(r);
}

export async function deleteComment(commentId: string): Promise<WriteOutcome> {
  const no = writable();
  if (no) return { ok: false, error: no };
  const r = await send("DELETE", `/comment/${encodeURIComponent(commentId)}`);
  __reset();
  return outcome(r);
}

/** The full card: description, subtasks, checklists — everything the list row
 *  cannot hold. Read on demand, never for every row. */
/**
 * The card's own history, from the two things the API will tell us.
 *
 * The first status is NOT a move. Its timestamp is the card's creation to within a
 * few milliseconds — measured on a real card: `date_created` 1785534599428 against
 * the first status's `since` 1785534599435 — so drawing both would be the same
 * moment reported twice, once with a name on it and once without. The status it was
 * created in rides on the creation row instead.
 *
 * `status_history` already includes the status the card is in now, so
 * `current_status` is only a fallback for a card that has never moved.
 */
export function cardEvents(
  /* `date_created` arrives as a string of milliseconds, and RawTask allows a
     number or null for it too — every one of those goes through the same `at`
     below rather than being trusted by its type. */
  task: { creator?: { username?: string; profilePicture?: string }; date_created?: string | number | null },
  time?: {
    current_status?: { status?: string; color?: string; total_time?: { since?: string; by_minute?: number } };
    status_history?: { status?: string; color?: string; total_time?: { since?: string; by_minute?: number } }[];
  },
): CardEvent[] {
  const at = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const hist = (time?.status_history ?? [])
    .map((h) => ({ status: h.status ?? "", color: h.color ?? "", at: at(h.total_time?.since), mins: Number(h.total_time?.by_minute) || 0 }))
    .filter((h) => h.status && h.at)
    .sort((a, b) => a.at - b.at);
  /* Never moved, and the history came back empty: the status it is in is still
     worth knowing, and it is the one it was created in. */
  if (!hist.length && time?.current_status?.status) {
    const only = {
      status: time.current_status.status, color: time.current_status.color ?? "",
      at: at(time.current_status.total_time?.since), mins: Number(time.current_status.total_time?.by_minute) || 0,
    };
    if (only.at) hist.push(only);
  }

  const out: CardEvent[] = [];
  const created = at(task.date_created) || hist[0]?.at || 0;
  if (created) {
    out.push({
      at: created, kind: "created",
      ...(task.creator?.username ? { who: task.creator.username } : null),
      ...(task.creator?.profilePicture ? { avatar: task.creator.profilePicture } : null),
      ...(hist[0] ? { status: hist[0].status, color: hist[0].color } : null),
    });
  }
  for (let i = 1; i < hist.length; i++) {
    out.push({
      at: hist[i]!.at, kind: "status", status: hist[i]!.status, color: hist[i]!.color, from: hist[i - 1]!.status,
      /* How long it sat in the status it is LEAVING, which is the one whose
         clock just stopped. `by_minute` is what the API counts. */
      ...(hist[i - 1]!.mins ? { mins: hist[i - 1]!.mins } : null),
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The card's own history, plus what this machine was told about it.
 *
 * ClickUp's API reports no assignment, no follower, no field change — only the
 * creation and the status clock. Their desktop notification reports all of
 * them, by name, and those are mirrored and kept here. Merged in time order
 * and marked `seen`, so a reader can tell the two apart at a glance.
 */
function withSeen(events: CardEvent[], id: string, customId: string): CardEvent[] {
  let seen: { text: string; at: number }[] = [];
  try { seen = Index.notesAbout(id, customId); } catch { seen = []; }
  if (!seen.length) return events;
  return [...events, ...seen.map((n) => ({ at: n.at, kind: "seen" as const, text: n.text }))]
    .sort((a, b) => a.at - b.at);
}

export async function taskDetail(taskId: string): Promise<CallResult<TaskDetail>> {
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "ClickUp is not connected" };
  const r = await call<RawTask & {
    description?: string; markdown_description?: string;
    subtasks?: RawTask[];
    checklists?: { name?: string; items?: { name?: string; resolved?: boolean }[] }[];
    /* Already in the answer we were making anyway — see CardAttachment for why the
       metadata is free and the images are not. */
    attachments?: {
      id?: string; title?: string; extension?: string; size?: number | string;
      url?: string; url_w_host?: string; thumbnail_medium?: string; thumbnail_small?: string;
      date?: string | number; user?: { username?: string };
    }[];
  }>(`/task/${encodeURIComponent(taskId)}?include_subtasks=true&include_markdown_description=true`, token);
  if (!r.ok) return { ...r, data: undefined };
  const d = r.data!;
  const me = redacted("clickup")?.accountId;
  /*
   * How the card advanced, asked for beside the comments rather than after them.
   *
   * `time_in_status` is the only history a personal token can read — probed: the
   * `history` and `activity` routes are 404 on v1 and v2, the task payload has no
   * `history_items`, and the audit-log endpoint is 404 on this plan. It answers
   * with every status the card has been in and the moment it entered each, which
   * is "how has this gone" even though it is not "who set Urgency to High".
   *
   * A refusal here loses the events and keeps the card: this is the third call on
   * a card somebody has just opened, and the description and the conversation are
   * what they opened it for.
   */
  const hp = call<{
    current_status?: { status?: string; color?: string; total_time?: { since?: string } };
    status_history?: { status?: string; color?: string; total_time?: { since?: string } }[];
  }>(`/task/${encodeURIComponent(taskId)}/time_in_status`, token);

  const c = await call<{ comments?: {
    id: string; comment_text?: string; date?: string; reply_count?: number; resolved?: boolean;
    /* Same three the reply call already asks for — the face beside the name. */
    user?: { username?: string; id?: number | string; initials?: string; color?: string; profilePicture?: string };
    /** ClickUp's own rich representation: a Quill delta, one piece per run of
     *  text, carrying the formatting its editor applied. See commentMarkdown. */
    comment?: DeltaBlock[];
  }[] }>(
    `/task/${encodeURIComponent(taskId)}/comment`, token,
  );
  return {
    ok: true,
    data: {
      task: toTask(d, me),
      attachments: (d.attachments ?? [])
        .map((a) => {
          const url = a.url_w_host || a.url || "";
          const at = Number(a.date);
          return {
            id: String(a.id ?? url),
            title: a.title ?? "",
            ext: String(a.extension ?? "").toLowerCase(),
            size: Number(a.size) || 0,
            url,
            /* The medium thumbnail rather than the small one: the grid draws them at
               about 150px and the small one is a 60px blur at that size. Only images
               have one, which is exactly how the grid knows what it can show. */
            ...(a.thumbnail_medium || a.thumbnail_small ? { thumb: a.thumbnail_medium || a.thumbnail_small } : null),
            ...(Number.isFinite(at) && at > 0 ? { at } : null),
            ...(a.user?.username ? { who: a.user.username } : null),
          };
        })
        /* A row with no address is a row that cannot be opened. Dropped rather than
           drawn as a file nobody can reach. */
        .filter((a) => a.url),
      events: withSeen(cardEvents(d, (await hp).data), String(d.id ?? ""), String(d.custom_id ?? "")),
      description: d.markdown_description || d.description || "",
      subtasks: (d.subtasks ?? []).map((t) => toTask(t, me)),
      checklists: (d.checklists ?? []).map((cl) => ({
        name: cl.name ?? "",
        items: (cl.items ?? []).map((i) => ({ name: i.name ?? "", done: !!i.resolved })),
      })),
      /*
       * Built from the blocks, not from `comment_text`.
       *
       * ClickUp's own plain-text rendering of a comment emits the literal
       * string "undefined" for anything it cannot flatten — a table, most
       * often — so a comment carrying the one thing worth reading arrived with
       * a hole where it had been. Measured on a real card: the blocks hold the
       * text, `comment_text` holds "undefined" in the middle of it.
       *
       * And the blocks hold the FORMATTING, which is the other half: headings,
       * bold, inline code and fenced blocks are all attributes on those pieces,
       * and joining their text threw every one away. `commentMarkdown` reads
       * them. `comment_text` is only the fallback for a comment that has no
       * blocks at all.
       *
       * Oldest first. A conversation read newest-first is a conversation read
       * backwards: the reply lands before the thing it replies to, which is
       * how "this looks good" ends up above what was good.
       */
      comments: (await Promise.all((c.data?.comments ?? []).map(async (x) => {
        const text = commentMarkdown(x.comment ?? []) || (x.comment_text ?? "");
        return {
          id: x.id, who: x.user?.username ?? "", text,
          at: Number(x.date) || 0,
          /* The same three the reply rows already carry: a picture when there
             is one, initials in the workspace's own colour when there is not. */
          ...(x.user?.profilePicture ? { avatar: x.user.profilePicture } : null),
          initials: x.user?.initials || initialsOf(x.user?.username ?? ""),
          ...(x.user?.color ? { color: x.user.color } : null),
          replies: x.reply_count || undefined,
          replyList: x.reply_count ? await commentReplies(x.id, token, me) : undefined,
          /* Whose it is, decided HERE. ClickUp refuses an edit on somebody
             else's comment, and a panel that offers the button anyway teaches
             people that the button lies. Compared by id rather than by name:
             two people share initials on a real board and one of them is
             usually the one you are. */
          ...(me && String(x.user?.id ?? "") === String(me) ? { mine: true } : null),
          ...(x.resolved ? { resolved: true } : null),
        };
      }))).sort((a, b) => a.at - b.at),
    },
  };
}

/**
 * The replies under one comment.
 *
 * A separate endpoint in the workspace's API — `/comment/<id>/reply` — and the
 * reason a threaded comment arrived as a bare count. Only asked for when the
 * count says there is something to ask about, so a card of unthreaded comments
 * costs exactly the calls it did before.
 *
 * A failure returns nothing rather than propagating. The card is the thing
 * somebody opened; losing all of it because one thread would not load is a
 * worse answer than a comment that still shows its count and cannot expand.
 */
async function commentReplies(commentId: string, token: string, me?: string): Promise<TaskReply[]> {
  const r = await call<{ comments?: {
    id: string; comment_text?: string; date?: string;
    user?: { id?: number | string; username?: string; initials?: string; color?: string; profilePicture?: string };
    comment?: DeltaBlock[];
  }[] }>(`/comment/${encodeURIComponent(commentId)}/reply`, token);
  if (!r.ok) return [];
  return (r.data?.comments ?? [])
    .map((x) => {
      const who = x.user?.username ?? "";
      return {
        id: x.id,
        who,
        /* Yours or somebody else's, which is the whole of what the row's Edit
           and Delete are allowed to key off: ClickUp refuses both on a comment
           you did not write, and an action that is always refused is worse than
           no action at all. */
        ...(me && String(x.user?.id ?? "") === String(me) ? { mine: true } : null),
        // The same blocks-first treatment as the parent: `comment_text` emits
        // the literal string "undefined" for anything it cannot flatten.
        text: commentMarkdown(x.comment ?? []) || (x.comment_text ?? ""),
        at: Number(x.date) || 0,
        avatar: x.user?.profilePicture || undefined,
        initials: x.user?.initials || initialsOf(who),
        color: x.user?.color || undefined,
      };
    })
    // Oldest first, like the thread above it. A reply read before the reply it
    // answers is the same defect one level down.
    .sort((a, b) => a.at - b.at);
}

/** A list's own tasks, for an address that pointed at a list rather than a
 *  view. Same pagination rule as a view: follow to the end, then stop. */
export async function rawListTasks(
  token: string, listId: string, myId?: string,
): Promise<CallResult<{ tasks: ProviderTask[]; truncated: boolean }>> {
  const out: ProviderTask[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await call<{ tasks?: RawTask[]; last_page?: boolean }>(
      /*
       * `include_closed=true`, because a status of type `closed` is still a
       * status a person groups by. It was false, so COMPLETED — 199 of the 252
       * cards on one real list — was not merely collapsed, it was never
       * fetched, and the board could not have shown that group however it was
       * asked. "I need every status to show up in the lists."
       *
       * Whether a done group is SHOWN is a separate decision the panel already
       * makes (see `showDone`); this is about whether it can be.
       */
      `/list/${encodeURIComponent(listId)}/task?page=${page}&include_closed=true`, token, LIST_TIMEOUT_MS,
    );
    if (!r.ok) return out.length ? { ok: true, data: { tasks: out, truncated: true } } : { ...r, data: undefined };
    for (const raw of r.data?.tasks ?? []) out.push(toTask(raw, myId));
    if (r.data?.last_page !== false) return { ok: true, data: { tasks: out, truncated: false } };
  }
  return { ok: true, data: { tasks: out, truncated: true } };
}

// ---------------------------------------------------------------------------
// finding one card
// ---------------------------------------------------------------------------

/**
 * A card you know the number of, which is not the same as a board you work from.
 *
 * "What was 20542 again?" is a question with no board attached: the card is on
 * some other list, in a project you are not in, and adding that whole board to
 * look at one row is absurd. So one card can be fetched on its own.
 *
 * The workspace's own id shape is DERIVED rather than configured. These ids are
 * a prefix and a number, the prefix is the same for every card in a workspace,
 * and we already hold dozens of them — so typing the number alone is enough,
 * and nobody has to be asked what their prefix is or told they got it wrong.
 */
export function normaliseCardQuery(text: string, knownPrefix: string): string | null {
  const q = (text || "").trim();
  if (!q) return null;
  // Already shaped like an id — letters, a hyphen, digits.
  if (/^[A-Za-z][\w]*-\d+$/.test(q)) return q.toUpperCase();
  // A bare number: only meaningful once we have seen what this workspace's ids
  // look like. Without that, guessing a prefix would produce a 404 that looks
  // like "no such card" when the truth is "I do not know your naming".
  if (/^\d{3,}$/.test(q)) return knownPrefix ? `${knownPrefix}${q}` : null;
  // An internal id: ClickUp's are lowercase alphanumeric, no hyphen.
  if (/^[a-z0-9]{6,}$/i.test(q) && !/^\d+$/.test(q)) return q;
  return null;
}

export interface FoundCard { task: ProviderTask; asked: string }

export async function findCard(text: string, knownPrefix: string): Promise<CallResult<FoundCard>> {
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "ClickUp is not connected" };
  const asked = normaliseCardQuery(text, knownPrefix);
  if (!asked) {
    return { ok: false, error: knownPrefix ? "That does not look like a card id" : "Open a board first, so I know what your ids look like" };
  }
  const me = redacted("clickup");
  const custom = /-/.test(asked);
  // `custom_task_ids` needs the workspace alongside it — the human id is only
  // unique within one.
  const q = custom && me?.workspaceId ? `?custom_task_ids=true&team_id=${encodeURIComponent(me.workspaceId)}` : "";
  const r = await call<RawTask>(`/task/${encodeURIComponent(asked)}${q}`, token);
  if (!r.ok) {
    /*
     * A card that does not exist answers 401, not 404 — verified against a real
     * workspace by asking for a number nobody has used. Reported as "refused
     * this token", that reads as a broken credential and sends somebody to
     * Settings to reconnect a connection that was never broken.
     *
     * There is no way to tell the two apart from here, so the message says
     * both, in the order they are likely: a mistyped number is common, a
     * revoked token is not. The card status pill stays untouched, so a genuinely
     * dead token still shows up where it belongs.
     */
    if (r.unauthorised) return { ok: false, error: `No card called ${asked} — or it is one this token cannot see` };
    return { ok: false, error: r.error ?? `Could not find ${asked}` };
  }
  if (!r.data?.id) return { ok: false, error: `No card called ${asked}` };
  return { ok: true, data: { task: toTask(r.data, me?.accountId), asked } };
}

// ---------------------------------------------------------------------------
// the pull requests a card produced
// ---------------------------------------------------------------------------

/**
 * Which pull requests belong to a card.
 *
 * ClickUp's own GitHub panel knows this and does not tell anyone: the v2 API
 * exposes no endpoint for those links — checked against a card whose sidebar
 * showed two, and neither the task, its `linked_tasks`, its attachments nor any
 * `/task/{id}/…` route mentioned them.
 *
 * What DOES work is the convention the team already follows. The card id goes
 * in the branch name and the commit, so GitHub's own search finds every pull
 * request for a card — measured on that same card: `gh pr list --search
 * <card-id>` returned both, one open and one merged, exactly the two ClickUp
 * was showing.
 *
 * The `Github Url` custom field is used as well, because somebody typing a link
 * by hand is a statement of intent that outranks a search, and because a pull
 * request in another repository will never be found by searching this one.
 * Union of the two, the field first.
 */
export type { CardPr };

/** A pull-request number out of a GitHub URL, and nothing else out of anything
 *  else. A bare number in that field would be ambiguous — issue or PR — so it
 *  has to be a link that says `/pull/`. */
export function prNumberFromUrl(url: string): number | null {
  const m = /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/i.exec(url || "");
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Does this pull request actually name that card?
 *
 * GitHub's search does not answer the question it was asked. `ORBIT-1042` is
 * tokenised at the hyphen, so the search matches anything carrying the bare
 * number — and MEASURED on his own repository, all three "linked" pull requests
 * were false:
 *
 *   #1042  matched by its own NUMBER. Its title and body contain no "1042"
 *           at all, and its branch is ORBIT-2318-…
 *   #1436  its body says "PR #1042 (ORBIT-2318, inline FAQ default) was
 *           previously merged into this branch" — a mention of another PR.
 *   #1188  its body lists in-flight pull requests: (#667, …, #1042).
 *
 * Quoting the term does not help: `"ORBIT-1042"` as a phrase answers with
 * nothing, because the phrase genuinely appears nowhere. The search is still
 * the right way to FIND candidates — the id can be in a branch, a title or a
 * body and which of those is not ours to assume — so it stays, and every row it
 * returns is then checked for the id itself.
 *
 * The boundary matters as much as the string: `ORBIT-104` must not match
 * `ORBIT-1042`, and a trailing letter or digit is what tells them apart.
 */
export function mentionsCard(cardId: string, pr: { title?: string; body?: string; headRefName?: string }): boolean {
  const id = cardId.trim();
  if (!id) return false;
  /* A hyphen AFTER the id is not a different id — a branch is literally
     `ORBIT-1042-caller-number-not-found`. A word character is: `ORBIT-104`
     must not match inside `ORBIT-1042`, and `ORBIT-1042` must not match inside
     `ORBIT-10420`. */
  const re = new RegExp(`(^|[^\\w])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\w)`, "i");
  return re.test(`${pr.headRefName ?? ""} ${pr.title ?? ""} ${pr.body ?? ""}`);
}

export async function cardPullRequests(
  cardId: string, fieldUrl: string | undefined, root: string,
): Promise<{ ok: boolean; prs: CardPr[]; error?: string }> {
  const { gh } = await import("./prs.ts");
  const out = new Map<number, CardPr>();

  const stated = prNumberFromUrl(fieldUrl ?? "");
  if (stated) {
    out.set(stated, { number: stated, title: "", state: "", url: fieldUrl!, stated: true });
  }

  if (!cardId) return { ok: true, prs: [...out.values()] };
  // `--search` rather than a filter: the id appears in a branch, a title or a
  // commit, and which of those is not ours to assume.
  const r = await gh(
    ["pr", "list", "--search", cardId, "--state", "all", "--limit", "20",
      // `body` and `headRefName` are not decoration: they are what the rows are
      // CHECKED against below. Without them the search's own idea of a match is
      // the final answer, and that idea is wrong — see the filter.
      "--json", "number,title,state,isDraft,url,body,headRefName"],
    root,
  );
  if (r.code !== 0) {
    // A search that failed is not a card with no pull requests. Whatever the
    // field said still stands, and the caller is told the rest is unknown.
    return { ok: false, prs: [...out.values()], error: r.stderr.trim().slice(0, 160) || "could not search GitHub" };
  }
  try {
    const rows = JSON.parse(r.stdout) as { number: number; title: string; state: string; isDraft?: boolean; url: string; body?: string; headRefName?: string }[];
    for (const p of rows) {
      // Every row is checked. GitHub's search does not answer the question we
      // asked it — see `mentionsCard`.
      if (!mentionsCard(cardId, p)) continue;
      const had = out.get(p.number);
      out.set(p.number, {
        number: p.number, title: p.title, state: p.state, draft: p.isDraft, url: p.url,
        stated: had?.stated,
      });
    }
  } catch { /* a search that answered nothing usable is a search with no rows */ }

  return {
    ok: true,
    // Stated first, then by number descending — newest work at the top, which
    // is the one somebody is looking for.
    prs: [...out.values()].sort((a, b) => Number(!!b.stated) - Number(!!a.stated) || b.number - a.number),
  };
}

// ---------------------------------------------------------------------------
// the shape of the workspace: spaces, folders, and the lists inside them
// ---------------------------------------------------------------------------

/**
 * The picker's data, and it is one call per level rather than the three the
 * hierarchy suggests.
 *
 * Measured against a real workspace: `/space/{id}/folder` answers with each
 * folder AND the lists inside it — fifteen folders and their lists in a single
 * request. So "add the Crimson folder" needs no walk of its lists, and neither
 * does re-reading it later to notice a list somebody added this morning.
 *
 * That is what makes a saved folder worth storing as a FOLDER: the app keeps
 * an id, and the contents are whatever ClickUp says they are today.
 */
export async function clickupSpaces(): Promise<CallResult<{ spaces: { id: string; name: string }[] }>> {
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "ClickUp is not connected" };
  const me = redacted("clickup");
  if (!me?.workspaceId) return { ok: false, error: "No ClickUp workspace chosen yet" };
  const r = await call<{ spaces?: { id: string; name?: string }[] }>(
    `/team/${encodeURIComponent(me.workspaceId)}/space?archived=false`, token,
  );
  if (!r.ok) return { ...r, data: undefined };
  return { ok: true, data: { spaces: (r.data?.spaces ?? []).map((s) => ({ id: String(s.id), name: s.name ?? "" })).filter((s) => s.id) } };
}

export interface ClickUpFolder {
  id: string;
  name: string;
  lists: { id: string; name: string; tasks?: number; color?: string }[];
  /** Not a folder at all: the lists that sit directly in the space, gathered
   *  under one heading so the rest of the app keeps one shape. See the note in
   *  clickupFolders. */
  folderless?: boolean;
}

export async function clickupFolders(spaceId: string): Promise<CallResult<{ folders: ClickUpFolder[] }>> {
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "ClickUp is not connected" };
  const id = String(spaceId || "").trim();
  // An id, and only an id: this reaches a URL, and a space id from the UI must
  // not be able to become a path of its own.
  if (!/^[0-9]+$/.test(id)) return { ok: false, error: "not a space id" };
  /*
   * TWO CALLS, because a space holds two kinds of thing.
   *
   * `/space/{id}/folder` returns the folders. It does NOT return the lists that
   * sit directly in the space — ClickUp calls those folderless, and its own
   * sidebar draws them below the folders as peers. This asked for folders only,
   * so those lists were invisible here however large they were.
   *
   * Measured on a real workspace: five folderless lists in one space, the
   * biggest of them holding 1,390 tasks, and none of them reachable from this
   * picker. The reported symptom was "I cannot find it from here", which is an
   * exact description.
   *
   * Both calls, in parallel: they are independent and the picker is a screen
   * somebody is waiting on.
   */
  const [r, loose] = await Promise.all([
    call<{ folders?: { id: string; name?: string; archived?: boolean; lists?: { id: string; name?: string; archived?: boolean }[] }[] }>(
      `/space/${encodeURIComponent(id)}/folder?archived=false`, token,
    ),
    call<{ lists?: { id: string; name?: string; archived?: boolean; task_count?: number; status?: { color?: string } | null }[] }>(
      `/space/${encodeURIComponent(id)}/list?archived=false`, token,
    ),
  ]);
  if (!r.ok) return { ...r, data: undefined };
  const folders = (r.data?.folders ?? [])
    .filter((f) => f && !f.archived)
    .map((f) => ({
      id: String(f.id),
      name: f.name ?? "",
      lists: (f.lists ?? []).filter((l) => l && !l.archived).map((l) => ({ id: String(l.id), name: l.name ?? "" })),
    }))
    .filter((f) => f.id);

  /*
   * The folderless lists arrive as ONE pseudo-folder rather than as loose rows,
   * because everything downstream of this — the picker, the saved board, the
   * refresh — is built around "a folder has lists". Inventing a second shape
   * here would mean teaching all of it a second shape.
   *
   * `folderless: true` so the UI can draw it as what it is rather than as a
   * folder that happens to be named after the space, and the id is the SPACE's
   * — which is true, and is what a refresh would have to ask about anyway.
   *
   * A failed second call is not a failed picker: the folders are still the
   * answer to most of the question, and a space whose folderless lists could
   * not be read is better than no space at all.
   */
  const strays = (loose.ok ? loose.data?.lists ?? [] : [])
    .filter((l) => l && !l.archived)
    /* The count comes back on this endpoint and the tracker's own sidebar
       shows it, which is how somebody recognises the list they mean among
       five with similar names. */
    /*
     * The list's own COLOUR, which is what the tracker draws its icon in.
     *
     * The emoji beside a list in their sidebar is not in the v2 API — asked
     * for directly, `/list/{id}` returns fifteen fields and none of them is an
     * icon. The colour IS there, on `status.color`, and it is the half that
     * does the work: `Bugs` is #e5484d, which is the red of the ladybird. A
     * dot in the list's own colour is recognisable across a rail in a way a
     * name in grey is not.
     */
    .map((l) => ({
      id: String(l.id), name: l.name ?? "",
      ...(typeof l.task_count === "number" ? { tasks: l.task_count } : {}),
      ...(l.status?.color ? { color: l.status.color } : {}),
    }))
    .filter((l) => l.id);

  return {
    ok: true,
    data: { folders: strays.length ? [...folders, { id, name: "Lists in this space", lists: strays, folderless: true }] : folders },
  };
}

/** One folder's lists, for a folder already saved — the same call as above,
 *  narrowed. Kept separate so a refresh of one board does not read a whole
 *  space's worth of folders. */
export async function clickupFolderLists(folderId: string): Promise<CallResult<{ name: string; lists: { id: string; name: string }[] }>> {
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "ClickUp is not connected" };
  const id = String(folderId || "").trim();
  if (!/^[0-9]+$/.test(id)) return { ok: false, error: "not a folder id" };
  const r = await call<{ name?: string; lists?: { id: string; name?: string; archived?: boolean }[] }>(
    `/folder/${encodeURIComponent(id)}`, token,
  );
  if (!r.ok) return { ...r, data: undefined };
  return {
    ok: true,
    data: {
      name: r.data?.name ?? "",
      lists: (r.data?.lists ?? []).filter((l) => l && !l.archived).map((l) => ({ id: String(l.id), name: l.name ?? "" })),
    },
  };
}
