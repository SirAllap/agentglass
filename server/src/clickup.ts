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
import { secretFor, annotate, redacted, fingerprint } from "./credentials.ts";
import type { ProviderTask, ClickUpUser, ClickUpWorkspace, ListStatus, ListField, TaskDetail } from "../../shared/providers.ts";

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
    const remaining = Number(r.headers.get("x-ratelimit-remaining"));
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
  status?: { status?: string; type?: string };
  due_date?: string | number | null;
  date_updated?: string | number | null;
  priority?: { priority?: string } | null;
  tags?: { name?: string }[];
  list?: { id?: string; name?: string } | null;
  assignees?: { id?: string | number; username?: string }[];
  points?: number | null;
  custom_fields?: RawField[];
}

interface RawField {
  id: string;
  name: string;
  type: string;
  value?: unknown;
  type_config?: { options?: { id: string; name?: string; label?: string; orderindex?: number }[] };
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

export function toTask(raw: RawTask, myId?: string): ProviderTask {
  const kind = raw.status?.type;
  const assignees = raw.assignees ?? [];
  return {
    id: String(raw.id),
    customId: raw.custom_id ? String(raw.custom_id) : undefined,
    title: raw.name ?? "(untitled)",
    url: raw.url ?? "",
    status: raw.status?.status ?? "",
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
    assignees: assignees.map((a) => a.username ?? "").filter(Boolean),
    // Resolved here, against the connected account. The browser has no business
    // knowing your ClickUp user id, and a client-side comparison would need it.
    mine: myId ? assignees.some((a) => String(a.id ?? "") === myId) : undefined,
    points: typeof raw.points === "number" ? raw.points : null,
    custom: (raw.custom_fields ?? [])
      .map((f) => ({ id: f.id, name: f.name, value: fieldText(f) }))
      .filter((f) => f.value),
  };
}

/**
 * A custom field's value as something readable.
 *
 * ClickUp answers with the raw storage: a drop-down is the INDEX of the chosen
 * option, not its name, so printing `value` gives you "3" where the board says
 * "Purple". Resolved against `type_config.options` here so nothing downstream
 * has to know that.
 */
function fieldText(f: RawField): string {
  const v = f.value;
  if (v === undefined || v === null || v === "") return "";
  if (f.type === "drop_down") {
    const opts = f.type_config?.options ?? [];
    const hit = opts.find((o) => o.orderindex === Number(v) || o.id === String(v));
    return hit?.name ?? hit?.label ?? "";
  }
  if (Array.isArray(v)) return v.map((x) => (typeof x === "object" && x ? String((x as { name?: string }).name ?? "") : String(x))).filter(Boolean).join(", ");
  if (typeof v === "object") return String((v as { username?: string }).username ?? "");
  return String(v);
}

export interface TaskPage {
  tasks: ProviderTask[];
  /** True when ClickUp returned a full page, so there is more behind it. Said
   *  out loud rather than silently truncated — a list that stops at 100 with no
   *  note reads as "that is all of them". */
  more: boolean;
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
  return { ok: true, data: { tasks: raw.map((t) => toTask(t, userId)), more: raw.length >= 100 } };
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
async function identity(token: string): Promise<{ workspaceId?: string; userId?: string }> {
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
 * (`6-901715483311-1`); the number in the middle of one is the LIST behind it,
 * which is worth having because a list knows its own statuses and a view does
 * not. Verified against a real board: the full hyphenated string resolves,
 * the middle number alone 404s as a view and 200s as a list.
 */
export interface ParsedViewUrl {
  workspaceId?: string;
  kind: "view" | "list";
  viewId?: string;
  listId?: string;
}

const VIEW_PATH = /\/(\d+)\/v\/([a-z]+)\/([\w-]+)/i;

export function parseViewUrl(raw: string): ParsedViewUrl | null {
  const text = (raw || "").trim();
  if (!text) return null;

  // A bare id, pasted on its own. Checked BEFORE the URL parse, because
  // `new URL("https://6-901715483311-1")` is a perfectly valid URL whose host
  // is that string — so an id would be judged as coming from the wrong domain
  // and thrown away.
  if (!text.includes("/") && /^\d+-\d{6,}-\d+$/.test(text)) {
    return { kind: "view", viewId: text, listId: text.split("-")[1] };
  }

  let host = "", path = text;
  try {
    const u = new URL(text.startsWith("http") ? text : `https://${text}`);
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    // Not a URL — maybe somebody pasted just the path, or just an id.
  }
  // The domain, not the subdomain. Anything else is not ours to interpret.
  if (host && !host.endsWith("clickup.com")) return null;

  const m = VIEW_PATH.exec(path);
  if (m) {
    const [, workspaceId, kind, id] = m as unknown as [string, string, string, string];
    if (kind.toLowerCase() === "li") return { workspaceId, kind: "list", listId: id };
    // A view id looks like `6-901715483311-1`; the middle segment is the list.
    const parts = id.split("-");
    const listId = parts.length >= 2 && /^\d{6,}$/.test(parts[1]!) ? parts[1] : undefined;
    return { workspaceId, kind: "view", viewId: id, listId };
  }
  return null;
}

/** What ClickUp calls this view, so a saved entry is named by the service
 *  rather than by whoever pasted the link. */
export async function viewMeta(token: string, viewId: string): Promise<CallResult<{ name: string; type: string }>> {
  const r = await call<{ view?: { name?: string; type?: string } }>(`/view/${encodeURIComponent(viewId)}`, token);
  if (!r.ok) return { ...r, data: undefined };
  const v = r.data?.view;
  if (!v) return { ok: false, error: "ClickUp did not recognise that view" };
  return { ok: true, data: { name: v.name || "Untitled view", type: v.type || "list" } };
}

/** A list's own statuses and custom fields — the two things a view cannot tell
 *  us, and the two a picker needs in order not to guess. */
export async function listMeta(
  token: string, listId: string,
): Promise<CallResult<{ name: string; statuses: ListStatus[]; fields: ListField[] }>> {
  const l = await call<{ name?: string; statuses?: { status: string; type: string; orderindex: number; color?: string }[] }>(
    `/list/${encodeURIComponent(listId)}`, token,
  );
  if (!l.ok) return { ...l, data: undefined };
  const f = await call<{ fields?: { id: string; name: string; type: string; type_config?: { options?: { id: string; name?: string; label?: string }[] } }[] }>(
    `/list/${encodeURIComponent(listId)}/field`, token,
  );
  return {
    ok: true,
    data: {
      name: l.data?.name ?? "",
      statuses: (l.data?.statuses ?? []).map((s) => ({
        status: s.status, type: s.type, orderindex: s.orderindex, color: s.color,
      })).sort((a, b) => a.orderindex - b.orderindex),
      fields: (f.data?.fields ?? []).map((x) => ({
        id: x.id, name: x.name, type: x.type,
        options: (x.type_config?.options ?? []).map((o) => ({ id: o.id, name: o.name ?? o.label ?? "" })).filter((o) => o.name),
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
export const CLICKUP_WRITE_ENABLED = process.env.AGENTGLASS_CLICKUP_WRITE === "1";

export interface WriteOutcome {
  ok: boolean;
  error?: string;
  /** The task as it stands after the write, re-read rather than assumed. */
  task?: ProviderTask;
  /** Somebody else changed it between the read and the write. */
  conflict?: boolean;
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
  if (!CLICKUP_WRITE_ENABLED) return { ok: false, error: "Writing to ClickUp is switched off" };
  const me = redacted("clickup")?.accountId;
  if (!me) return { ok: false, error: "Do not know which ClickUp account this is" };
  const stale = await guardUnchanged(token, taskId, expectUpdated);
  if (stale) return { ok: false, conflict: true, error: stale };
  const n = Number(me);
  const r = await put(`/task/${encodeURIComponent(taskId)}`, token, {
    assignees: on ? { add: [n] } : { rem: [n] },
  });
  __reset();
  return r.ok ? { ok: true, task: toTask(r.data!, me) } : { ok: false, error: r.error };
}

/** Move a card to another status. The value must be one the LIST accepts —
 *  the caller offers those and never a free-text box, so this cannot be asked
 *  to invent one. */
export async function setStatus(taskId: string, status: string, expectUpdated?: number): Promise<WriteOutcome> {
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "ClickUp is not connected" };
  if (!CLICKUP_WRITE_ENABLED) return { ok: false, error: "Writing to ClickUp is switched off" };
  if (!status.trim()) return { ok: false, error: "no status given" };
  const stale = await guardUnchanged(token, taskId, expectUpdated);
  if (stale) return { ok: false, conflict: true, error: stale };
  const r = await put(`/task/${encodeURIComponent(taskId)}`, token, { status });
  __reset();
  const me = redacted("clickup")?.accountId;
  return r.ok ? { ok: true, task: toTask(r.data!, me) } : { ok: false, error: r.error };
}

/** A drop-down custom field, by id, to one of its own options. */
export async function setField(taskId: string, fieldId: string, optionId: string): Promise<WriteOutcome> {
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "ClickUp is not connected" };
  if (!CLICKUP_WRITE_ENABLED) return { ok: false, error: "Writing to ClickUp is switched off" };
  const ctl = new AbortController();
  const kill = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${base}/task/${encodeURIComponent(taskId)}/field/${encodeURIComponent(fieldId)}`, {
      method: "POST",
      headers: { Authorization: token, "content-type": "application/json" },
      body: JSON.stringify({ value: optionId }),
      signal: ctl.signal,
    });
    __reset();
    if (r.status === 401 || r.status === 403) return { ok: false, error: "ClickUp refused this token" };
    if (!r.ok) return { ok: false, error: `ClickUp answered ${r.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not reach ClickUp" };
  } finally { clearTimeout(kill); }
}

/** The full card: description, subtasks, checklists — everything the list row
 *  cannot hold. Read on demand, never for every row. */
export async function taskDetail(taskId: string): Promise<CallResult<TaskDetail>> {
  const token = secretFor("clickup");
  if (!token) return { ok: false, error: "ClickUp is not connected" };
  const r = await call<RawTask & {
    description?: string; markdown_description?: string;
    subtasks?: RawTask[];
    checklists?: { name?: string; items?: { name?: string; resolved?: boolean }[] }[];
  }>(`/task/${encodeURIComponent(taskId)}?include_subtasks=true&include_markdown_description=true`, token);
  if (!r.ok) return { ...r, data: undefined };
  const d = r.data!;
  const me = redacted("clickup")?.accountId;
  const c = await call<{ comments?: { id: string; comment_text?: string; user?: { username?: string }; date?: string }[] }>(
    `/task/${encodeURIComponent(taskId)}/comment`, token,
  );
  return {
    ok: true,
    data: {
      task: toTask(d, me),
      description: d.markdown_description || d.description || "",
      subtasks: (d.subtasks ?? []).map((t) => toTask(t, me)),
      checklists: (d.checklists ?? []).map((cl) => ({
        name: cl.name ?? "",
        items: (cl.items ?? []).map((i) => ({ name: i.name ?? "", done: !!i.resolved })),
      })),
      comments: (c.data?.comments ?? []).map((x) => ({
        id: x.id, who: x.user?.username ?? "", text: x.comment_text ?? "", at: Number(x.date) || 0,
      })),
    },
  };
}

/** A list's own tasks, for an address that pointed at a list rather than a
 *  view. Same pagination rule as a view: follow to the end, then stop. */
export async function rawListTasks(
  token: string, listId: string, myId?: string,
): Promise<CallResult<{ tasks: ProviderTask[]; truncated: boolean }>> {
  const out: ProviderTask[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await call<{ tasks?: RawTask[]; last_page?: boolean }>(
      `/list/${encodeURIComponent(listId)}/task?page=${page}&include_closed=false`, token, LIST_TIMEOUT_MS,
    );
    if (!r.ok) return out.length ? { ok: true, data: { tasks: out, truncated: true } } : { ...r, data: undefined };
    for (const raw of r.data?.tasks ?? []) out.push(toTask(raw, myId));
    if (r.data?.last_page !== false) return { ok: true, data: { tasks: out, truncated: false } };
  }
  return { ok: true, data: { tasks: out, truncated: true } };
}
