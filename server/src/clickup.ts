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
import { secretFor, annotate, fingerprint } from "./credentials.ts";
import type { ProviderTask, ClickUpUser, ClickUpWorkspace } from "../../shared/providers.ts";

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

const TIMEOUT_MS = 8_000;

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
async function call<T>(pathname: string, token: string): Promise<CallResult<T>> {
  if (budget && budget.remaining <= RESERVE && Date.now() < budget.resetAt) {
    return { ok: false, throttled: true, error: "Holding off — ClickUp's rate limit is nearly used up" };
  }
  const ctl = new AbortController();
  const kill = setTimeout(() => ctl.abort(), TIMEOUT_MS);
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
  name: string;
  url?: string;
  status?: { status?: string; type?: string };
  due_date?: string | number | null;
  date_updated?: string | number | null;
  priority?: { priority?: string } | null;
  tags?: { name?: string }[];
  list?: { name?: string } | null;
  assignees?: { username?: string }[];
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

export function toTask(raw: RawTask): ProviderTask {
  const kind = raw.status?.type;
  return {
    id: String(raw.id),
    title: raw.name ?? "(untitled)",
    url: raw.url ?? "",
    status: raw.status?.status ?? "",
    // ClickUp's status TYPE is the only portable thing about a status: the
    // names are per-list and a workspace may well have four words for "doing".
    statusKind: kind === "done" || kind === "closed" ? "done" : kind === "open" ? "open" : "other",
    priority: PRIORITY.has(raw.priority?.priority ?? "") ? (raw.priority!.priority as ProviderTask["priority"]) : null,
    due: localDay(raw.due_date),
    updated: Number(raw.date_updated) || 0,
    tags: (raw.tags ?? []).map((t) => t.name ?? "").filter(Boolean),
    list: raw.list?.name ?? null,
    assignees: (raw.assignees ?? []).map((a) => a.username ?? "").filter(Boolean),
  };
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
  const q = new URLSearchParams({
    page: String(page),
    order_by: "due_date",
    subtasks: "true",
    include_closed: "false",
  });
  q.append("assignees[]", userId);
  const r = await call<{ tasks: RawTask[] }>(`/team/${encodeURIComponent(workspaceId)}/task?${q}`, token);
  if (!r.ok) return { ...r, data: undefined };
  const raw = r.data?.tasks ?? [];
  return { ok: true, data: { tasks: raw.map(toTask), more: raw.length >= 100 } };
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
