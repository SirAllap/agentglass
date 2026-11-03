// One project, one session or one headless worker's row, on Starboard: the rows
// and events that belong to it, and the one stored choice that says which. Pure,
// so the whole selection can be checked against fixtures rather than a board.
// A worker fires no hooks, so its steps are its own tab, not events.
//
// An empty string means "all" on both axes, and a stored id that no longer
// names anything falls back to it: a selection is a convenience for this
// viewer, never a filter that can hide a fleet that is still running.
import type { CostByModel, ToolLatencyStat, WatchEvent } from "../../../shared/types.ts";
import type { LanternRow } from "../components/LanternView.tsx";
import { modelLabelOf } from "../../../shared/models.ts";
import { percentile } from "../../../shared/checkBaseline.ts";

/** `worker` names a headless worker's row, which has no hooked session to
 *  scope the event feed by: its turn writes no events (crewworker.ts). */
export interface Scope { project: string; session: string; worker?: string }
export const ALL_SCOPE: Scope = { project: "", session: "" };

export const isScoped = (s: Scope): boolean => !!(s.project || s.session || s.worker);

/** Whether the selection is one the event stream can answer: a headless
 *  worker's steps never reach it, so a worker alone leaves the tiles fleet-wide. */
export const isEventScoped = (s: Scope): boolean => !!(s.project || s.session);

/** The path a row belongs to; `worktree` when the server did not roll it up. */
export const projectOf = (r: LanternRow): string => r.project ?? r.worktree ?? "";

const sameProject = (r: LanternRow, project: string): boolean => !project || projectOf(r) === project;
const sameSession = (r: LanternRow, session: string): boolean => !session || r.session === session;
const isWorker = (r: LanternRow, worker: string): boolean => !!r.worker && r.name === worker;

export function rowMatches(r: LanternRow, scope: Scope): boolean {
  if (scope.worker) return isWorker(r, scope.worker);
  return sameProject(r, scope.project) && sameSession(r, scope.session);
}

export function filterRows(rows: readonly LanternRow[], scope: Scope): LanternRow[] {
  return rows.filter((r) => rowMatches(r, scope));
}

/** Whether a session id (as an event, alert or gate spells it) is inside the
 *  selection. A project is known only from the board's rows, so a session that
 *  is not on the board cannot be claimed as part of one. */
export function sessionMatches(sessionId: string, rows: readonly LanternRow[], scope: Scope): boolean {
  if (scope.session && sessionId !== scope.session) return false;
  if (!scope.project) return true;
  return rows.some((r) => r.session === sessionId && projectOf(r) === scope.project);
}

export function filterEvents(events: readonly WatchEvent[], rows: readonly LanternRow[], scope: Scope): WatchEvent[] {
  if (!isScoped(scope)) return [...events];
  return events.filter((e) => sessionMatches(e.session_id, rows, scope));
}

/** The projects and sessions offered by the header, from the rows in view. */
export function scopeChoices(rows: readonly LanternRow[]): { projects: string[]; sessions: LanternRow[] } {
  const projects = [...new Set(rows.map(projectOf).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const seen = new Set<string>();
  const sessions: LanternRow[] = [];
  for (const r of [...rows].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!r.session || seen.has(r.session)) continue;
    seen.add(r.session);
    sessions.push(r);
  }
  return { projects, sessions };
}

/**
 * A stored choice against the board as it is now.
 *
 * No rows at all is the connecting beat, not an empty fleet: validating
 * against it would throw away a choice the moment the socket reconnects. With
 * rows in hand, an id that names nothing — a session that ended, a checkout
 * that left — is dropped to All rather than left filtering nothing.
 */
export function resolveScope(scope: Scope, rows: readonly LanternRow[]): Scope {
  if (!isScoped(scope) || rows.length === 0) return scope;
  if (scope.worker && !rows.some((r) => isWorker(r, scope.worker!))) return ALL_SCOPE;
  if (scope.project && !rows.some((r) => projectOf(r) === scope.project)) return ALL_SCOPE;
  if (scope.session && !rows.some((r) => r.session === scope.session && sameProject(r, scope.project))) return ALL_SCOPE;
  return scope;
}

/** Picking a project resets the session: the old one need not live there. */
export const withProject = (scope: Scope, project: string): Scope => ({ project, session: "" });

/** A card selected twice is cleared; a different one replaces it. A session
 *  and a worker are two answers to the same question, so either clears the other. */
export const withSession = (scope: Scope, session: string): Scope =>
  ({ project: scope.project, session: scope.session === session ? "" : session });

/** A worker row selected twice is cleared, and it supersedes the session pick. */
export const withWorker = (scope: Scope, worker: string): Scope =>
  ({ project: scope.project, session: "", ...(scope.worker === worker ? {} : { worker }) });

/* ---------------------------------------------------------------- the choice */

const KEY = "agentglass.starboard.scope";

export function readScope(): Scope {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return ALL_SCOPE;
    const parsed = JSON.parse(raw) as Partial<Scope> | null;
    return {
      project: typeof parsed?.project === "string" ? parsed.project : "",
      session: typeof parsed?.session === "string" ? parsed.session : "",
      ...(typeof parsed?.worker === "string" && parsed.worker ? { worker: parsed.worker } : {}),
    };
  } catch { return ALL_SCOPE; }
}

/** Nothing selected removes the key, like every other fold in this app: a
 *  default worth writing down is one that will disagree with the code later. */
export function writeScope(scope: Scope): void {
  try {
    if (!isScoped(scope)) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify({ project: scope.project, session: scope.session, ...(scope.worker ? { worker: scope.worker } : {}) }));
  } catch { /* private mode, or a browser that has said no */ }
}

/* ------------------------------------------------- what the selected events say */

export interface ScopedSummary {
  totals: { events: number; sessions: number; tool_calls: number; tool_errors: number; cost_usd: number };
  tool_latency: ToolLatencyStat[];
  by_model: CostByModel[];
}

/** The tiles' arithmetic over the selected events, in /stats' own terms: a
 *  tool call is a Post, a failure is one of those with `is_error`. */
export function scopedSummary(events: readonly WatchEvent[], since = 0): ScopedSummary {
  const inWindow = since ? events.filter((e) => e.timestamp >= since) : events;
  const sessions = new Set<string>();
  const tools = new Map<string, { durs: number[]; errors: number; count: number }>();
  const models = new Map<string, { rows: WatchEvent[]; sessions: Set<string> }>();
  let toolCalls = 0, toolErrors = 0, cost = 0;

  for (const e of inWindow) {
    sessions.add(e.session_id);
    cost += e.cost_usd;
    const isTool = e.hook_event_type === "PostToolUse" || e.hook_event_type === "PostToolUseFailure";
    if (isTool) {
      toolCalls++;
      if (e.is_error) toolErrors++;
      if (e.tool_name) {
        const t = tools.get(e.tool_name) ?? { durs: [], errors: 0, count: 0 };
        t.count++;
        if (typeof e.duration_ms === "number") t.durs.push(e.duration_ms);
        if (e.is_error) t.errors++;
        tools.set(e.tool_name, t);
      }
    }
    const label = modelLabelOf(e.model_name);
    const m = models.get(label) ?? { rows: [], sessions: new Set<string>() };
    m.rows.push(e);
    m.sessions.add(e.session_id);
    models.set(label, m);
  }

  const tool_latency: ToolLatencyStat[] = [...tools.entries()].map(([tool_name, t]) => {
    const total = t.durs.reduce((a, b) => a + b, 0);
    return {
      tool_name, calls: t.count, timed: t.durs.length, errors: t.errors,
      p50_ms: percentile(t.durs, 0.5), p95_ms: percentile(t.durs, 0.95),
      max_ms: t.durs.length ? Math.max(...t.durs) : 0,
      avg_ms: t.durs.length ? Math.round(total / t.durs.length) : 0,
      total_ms: total,
    };
  }).sort((a, b) => b.total_ms - a.total_ms);

  const by_model: CostByModel[] = [...models.entries()].map(([model_name, m]) => ({
    model_name,
    input_tokens: m.rows.reduce((n, e) => n + e.input_tokens, 0),
    output_tokens: m.rows.reduce((n, e) => n + e.output_tokens, 0),
    cache_creation_tokens: m.rows.reduce((n, e) => n + e.cache_creation_tokens, 0),
    cache_read_tokens: m.rows.reduce((n, e) => n + e.cache_read_tokens, 0),
    equiv_tokens: m.rows.reduce((n, e) => n + (e.equiv_tokens ?? 0), 0),
    cost_usd: m.rows.reduce((n, e) => n + e.cost_usd, 0),
    sessions: m.sessions.size,
  })).sort((a, b) => b.cost_usd - a.cost_usd);

  return {
    totals: { events: inWindow.length, sessions: sessions.size, tool_calls: toolCalls, tool_errors: toolErrors, cost_usd: cost },
    tool_latency,
    by_model,
  };
}
