// Proactive insights: things the fleet is doing that you'd want flagged —
// runaway loops, fast burn, high failure rates, overall spend velocity.
// Computed from the full event history (better than the live buffer for loops).
import type { Insight } from "../../shared/types.ts";
import { db, scopeClause } from "./db.ts";
import { cacheRebuildPenaltyUsd, equivalentTokens } from "./pricing.ts";
import { budgetStatus, budgetScopeLabel, periodLabel } from "./budget.ts";

const key = (app: string, sid: string) => `${app}:${sid.slice(0, 8)}`;
// The row identity the session-scoped queries group by. `key` is the label the
// card shows: it shortens the session id to fit, and two rows are allowed to
// render the same one. An id is a React key, so it carries the pair in full —
// and escapes it, because an app `a:b` in session `c` and an app `a` in session
// `b:c` are different rows that a plain join hands the same string.
const rowId = (app: string, sid: string) => `${encodeURIComponent(app)}:${encodeURIComponent(sid)}`;
const trim = (s: string, n = 64) => (s.length > n ? s.slice(0, n) + "…" : s);
const USD = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The bundled cache-write rates describe five-minute prompt caches. A smaller
// creation is usually normal turn churn; keep this signal for prefixes large
// enough to be useful rather than announcing pennies on every resumed chat.
export const CACHE_REBUILD_WINDOW_MS = 5 * 60_000;
export const CACHE_REBUILD_LOOKBACK_MS = 24 * 60 * 60_000;
export const CACHE_REBUILD_MIN_TOKENS = 10_000;
/** As many cards as the loop block allows itself, and for the same reason: the
 *  panel is a place to look, not a list to scroll. Six rather than the four the
 *  burn and failure blocks use, because this one reports per session and a fleet
 *  where several sessions each rebuilt something is exactly when it is worth
 *  reading. */
export const CACHE_REBUILD_CARDS = 6;

/**
 * The dearest few rebuilds, dearest first.
 *
 * Every other block here stops itself in SQL — `LIMIT 6` for loops, `LIMIT 4`
 * for burn and failures. This one aggregates per session in JS, so the cap
 * lives here, and it cuts by what the rebuild actually cost rather than by
 * whatever order the map happened to be filled in.
 */
export function topRebuilds<T extends { penalty: number }>(
  rows: Map<string, T>,
  n: number = CACHE_REBUILD_CARDS,
): [string, T][] {
  return [...rows.entries()].sort((a, b) => b[1].penalty - a[1].penalty).slice(0, n);
}

export function getInsights(): Insight[] {
  const now = Date.now();
  const out: Insight[] = [];
  // Scope like every other metric: a cockpit scoped to one project must not
  // surface another project's loop / burn / failure rate. Computed once and
  // appended to each query below (bind order: timestamp first, then these).
  // Empty when nothing is scoped, so a whole-machine view is unchanged; `AND 0`
  // when the scope has no events yet, so those queries honestly return nothing.
  const { clause: sc, args: sa } = scopeClause();

  // 1) Loops — the SAME command run over and over (real waste). Restricted to
  //    Bash on an identical command; iterative Edits to a file aren't a loop.
  const loops = db
    .query<{ source_app: string; session_id: string; cmd: string; n: number; last: number }, any[]>(
      `SELECT source_app, session_id, json_extract(payload,'$.tool_input.command') AS cmd,
              COUNT(*) n, MAX(timestamp) last
       FROM events
       WHERE hook_event_type = 'PreToolUse' AND tool_name = 'Bash'
             AND cmd IS NOT NULL AND timestamp > ?${sc}
       GROUP BY source_app, session_id, cmd
       HAVING n >= 6
       ORDER BY n DESC LIMIT 6`
    )
    .all(now - 30 * 60_000, ...sa);
  for (const l of loops) {
    out.push({
      id: `loop:${rowId(l.source_app, l.session_id)}:${l.cmd}`,
      severity: l.n >= 15 ? "bad" : "warn",
      kind: "loop",
      title: `Possible loop · ${l.n}× identical command`,
      detail: trim(String(l.cmd).replace(/\s+/g, " ")),
      session: key(l.source_app, l.session_id),
      ts: l.last,
    });
  }

  // 2) Fast burn — a session spending a lot in the last 15 minutes.
  const spend = db
    .query<{ source_app: string; session_id: string; cost: number; last: number }, any[]>(
      `SELECT source_app, session_id, ROUND(SUM(cost_usd),2) cost, MAX(timestamp) last
       FROM events WHERE timestamp > ?${sc} GROUP BY source_app, session_id
       HAVING cost >= 15 ORDER BY cost DESC LIMIT 4`
    )
    .all(now - 15 * 60_000, ...sa);
  for (const s of spend) {
    out.push({
      id: `spend:${rowId(s.source_app, s.session_id)}`,
      severity: s.cost >= 40 ? "bad" : "warn",
      kind: "spend",
      title: `Burning fast · $${s.cost.toFixed(2)} in 15m`,
      detail: "this session is spending quickly",
      session: key(s.source_app, s.session_id),
      ts: s.last,
    });
  }

  // 3) Cache rebuilds — a sizeable cache creation after the previous
  // cache-bearing turn in the same model/agent lineage has expired.
  //
  // One pass over the window, not a lookup per candidate. Asking the session
  // index for the prior cache-bearing turn once per candidate row reads as the
  // cheaper shape and is not: SQLite answers it by walking every event that
  // shares the model name, which on a desk running one model most of the day is
  // most of the table. Measured, `getInsights()` went from 11ms against an empty
  // database to 46 SECONDS against a day of turns — on a route the alerts panel
  // polls every fifteen seconds, served inline off a synchronous handle, so that
  // is the whole server not answering. LAG over the same partition asks the same
  // question once. See scripts/perfbudget.ts, which now measures with rows in
  // the table so this cannot pass unnoticed again.
  //
  // One consequence worth stating: the prior turn must itself fall inside the
  // lookback window, so the first candidate after a full day of silence is not
  // flagged. Deliberate — a cache that expired yesterday is not news, and the
  // alternative is an unbounded reach backwards on every poll.
  const rebuildRows = db
    .query<{
      source_app: string; session_id: string; model_name: string | null;
      cache_creation_tokens: number; timestamp: number; previous_at: number;
    }, any[]>(
      `WITH turns AS (
         SELECT source_app, session_id, model_name, cache_creation_tokens, timestamp,
                LAG(timestamp) OVER (
                  PARTITION BY source_app, session_id, model_name,
                               COALESCE(NULLIF(agent_id, ''), 'main')
                  ORDER BY timestamp, id) AS previous_at
           FROM events
          WHERE timestamp > ?
            AND (cache_creation_tokens > 0 OR cache_read_tokens > 0)${sc}
       )
       SELECT source_app, session_id, model_name, cache_creation_tokens, timestamp, previous_at
         FROM turns
        WHERE cache_creation_tokens >= ?
          AND previous_at IS NOT NULL
          AND timestamp - previous_at > ?
        ORDER BY timestamp DESC`
    )
    .all(now - CACHE_REBUILD_LOOKBACK_MS, ...sa, CACHE_REBUILD_MIN_TOKENS, CACHE_REBUILD_WINDOW_MS);
  const rebuilds = new Map<string, {
    source_app: string; session_id: string; count: number; tokens: number;
    penalty: number; last: number;
  }>();
  for (const r of rebuildRows) {
    const penalty = cacheRebuildPenaltyUsd(r.cache_creation_tokens, r.model_name);
    if (!(penalty > 0)) continue;
    const id = rowId(r.source_app, r.session_id);
    const a = rebuilds.get(id) ?? {
      source_app: r.source_app, session_id: r.session_id,
      count: 0, tokens: 0, penalty: 0, last: 0,
    };
    a.count++;
    a.tokens += r.cache_creation_tokens;
    a.penalty += penalty;
    a.last = Math.max(a.last, r.timestamp);
    rebuilds.set(id, a);
  }
  for (const [id, r] of topRebuilds(rebuilds)) {
    out.push({
      id: `cache:${id}`,
      severity: r.penalty >= 5 ? "warn" : "info",
      kind: "cache",
      title: `Rebuilt expired cache · ${r.count}× · $${USD.format(r.penalty)}`,
      detail: `${Math.round(r.tokens / 1000)}k tokens paid at cache-write instead of cache-read rates`,
      session: key(r.source_app, r.session_id),
      ts: r.last,
    });
  }

  // 4) High failure rate — errors relative to tool calls in the last hour.
  const fails = db
    .query<{ source_app: string; session_id: string; errs: number; tools: number; last: number }, any[]>(
      // errs counts only tool failures, because tools is the denominator. It
      // used to be SUM(is_error) over every event — and an errored LLM span or
      // notification never enters `tools`, so the rate was unbounded: a session
      // with 6 non-tool errors and 4 tool calls announced "High failure rate ·
      // 150%" and, underneath it, "6 of 4 tool calls failed".
      `SELECT source_app, session_id,
              SUM(CASE WHEN hook_event_type IN ('PostToolUse','PostToolUseFailure') AND is_error = 1 THEN 1 ELSE 0 END) errs,
              SUM(CASE WHEN hook_event_type IN ('PostToolUse','PostToolUseFailure') THEN 1 ELSE 0 END) tools,
              MAX(timestamp) last
       FROM events WHERE timestamp > ?${sc} GROUP BY source_app, session_id
       HAVING tools >= 4 AND errs * 1.0 / tools > 0.3
       ORDER BY errs DESC LIMIT 4`
    )
    .all(now - 60 * 60_000, ...sa);
  for (const f of fails) {
    const pct = Math.round((f.errs / f.tools) * 100);
    out.push({
      id: `errors:${rowId(f.source_app, f.session_id)}`,
      severity: pct >= 50 ? "bad" : "warn",
      kind: "errors",
      title: `High failure rate · ${pct}%`,
      detail: `${f.errs} of ${f.tools} tool calls failed`,
      session: key(f.source_app, f.session_id),
      ts: f.last,
    });
  }

  // 5) Budgets — a number the user chose, which beats every constant above it.
  //
  //    Only when one is set. With none, everything here behaves exactly as it
  //    did, because a fixed threshold is a reasonable default and taking it
  //    away from people who never asked for budgets would be a regression
  //    dressed as a feature.
  //
  //    Unscoped by design: a budget names its own project, so it fires whether
  //    or not the cockpit is currently looking at that one. The whole point is
  //    to be told about a limit you set, not about the tab you have open.
  for (const s of budgetStatus(undefined, now)) {
    if (s.level === "ok") continue;
    const pct = Math.round(s.pct * 100);
    out.push({
      id: `budget:${s.budget.root}:${s.budget.model}:${s.budget.period}`,
      severity: s.level === "over" ? "bad" : "warn",
      kind: "spend",
      title: s.level === "over"
        ? `Over budget · $${s.spent.toFixed(2)} of $${s.budget.limit.toFixed(2)} ${periodLabel(s.budget.period)}`
        : `${pct}% of budget · $${s.spent.toFixed(2)} of $${s.budget.limit.toFixed(2)} ${periodLabel(s.budget.period)}`,
      detail: budgetScopeLabel(s.budget),
      session: null,
      ts: now,
    });
  }

  // 6) Spend velocity — overall $/hr over the last hour (context, info-level).
  /*
   * Grouped by model so the token figure can be weighted.
   *
   * `SUM(input_tokens + output_tokens)` is not a quantity — it adds a token
   * that costs five to one that costs a tenth and drops the cache classes — and
   * this string sits in the same list as the headline, so an unweighted number
   * here reads as the headline disagreeing with itself.
   */
  const burnRows = db
    .query<{ model_name: string | null; cost: number; input_tokens: number; output_tokens: number;
             cache_creation_tokens: number; cache_read_tokens: number }, any[]>(
      `SELECT model_name, SUM(cost_usd) cost,
              SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens,
              SUM(cache_creation_tokens) cache_creation_tokens, SUM(cache_read_tokens) cache_read_tokens
         FROM events WHERE timestamp > ?${sc} GROUP BY model_name`
    )
    .all(now - 60 * 60_000, ...sa);
  const burn = burnRows.reduce(
    (a, r) => ({ cost: a.cost + (r.cost ?? 0), toks: a.toks + equivalentTokens(r, r.model_name) }),
    { cost: 0, toks: 0 },
  );
  if (burn && burn.cost > 1) {
    out.push({
      id: "burn:hourly",
      severity: burn.cost >= 60 ? "warn" : "info",
      kind: "burn",
      title: `Spend velocity · $${burn.cost.toFixed(2)}/hr`,
      detail: `${(burn.toks / 1000).toFixed(0)}k eq tokens in the last hour`,
      session: null,
      ts: now,
    });
  }

  const rank = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.ts - a.ts);
}
