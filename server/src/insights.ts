// Proactive insights: things the fleet is doing that you'd want flagged —
// runaway loops, fast burn, high failure rates, overall spend velocity.
// Computed from the full event history (better than the live buffer for loops).
import type { Insight } from "../../shared/types.ts";
import { db, scopeClause } from "./db.ts";

const key = (app: string, sid: string) => `${app}:${sid.slice(0, 8)}`;
const trim = (s: string, n = 64) => (s.length > n ? s.slice(0, n) + "…" : s);

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
       GROUP BY session_id, cmd
       HAVING n >= 6
       ORDER BY n DESC LIMIT 6`
    )
    .all(now - 30 * 60_000, ...sa);
  for (const l of loops) {
    out.push({
      id: `loop:${l.session_id}:${l.cmd}`,
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
       FROM events WHERE timestamp > ?${sc} GROUP BY session_id
       HAVING cost >= 15 ORDER BY cost DESC LIMIT 4`
    )
    .all(now - 15 * 60_000, ...sa);
  for (const s of spend) {
    out.push({
      id: `spend:${s.session_id}`,
      severity: s.cost >= 40 ? "bad" : "warn",
      kind: "spend",
      title: `Burning fast · $${s.cost.toFixed(2)} in 15m`,
      detail: "this session is spending quickly",
      session: key(s.source_app, s.session_id),
      ts: s.last,
    });
  }

  // 3) High failure rate — errors relative to tool calls in the last hour.
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
       FROM events WHERE timestamp > ?${sc} GROUP BY session_id
       HAVING tools >= 4 AND errs * 1.0 / tools > 0.3
       ORDER BY errs DESC LIMIT 4`
    )
    .all(now - 60 * 60_000, ...sa);
  for (const f of fails) {
    const pct = Math.round((f.errs / f.tools) * 100);
    out.push({
      id: `errors:${f.session_id}`,
      severity: pct >= 50 ? "bad" : "warn",
      kind: "errors",
      title: `High failure rate · ${pct}%`,
      detail: `${f.errs} of ${f.tools} tool calls failed`,
      session: key(f.source_app, f.session_id),
      ts: f.last,
    });
  }

  // 4) Spend velocity — overall $/hr over the last hour (context, info-level).
  const burn = db
    .query<{ cost: number; toks: number }, any[]>(
      `SELECT SUM(cost_usd) cost, SUM(input_tokens + output_tokens) toks FROM events WHERE timestamp > ?${sc}`
    )
    .get(now - 60 * 60_000, ...sa);
  if (burn && burn.cost > 1) {
    out.push({
      id: "burn:hourly",
      severity: burn.cost >= 60 ? "warn" : "info",
      kind: "burn",
      title: `Spend velocity · $${burn.cost.toFixed(2)}/hr`,
      detail: `${(burn.toks / 1000).toFixed(0)}k tokens in the last hour`,
      session: null,
      ts: now,
    });
  }

  const rank = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.ts - a.ts);
}
