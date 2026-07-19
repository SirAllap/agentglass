import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  WatchEvent,
  SessionRollup,
  StatsSummary,
  CostByModel,
  ToolLatencyStat,
  TimeBucket,
  SkillUsage,
  AppUsage,
  TypeCount,
  OpenToolCall,
} from "../../shared/types.ts";
import type { NormalizedEvent } from "./ingest.ts";
import { costUsd, modelLabel } from "./pricing.ts";
import { workspaceRoot } from "./config.ts";

/**
 * Where the database lives.
 *
 * A relative path resolves against the working directory, which is fine when
 * the server is started from the repo but not when it's launched from a
 * desktop icon — the cwd is then arbitrary, and each launch would quietly
 * start a fresh database somewhere new. Fall back to the XDG data dir so the
 * history is the same no matter how the server was started. An explicit
 * AGENTGLASS_DB still wins, and a plain `bun run dev` in a checkout keeps
 * using the local file if one is already there.
 */
function defaultDbPath(): string {
  const local = resolve("agentglass.db");
  if (existsSync(local)) return local;
  const base =
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const dir = join(base, "agentglass");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, "agentglass.db");
  } catch {
    return local; // unwritable data dir — better a local file than no database
  }
}

const DB_PATH = process.env.AGENTGLASS_DB || defaultDbPath();
const db = new Database(DB_PATH, { create: true });
// The DB holds full prompts, file contents and command output in cleartext.
// Default file perms (0644) leave it world-readable; only $HOME being 0700
// keeps other local users out, which isn't a guarantee (a synced or shared
// home, a container mount). Lock the file — and the WAL/SHM that carry recent
// rows — to the owner.
for (const suffix of ["", "-wal", "-shm"]) {
  try { chmodSync(DB_PATH + suffix, 0o600); } catch { /* not created yet — created 0600 once WAL kicks in */ }
}
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_app TEXT NOT NULL,
  session_id TEXT NOT NULL,
  hook_event_type TEXT NOT NULL,
  tool_name TEXT,
  tool_use_id TEXT,
  agent_id TEXT,
  agent_type TEXT,
  model_name TEXT,
  is_error INTEGER NOT NULL DEFAULT 0,
  error_text TEXT,
  duration_ms INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  summary TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_source ON events(source_app);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(hook_event_type);
CREATE INDEX IF NOT EXISTS idx_events_tool ON events(tool_name);
CREATE INDEX IF NOT EXISTS idx_events_tooluse ON events(tool_use_id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(timestamp);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  source_app TEXT NOT NULL,
  model_name TEXT,
  provider TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_seen INTEGER NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  tool_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_seen ON sessions(last_seen);

-- Full-text index: one searchable blob per event (rowid = events.id) covering
-- prompts, commands, file paths, assistant messages and errors.
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(text);
`);

// `provider` was added after v1. CREATE TABLE IF NOT EXISTS won't add it to a
// pre-existing sessions table, so ALTER it in before any statement referencing
// it is prepared. Harmless (throws "duplicate column") once it already exists.
try { db.exec("ALTER TABLE sessions ADD COLUMN provider TEXT"); } catch { /* already present */ }

// Where a row came from, promoted out of `payload` so scope can be a WHERE
// clause instead of a JSON re-parse per query. Both are VIRTUAL generated
// columns: they cost no storage and apply to rows written *before* this
// migration, so a cockpit scoped today correctly hides a machine-wide history
// collected yesterday — no backfill pass over a multi-GB events table.
//
// `project_path` is the resolved repo root; `cwd` is only present when the turn
// ran somewhere else inside it (a linked worktree, a monorepo subdir). Scope has
// to consult both, mirroring the scanner's own test in transcripts.ts.
for (const [col, path] of [["project_path", "$.project_path"], ["cwd_path", "$.cwd"]]) {
  try {
    db.exec(`ALTER TABLE events ADD COLUMN ${col} TEXT GENERATED ALWAYS AS (json_extract(payload, '${path}')) VIRTUAL`);
  } catch { /* already present */ }
}
db.exec("CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_path)");

// Sessions have no payload of their own, so this one is a real column, written
// at upsert and backfilled from the session's events for rows that predate it.
try { db.exec("ALTER TABLE sessions ADD COLUMN project_path TEXT"); } catch { /* already present */ }
db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path)");
db.exec(`
  UPDATE sessions SET project_path = (
    SELECT e.project_path FROM events e
     WHERE e.session_id = sessions.session_id AND e.project_path IS NOT NULL
     ORDER BY e.id DESC LIMIT 1
  ) WHERE project_path IS NULL`);

/** Coarse vendor for a model name — the provider dimension. Returns null for an
 *  unknown/absent model so a session's known provider is never overwritten.
 *  Kept in sync with the web's providerOf() in web/src/lib/format.ts. */
export function providerOf(model: string | null | undefined): string | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (/opus|sonnet|haiku|fable|claude|anthropic/.test(m)) return "Anthropic";
  if (/gpt|davinci|openai|\bo1\b|\bo3\b|\bo4\b/.test(m)) return "OpenAI";
  if (/gemini|palm|bison|flash|google|vertex/.test(m)) return "Google";
  if (/deepseek/.test(m)) return "DeepSeek";
  if (/grok|xai/.test(m)) return "xAI";
  if (/mistral|mixtral|codestral/.test(m)) return "Mistral";
  if (/llama|meta-/.test(m)) return "Meta";
  if (/command|cohere/.test(m)) return "Cohere";
  return null;
}

/** SQL fragment + args to scope an events query to one provider (via its
 *  sessions). Empty when no provider is selected. */
function providerScope(provider?: string | null): { clause: string; args: string[] } {
  return provider
    ? { clause: " AND session_id IN (SELECT session_id FROM sessions WHERE provider = ?)", args: [provider] }
    : { clause: "", args: [] };
}

/** SQL fragment + args restricting an events query to one project. A scoped
 *  cockpit is *about* that project, so rows from anywhere else stay hidden even
 *  though they remain in the DB — an earlier machine-wide run, or hooks fired by
 *  a sibling repo. Matches the root and everything under it, against both the
 *  resolved repo root and the raw cwd, so linked worktrees and monorepo subdirs
 *  are in scope either way (the same test the scanner applies at ingest).
 *
 *  Rows with no recorded path (pre-scanner events) are treated as out of scope:
 *  a project view that quietly includes "unknown" is worse than one that's
 *  honestly narrow. Empty clause when unscoped — the whole-machine view. */
export function scopeClause(scope: string | null = workspaceRoot()): { clause: string; args: string[] } {
  if (!scope) return { clause: "", args: [] };
  const under = scope + "/%";
  return {
    clause: " AND (project_path = ? OR project_path LIKE ? OR cwd_path = ? OR cwd_path LIKE ?)",
    args: [scope, under, scope, under],
  };
}

/** Same restriction for the `sessions` table, which carries its own column. */
function sessionScopeClause(scope: string | null = workspaceRoot()): { clause: string; args: string[] } {
  return scope
    ? { clause: " AND (project_path = ? OR project_path LIKE ?)", args: [scope, scope + "/%"] }
    : { clause: "", args: [] };
}

/** The searchable text blob for an event — the fleet's collective memory. */
export function ftsText(n: {
  source_app: string;
  session_id: string;
  hook_event_type: string;
  tool_name: string | null;
  error_text: string | null;
  payload?: Record<string, unknown>;
}): string {
  const p = (n.payload ?? {}) as any;
  const ti = (p.tool_input ?? {}) as any;
  return [
    n.source_app, n.session_id, n.hook_event_type, n.tool_name, n.error_text,
    ti.command, ti.file_path || ti.path, ti.query || ti.pattern, ti.description, ti.prompt,
    p.prompt, p.message, p.last_assistant_message,
  ].filter((s) => typeof s === "string" && s).join(" \n ").slice(0, 8000);
}

const ftsInsert = db.query("INSERT INTO events_fts(rowid, text) VALUES ($id, $text)");

const insertStmt = db.query(`
  INSERT INTO events (
    source_app, session_id, hook_event_type, tool_name, tool_use_id,
    agent_id, agent_type, model_name, is_error, error_text, duration_ms,
    input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
    cost_usd, summary, payload, timestamp
  ) VALUES (
    $source_app, $session_id, $hook_event_type, $tool_name, $tool_use_id,
    $agent_id, $agent_type, $model_name, $is_error, $error_text, $duration_ms,
    $input_tokens, $output_tokens, $cache_creation_tokens, $cache_read_tokens,
    $cost_usd, $summary, $payload, $timestamp
  ) RETURNING id
`);

// Find the matching PreToolUse for a Post event: by tool_use_id when present,
// otherwise the most recent unpaired Pre for the same session+tool.
const findPreById = db.query<{ timestamp: number }, [string]>(
  `SELECT timestamp FROM events
   WHERE hook_event_type = 'PreToolUse' AND tool_use_id = ?
   ORDER BY id DESC LIMIT 1`
);
const findPreByTool = db.query<{ timestamp: number }, [string, string, number]>(
  `SELECT timestamp FROM events
   WHERE hook_event_type = 'PreToolUse' AND session_id = ? AND tool_name = ?
     AND timestamp <= ?
   ORDER BY id DESC LIMIT 1`
);

interface SessionTokenRow {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  model_name: string | null;
}
const getSessionTokens = db.query<SessionTokenRow, [string]>(
  `SELECT input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, model_name
   FROM sessions WHERE session_id = ?`
);

const rowToEvent = db.query<any, [number]>(`SELECT * FROM events WHERE id = ?`);

function parseEventRow(r: any): WatchEvent {
  return {
    ...r,
    payload: safeJson(r.payload),
  } as WatchEvent;
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

const isToolPost = (t: string) => t === "PostToolUse" || t === "PostToolUseFailure";
const isTerminal = (t: string) => t === "Stop" || t === "SessionEnd" || t === "SubagentStop";

// ---------------------------------------------------------------------------
// Retention — keep at least a full week of history so the 7d window is always
// answerable. Prune anything older than AGENTGLASS_RETENTION_DAYS (default 8;
// 0 disables pruning entirely).
// ---------------------------------------------------------------------------
export const RETENTION_DAYS = Math.max(0, Number(process.env.AGENTGLASS_RETENTION_DAYS ?? 8));

export function pruneOldRows(): { events: number; sessions: number } {
  if (!RETENTION_DAYS) return { events: 0, sessions: 0 };
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  db.run(`DELETE FROM events_fts WHERE rowid IN (SELECT id FROM events WHERE timestamp < ?)`, [cutoff]);
  const ev = db.run(`DELETE FROM events WHERE timestamp < ?`, [cutoff]);
  const se = db.run(`DELETE FROM sessions WHERE last_seen < ?`, [cutoff]);
  return { events: ev.changes, sessions: se.changes };
}

export interface InsertResult {
  event: WatchEvent;
  session: SessionRollup;
}

/**
 * Insert a normalized event, computing:
 *  - per-event token DELTA (from cumulative transcript usage) + cost
 *  - PostToolUse latency via pre→post pairing
 *  - the updated session rollup (authoritative token/cost totals)
 */
export function insertEvent(n: NormalizedEvent): InsertResult {
  const model = n.model_name;

  // --- token delta computation -------------------------------------------
  let dIn = n.usage.input_tokens ?? 0;
  let dOut = n.usage.output_tokens ?? 0;
  let dCw = n.usage.cache_creation_tokens ?? 0;
  let dCr = n.usage.cache_read_tokens ?? 0;

  const prior = getSessionTokens.get(n.session_id);
  if (n.usage_is_cumulative && prior) {
    // cumulative transcript → delta vs what the session already recorded
    dIn = Math.max(0, dIn - prior.input_tokens);
    dOut = Math.max(0, dOut - prior.output_tokens);
    dCw = Math.max(0, dCw - prior.cache_creation_tokens);
    dCr = Math.max(0, dCr - prior.cache_read_tokens);
  }
  const eventCost = costUsd(
    { input_tokens: dIn, output_tokens: dOut, cache_creation_tokens: dCw, cache_read_tokens: dCr },
    model
  );

  // --- latency pairing ----------------------------------------------------
  let duration_ms: number | null = null;
  if (isToolPost(n.hook_event_type)) {
    let pre: { timestamp: number } | null = null;
    if (n.tool_use_id) pre = findPreById.get(n.tool_use_id) ?? null;
    if (!pre && n.tool_name) pre = findPreByTool.get(n.session_id, n.tool_name, n.timestamp) ?? null;
    if (pre) duration_ms = Math.max(0, n.timestamp - pre.timestamp);
  }

  const { id } = insertStmt.get({
    $source_app: n.source_app,
    $session_id: n.session_id,
    $hook_event_type: n.hook_event_type,
    $tool_name: n.tool_name,
    $tool_use_id: n.tool_use_id,
    $agent_id: n.agent_id,
    $agent_type: n.agent_type,
    $model_name: model,
    $is_error: n.is_error,
    $error_text: n.error_text,
    $duration_ms: duration_ms,
    $input_tokens: dIn,
    $output_tokens: dOut,
    $cache_creation_tokens: dCw,
    $cache_read_tokens: dCr,
    $cost_usd: eventCost,
    $summary: n.summary,
    $payload: JSON.stringify(n.payload ?? {}),
    $timestamp: n.timestamp,
  }) as { id: number };

  const event = parseEventRow(rowToEvent.get(id));
  try { ftsInsert.run({ $id: id, $text: ftsText({ ...n, payload: n.payload }) }); } catch { /* fts best-effort */ }
  const session = upsertSession(n, dIn, dOut, dCw, dCr);
  return { event, session };
}

const upsertStmt = db.query(`
  INSERT INTO sessions (
    session_id, source_app, model_name, provider, project_path, started_at, ended_at, last_seen,
    event_count, tool_count, error_count,
    input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd
  ) VALUES (
    $sid, $src, $model, $provider, $project, $ts, $ended, $ts,
    1, $tool, $err,
    $in, $out, $cw, $cr, $cost
  )
  ON CONFLICT(session_id) DO UPDATE SET
    source_app = excluded.source_app,
    model_name = COALESCE(excluded.model_name, sessions.model_name),
    provider = COALESCE(excluded.provider, sessions.provider),
    project_path = COALESCE(excluded.project_path, sessions.project_path),
    ended_at = COALESCE(excluded.ended_at, sessions.ended_at),
    last_seen = excluded.last_seen,
    event_count = sessions.event_count + 1,
    tool_count = sessions.tool_count + $tool,
    error_count = sessions.error_count + $err,
    input_tokens = sessions.input_tokens + $in,
    output_tokens = sessions.output_tokens + $out,
    cache_creation_tokens = sessions.cache_creation_tokens + $cw,
    cache_read_tokens = sessions.cache_read_tokens + $cr,
    cost_usd = sessions.cost_usd + $cost
  RETURNING *
`);

function upsertSession(
  n: NormalizedEvent,
  dIn: number,
  dOut: number,
  dCw: number,
  dCr: number
): SessionRollup {
  const cost = costUsd(
    { input_tokens: dIn, output_tokens: dOut, cache_creation_tokens: dCw, cache_read_tokens: dCr },
    n.model_name
  );
  const row = upsertStmt.get({
    $sid: n.session_id,
    $src: n.source_app,
    $model: n.model_name,
    $provider: providerOf(n.model_name),
    // Carried in the payload by both the scanner and the hooks; null for an
    // event that never recorded where it ran, which COALESCE leaves alone.
    $project: typeof n.payload?.project_path === "string" ? n.payload.project_path : null,
    $ts: n.timestamp,
    $ended: isTerminal(n.hook_event_type) ? n.timestamp : null,
    $tool: isToolPost(n.hook_event_type) ? 1 : 0,
    $err: n.is_error,
    $in: dIn,
    $out: dOut,
    $cw: dCw,
    $cr: dCr,
    $cost: cost,
  }) as SessionRollup;
  return row;
}

// ---------------------------------------------------------------------------
// Read queries
// ---------------------------------------------------------------------------

// Ordered by timestamp, not id: backfilled history arrives in whatever order
// the scan walks the disk, so a row's id says when it was *ingested*, not when
// it happened. Sorting by id would rank a project scanned last above one whose
// work is genuinely more recent.
const recentStmt = db.query<any, [number]>(
  `SELECT * FROM events ORDER BY timestamp DESC, id DESC LIMIT ?`
);
export function getRecent(limit = 300, provider?: string): WatchEvent[] {
  const scope = scopeClause();
  const prov = providerScope(provider);
  if (!scope.clause && !prov.clause) return recentStmt.all(limit).map(parseEventRow).reverse();
  return db
    .query<any, any[]>(
      `SELECT * FROM events WHERE 1=1${prov.clause}${scope.clause} ORDER BY timestamp DESC, id DESC LIMIT ?`
    )
    .all(...prov.args, ...scope.args, limit)
    .map(parseEventRow)
    .reverse();
}

// A tool call is "open" while its PreToolUse has no matching Post. The client
// derives this from its live buffer, but a long tool emits nothing while it runs,
// so on a busy fleet (or after a reload) the Pre can age out of the buffer and
// the session wrongly flips to idle — or vanishes — mid-run. This is the server's
// authoritative view, sent on the initial frame so the client doesn't depend on
// the Pre still being in memory. Bounded to the last 30 min (past that a stuck
// pair is a lost session, not a long build — matching the client's ceiling) and
// to sessions with no Stop/SessionEnd after the Pre.
const OPEN_TOOL_MAX_MS = 30 * 60_000;
const openToolSql = (scoped: string) =>
  `SELECT p.session_id AS session_id, p.source_app AS source_app,
          COALESCE(p.tool_name, 'tool') AS tool_name, p.timestamp AS since
     FROM events p
    WHERE p.hook_event_type = 'PreToolUse'
      AND p.timestamp >= ?
      AND NOT EXISTS (
        SELECT 1 FROM events q
         WHERE q.hook_event_type IN ('PostToolUse','PostToolUseFailure')
           AND (
             (p.tool_use_id IS NOT NULL AND q.tool_use_id = p.tool_use_id)
             OR (p.tool_use_id IS NULL AND q.session_id = p.session_id
                 AND q.tool_name = p.tool_name AND q.timestamp >= p.timestamp)
           )
      )
      AND NOT EXISTS (
        SELECT 1 FROM events s
         WHERE s.session_id = p.session_id
           AND s.hook_event_type IN ('Stop','SessionEnd')
           AND s.timestamp >= p.timestamp
      )
      ${scoped}
    ORDER BY p.timestamp ASC
    LIMIT 200`;

/** Currently-running tool calls across the fleet (open Pre, unpaired, session
 *  still alive) — the seed for the client's per-agent "running" state. */
export function openToolCalls(): OpenToolCall[] {
  // Aliased to `p`, so the shared clause needs qualifying to stay unambiguous
  // against the correlated subqueries above.
  const s = scopeClause();
  const scoped = s.clause.replace(/\b(project_path|cwd_path)\b/g, "p.$1");
  return db
    .query<OpenToolCall, any[]>(openToolSql(scoped))
    .all(Date.now() - OPEN_TOOL_MAX_MS, ...s.args);
}

export function getFilterOptions() {
  // Scoped too, or the dropdowns keep offering apps and models that the feed
  // behind them can no longer show — picking one would just empty the panel.
  const s = scopeClause();
  const distinct = <T,>(col: string, extra = "") =>
    db
      .query<Record<string, T>, string[]>(
        `SELECT DISTINCT ${col} FROM events WHERE 1=1${extra}${s.clause} ORDER BY 1`
      )
      .all(...s.args)
      .map((r) => r[col] as T);
  return {
    source_apps: distinct<string>("source_app"),
    hook_event_types: distinct<string>("hook_event_type"),
    models: distinct<string>("model_name", " AND model_name IS NOT NULL"),
  };
}

export function getSessions(limit = 100, provider?: string): SessionRollup[] {
  const s = sessionScopeClause();
  const prov = provider ? { clause: " AND provider = ?", args: [provider] } : { clause: "", args: [] };
  return db
    .query<SessionRollup, any[]>(
      `SELECT * FROM sessions WHERE 1=1${prov.clause}${s.clause} ORDER BY last_seen DESC LIMIT ?`
    )
    .all(...prov.args, ...s.args, limit);
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** Full analytics summary over a rolling window (default 24h), optionally scoped
 *  to a single provider (Anthropic / OpenAI / Google / …). Always scoped to the
 *  open project, so spend, tool mix and the radar describe that project alone. */
export function statsSummary(windowMs = 24 * 3600 * 1000, provider?: string): StatsSummary {
  const since = Date.now() - windowMs;
  const { clause: prov, args: pa } = providerScope(provider);
  const { clause: sc, args: sa } = scopeClause();
  // Every query below appends `pf` and binds `A` in this order, so folding the
  // project filter in here reaches all of them at once.
  const pf = prov + sc;
  const A = [since, ...pa, ...sa]; // bind order: timestamp, provider (if any), project (if any)

  // Totals come from the authoritative sessions table for cost/tokens,
  // and from events for counts/errors within the window.
  // One pass, not two: both sets of totals cover exactly the same rows, and
  // over a wide window each separate pass is a full scan of the table.
  const totals = db
    .query<any, any[]>(
      `SELECT COUNT(*) AS events,
              SUM(CASE WHEN hook_event_type IN ('PostToolUse','PostToolUseFailure') THEN 1 ELSE 0 END) AS tool_calls,
              SUM(is_error) AS errors,
              COUNT(DISTINCT session_id) AS sessions,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cache_creation_tokens) AS cache_creation_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens,
              SUM(cost_usd) AS cost_usd
       FROM events WHERE timestamp >= ?${pf}`
    )
    .get(...A)!;
  const evtTotals = totals as { events: number; tool_calls: number; errors: number };
  const tokTotals = totals;

  // Per-model breakdown (from events so it respects the window).
  const modelRows = db
    .query<any, any[]>(
      `SELECT model_name,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cache_creation_tokens) AS cache_creation_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens,
              SUM(cost_usd) AS cost_usd,
              COUNT(DISTINCT session_id) AS sessions
       FROM events WHERE timestamp >= ?${pf}
       GROUP BY model_name`
    )
    .all(...A);
  const by_model: CostByModel[] = modelRows.map((r) => ({
    model_name: modelLabel(r.model_name),
    input_tokens: r.input_tokens ?? 0,
    output_tokens: r.output_tokens ?? 0,
    cache_creation_tokens: r.cache_creation_tokens ?? 0,
    cache_read_tokens: r.cache_read_tokens ?? 0,
    cost_usd: r.cost_usd ?? 0,
    sessions: r.sessions ?? 0,
  }));

  // Tool latency — pull durations per tool and compute percentiles in JS.
  const durRows = db
    .query<{ tool_name: string; duration_ms: number; is_error: number }, any[]>(
      `SELECT tool_name, duration_ms, is_error FROM events
       WHERE timestamp >= ? AND hook_event_type IN ('PostToolUse','PostToolUseFailure')
         AND tool_name IS NOT NULL${pf}`
    )
    .all(...A);
  const byTool = new Map<string, { durs: number[]; errors: number; count: number }>();
  for (const r of durRows) {
    const e = byTool.get(r.tool_name) ?? { durs: [], errors: 0, count: 0 };
    e.count++; // every PostToolUse is an invocation, even without a paired duration (e.g. OTLP-logs sources)
    if (typeof r.duration_ms === "number") e.durs.push(r.duration_ms);
    if (r.is_error) e.errors++;
    byTool.set(r.tool_name, e);
  }
  const tool_latency: ToolLatencyStat[] = [...byTool.entries()]
    .map(([tool_name, { durs, errors, count }]) => {
      const sorted = [...durs].sort((a, b) => a - b);
      const total = sorted.reduce((a, b) => a + b, 0);
      return {
        tool_name,
        calls: count,
        errors,
        p50_ms: percentile(sorted, 50),
        p95_ms: percentile(sorted, 95),
        max_ms: sorted.length ? sorted[sorted.length - 1] : 0,
        avg_ms: sorted.length ? Math.round(total / sorted.length) : 0,
        total_ms: total,
      };
    })
    .sort((a, b) => b.total_ms - a.total_ms);

  // Most-used skills with attributed cost and per-bucket activity.
  const top_skills: SkillUsage[] = skillUsageDetail(since, 12, provider).slice(0, 20);

  // Per-app rollup within the window.
  const by_app: AppUsage[] = db
    .query<AppUsage, any[]>(
      `SELECT source_app,
              COUNT(*) AS events,
              COUNT(DISTINCT session_id) AS sessions,
              SUM(CASE WHEN hook_event_type IN ('PostToolUse','PostToolUseFailure') THEN 1 ELSE 0 END) AS tool_calls,
              SUM(cost_usd) AS cost_usd,
              SUM(input_tokens + output_tokens) AS tokens
       FROM events WHERE timestamp >= ?${pf}
       GROUP BY source_app ORDER BY cost_usd DESC, events DESC`
    )
    .all(...A);

  // Event-type mix within the window.
  const by_type: TypeCount[] = db
    .query<TypeCount, any[]>(
      `SELECT hook_event_type, COUNT(*) AS count
       FROM events WHERE timestamp >= ?${pf}
       GROUP BY hook_event_type ORDER BY count DESC`
    )
    .all(...A);

  // Timeline buckets.
  const bucketCount = 60;
  const bucketMs = Math.max(1000, Math.floor(windowMs / bucketCount));
  const start = Math.floor(since / bucketMs) * bucketMs;
  const buckets = new Map<number, TimeBucket>();
  for (let i = 0; i < bucketCount; i++) {
    const t = start + i * bucketMs;
    buckets.set(t, { t, events: 0, errors: 0, cost_usd: 0, tokens: 0 });
  }
  const tlRows = db
    .query<any, any[]>(
      `SELECT timestamp, is_error, cost_usd, input_tokens, output_tokens FROM events WHERE timestamp >= ?${pf}`
    )
    .all(...A);
  const heatmap = new Array(168).fill(0);
  for (const r of tlRows) {
    const t = Math.floor(r.timestamp / bucketMs) * bucketMs;
    const b = buckets.get(t);
    if (b) {
      b.events++;
      b.errors += r.is_error;
      b.cost_usd += r.cost_usd ?? 0;
      b.tokens += (r.input_tokens ?? 0) + (r.output_tokens ?? 0);
    }
    const d = new Date(r.timestamp);
    heatmap[d.getDay() * 24 + d.getHours()]++;
  }

  return {
    totals: {
      events: evtTotals.events ?? 0,
      sessions: tokTotals.sessions ?? 0,
      tool_calls: evtTotals.tool_calls ?? 0,
      errors: evtTotals.errors ?? 0,
      cost_usd: tokTotals.cost_usd ?? 0,
      input_tokens: tokTotals.input_tokens ?? 0,
      output_tokens: tokTotals.output_tokens ?? 0,
      cache_creation_tokens: tokTotals.cache_creation_tokens ?? 0,
      cache_read_tokens: tokTotals.cache_read_tokens ?? 0,
    },
    by_model,
    tool_latency,
    timeline: [...buckets.values()].sort((a, b) => a.t - b.t),
    top_skills,
    by_app,
    by_type,
    heatmap,
    window_ms: windowMs,
  };
}

/**
 * Per-skill usage detail: run counts, last-used, activity buckets, and an
 * ATTRIBUTED cost — every cost-bearing event in a session is charged to the
 * most recent skill invocation at/before it in that session (until the next
 * skill starts). An approximation, but a useful one: it answers "what does
 * running /code-review actually cost?".
 */
export function skillUsageDetail(since = 0, bucketCount = 12, provider?: string): SkillUsage[] {
  const { clause: pf, args: pa } = providerScope(provider);
  const invocations = db
    .query<{ session_id: string; timestamp: number; skill: string }, any[]>(
      `SELECT session_id, timestamp, json_extract(payload, '$.tool_input.skill') AS skill
       FROM events
       WHERE hook_event_type = 'PreToolUse' AND tool_name = 'Skill'
         AND json_extract(payload, '$.tool_input.skill') IS NOT NULL AND timestamp >= ?${pf}
       ORDER BY session_id, timestamp`
    )
    .all(since, ...pa);
  if (!invocations.length) return [];

  const bySession = new Map<string, { timestamp: number; skill: string }[]>();
  for (const inv of invocations) {
    const arr = bySession.get(inv.session_id) ?? [];
    arr.push(inv);
    bySession.set(inv.session_id, arr);
  }

  const acc = new Map<string, { calls: number; cost_usd: number; last_used: number; buckets: number[] }>();
  const get = (skill: string) => {
    let a = acc.get(skill);
    if (!a) {
      a = { calls: 0, cost_usd: 0, last_used: 0, buckets: new Array(bucketCount).fill(0) };
      acc.set(skill, a);
    }
    return a;
  };

  const start = since || invocations.reduce((m, i) => Math.min(m, i.timestamp), Date.now());
  const bucketMs = Math.max(1, (Date.now() - start) / bucketCount);
  for (const inv of invocations) {
    const a = get(inv.skill);
    a.calls++;
    a.last_used = Math.max(a.last_used, inv.timestamp);
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((inv.timestamp - start) / bucketMs)));
    a.buckets[idx]++;
  }

  // Charge each cost-bearing event to the running skill at that moment.
  const costRows = db
    .query<{ session_id: string; timestamp: number; cost_usd: number }, [number]>(
      `SELECT session_id, timestamp, cost_usd FROM events WHERE cost_usd > 0 AND timestamp >= ?`
    )
    .all(since);
  for (const c of costRows) {
    const invs = bySession.get(c.session_id);
    if (!invs) continue;
    let owner: string | null = null;
    for (const inv of invs) {
      if (inv.timestamp <= c.timestamp) owner = inv.skill;
      else break;
    }
    if (owner) get(owner).cost_usd += c.cost_usd;
  }

  return [...acc.entries()]
    .map(([skill, a]) => ({ skill, ...a }))
    .sort((a, b) => b.calls - a.calls || b.cost_usd - a.cost_usd);
}

type ChangeRow = { id: number; timestamp: number; source_app: string; session_id: string; tool_name: string; payload: string };
/**
 * A hunk for tools that report an edit as a pair of strings rather than a patch.
 *
 * The two strings usually share long identical regions — that's how Edit
 * locates its match — so emitting every old line as a deletion and every new
 * line as an addition counts unchanged context as churn (measured 1.6x on
 * additions, 3.8x on deletions across real edits). The common prefix and
 * suffix are kept as context lines instead, which also gives the hunk an
 * honest size.
 */
function editHunk(oldS: string, newS: unknown) {
  const del = oldS ? oldS.split("\n") : [];
  const add = typeof newS === "string" && newS ? newS.split("\n") : [];

  let pre = 0;
  while (pre < del.length && pre < add.length && del[pre] === add[pre]) pre++;
  let post = 0;
  while (
    post < del.length - pre &&
    post < add.length - pre &&
    del[del.length - 1 - post] === add[add.length - 1 - post]
  ) post++;

  const removed = del.slice(pre, del.length - post);
  const added = add.slice(pre, add.length - post);
  return {
    // The real file offset isn't recorded anywhere in the transcript, so the
    // hunk is anchored at the start of the matched region rather than claiming
    // a line number it doesn't know.
    oldStart: 1,
    oldLines: del.length,
    newStart: 1,
    newLines: add.length,
    lines: [
      ...del.slice(0, pre).map((l) => " " + l),
      ...removed.map((l) => "-" + l),
      ...added.map((l) => "+" + l),
      ...del.slice(del.length - post).map((l) => " " + l),
    ],
  };
}

function parseChange(r: ChangeRow): import("../../shared/types.ts").FileChange | null {
  let payload: any;
  try { payload = JSON.parse(r.payload); } catch { return null; }
  const tr = payload.tool_response ?? {};
  const ti = payload.tool_input ?? {};
  const file_path = tr.filePath || ti.file_path || ti.filePath || "(unknown)";
  let hunks = Array.isArray(tr.structuredPatch) ? tr.structuredPatch : [];
  if (!hunks.length && r.tool_name === "Write" && typeof ti.content === "string") {
    const lines = ti.content.split("\n");
    hunks = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l: string) => "+" + l) }];
  }
  // An Edit read back from a transcript has no structuredPatch — the recorded
  // result is plain text — so rebuild the hunk from the call's own strings.
  // Without this every Edit drops out of the change list, which for a session
  // that edits more than it writes means no diff at all.
  if (!hunks.length && r.tool_name === "Edit" && typeof ti.old_string === "string") {
    hunks = [editHunk(ti.old_string, ti.new_string)];
  }
  if (!hunks.length && r.tool_name === "MultiEdit" && Array.isArray(ti.edits)) {
    hunks = ti.edits
      .filter((e: any) => e && typeof e.old_string === "string")
      .map((e: any) => editHunk(e.old_string, e.new_string));
  }
  if (!hunks.length) return null;
  let additions = 0, deletions = 0;
  for (const h of hunks) for (const l of h.lines ?? []) {
    if (l[0] === "+") additions++;
    else if (l[0] === "-") deletions++;
  }
  return { id: r.id, timestamp: r.timestamp, source_app: r.source_app, session_id: r.session_id, tool: r.tool_name, file_path, additions, deletions, hunks };
}

/** Recent file changes (Edit/Write/MultiEdit) with their diff hunks, parsed
 *  from the tool_response.structuredPatch Claude Code already provides. */
export function getChanges(limit = 200, sessionId?: string): import("../../shared/types.ts").FileChange[] {
  const chg = scopeClause();
  const rows = sessionId
    ? db.query<ChangeRow, any[]>(
        `SELECT id, timestamp, source_app, session_id, tool_name, payload FROM events
         WHERE hook_event_type='PostToolUse' AND tool_name IN ('Edit','Write','MultiEdit') AND session_id = ?${chg.clause}
         ORDER BY timestamp DESC, id DESC LIMIT ?`).all(sessionId, ...chg.args, limit)
    : db.query<ChangeRow, any[]>(
        `SELECT id, timestamp, source_app, session_id, tool_name, payload FROM events
         WHERE hook_event_type='PostToolUse' AND tool_name IN ('Edit','Write','MultiEdit')${chg.clause}
         ORDER BY timestamp DESC, id DESC LIMIT ?`).all(...chg.args, limit);
  return rows.map(parseChange).filter((c): c is import("../../shared/types.ts").FileChange => c !== null);
}

/** Everything we know about one session — the deep-dive. */
export function getSession(sessionId: string): import("../../shared/types.ts").SessionDetail | null {
  const roll = db.query<any, [string]>(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId);
  const agg = db.query<any, [string]>(
    `SELECT source_app, MAX(model_name) model_name, MAX(project_path) project_path,
            MIN(timestamp) started_at, MAX(timestamp) last_seen,
            COUNT(*) events,
            SUM(CASE WHEN hook_event_type IN ('PostToolUse','PostToolUseFailure') THEN 1 ELSE 0 END) tools,
            SUM(is_error) errors, SUM(cost_usd) cost_usd,
            SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens
     FROM events WHERE session_id = ?`).get(sessionId);
  if (!agg || !agg.events) return null;

  const toolMix = db.query<{ tool: string; n: number }, [string]>(
    `SELECT tool_name tool, COUNT(*) n FROM events
     WHERE session_id = ? AND hook_event_type='PostToolUse' AND tool_name IS NOT NULL
     GROUP BY tool_name ORDER BY n DESC LIMIT 12`).all(sessionId);

  const subRows = db.query<{ agent_id: string; agent_type: string; n: number }, [string]>(
    `SELECT agent_id, MAX(agent_type) agent_type, COUNT(*) n FROM events
     WHERE session_id = ? AND agent_id IS NOT NULL AND agent_id != ''
     GROUP BY agent_id ORDER BY n DESC LIMIT 20`).all(sessionId);

  // Conversation: interleave user prompts and assistant messages by time.
  //
  // 600 characters used to be the cap, which cut a typical reply off in its
  // first paragraph — mid-word, with nothing saying it had been cut. This view
  // is meant to be where you read a session, not a teaser for it, so the budget
  // is per-session rather than per-message: long messages get room, and a
  // session full of them still can't produce an unbounded response.
  const MSG_MAX = 20_000;
  // Outputs are attached to the newest runs only. Every row carrying one would
  // multiply this response by the size of a build log, and the rows you scroll
  // back to are the ones you already read. Counted over tool rows specifically:
  // counting whole timeline entries let the messages, which are added first,
  // eat the budget before any tool reached it.
  const OUTPUT_ROWS = 120;
  const OUTPUT_MAX = 4_000;
  const CONVO_BUDGET = 400_000;

  /** Trim at a line, then a word, so a cut never lands mid-word — and say so,
   *  because silently-shortened text reads as the model having stopped. */
  const clip = (s: string): string => {
    if (s.length <= MSG_MAX) return s;
    const head = s.slice(0, MSG_MAX);
    const at = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(" "));
    return head.slice(0, at > MSG_MAX * 0.8 ? at : MSG_MAX) + "\n\n…[truncated]";
  };

  const convo: { role: "user" | "assistant"; text: string; ts: number; agent_id?: string | null; agent_type?: string | null }[] = [];
  for (const r of db.query<{ timestamp: number; payload: string }, [string]>(
    `SELECT timestamp, payload FROM events WHERE session_id = ? AND hook_event_type='UserPromptSubmit' ORDER BY timestamp DESC LIMIT 40`).all(sessionId)) {
    try { const p = JSON.parse(r.payload); if (p.prompt) convo.push({ role: "user", text: clip(String(p.prompt)), ts: r.timestamp }); } catch { /* skip */ }
  }
  let lastMsg = "";
  for (const r of db.query<{ timestamp: number; payload: string; agent_id: string | null; agent_type: string | null }, [string]>(
    `SELECT timestamp, payload, agent_id, agent_type FROM events WHERE session_id = ? AND payload LIKE '%last_assistant_message%' ORDER BY timestamp DESC LIMIT 60`).all(sessionId)) {
    try {
      const m = JSON.parse(r.payload).last_assistant_message;
      if (m && m !== lastMsg) { convo.push({ role: "assistant", text: clip(String(m)), ts: r.timestamp, agent_id: r.agent_id, agent_type: r.agent_type }); lastMsg = m; }
    } catch { /* skip */ }
  }
  convo.sort((a, b) => b.ts - a.ts);
  const summary = convo.find((c) => c.role === "assistant")?.text ?? null;

  // Newest-first, so the budget drops the oldest turns rather than the ones
  // you opened the session to read.
  const kept: typeof convo = [];
  let spent = 0;
  for (const c of convo) {
    if (spent + c.text.length > CONVO_BUDGET && kept.length) break;
    kept.push(c);
    spent += c.text.length;
  }

  // Timeline: the messages above, plus every tool the session ran, in order.
  //
  // Without the tool runs the panel shows what was said and hides what was
  // done — an agent that spent an hour editing files looks like it produced
  // two paragraphs. What identifies a run differs per tool, so each one is
  // reduced to the single thing worth reading in a list: the path it touched,
  // the command it ran, the URL it fetched.
  const target = (tool: string, ti: Record<string, unknown>): string | null => {
    const s = (v: unknown) => (typeof v === "string" && v ? v : null);
    switch (tool) {
      case "Bash": return s(ti.command);
      case "WebFetch": case "WebSearch": return s(ti.url) ?? s(ti.query);
      case "ToolSearch": return s(ti.query);
      case "Task": case "Agent": return s(ti.description);
      default: return s(ti.file_path) ?? s(ti.path) ?? s(ti.pattern) ?? s(ti.query) ?? s(ti.command);
    }
  };

  const timeline: import("../../shared/types.ts").TimelineEntry[] =
    kept.map((c) => ({ kind: "message" as const, ts: c.ts, role: c.role, text: c.text, agent_id: c.agent_id, agent_type: c.agent_type }));

  // Bounded to the same window the messages cover, so the timeline can't be
  // dominated by tool noise from turns whose text was already dropped.
  const oldest = kept.length ? Math.min(...kept.map((c) => c.ts)) : 0;
  let withOutput = 0;
  for (const r of db.query<{ timestamp: number; tool_name: string | null; is_error: number; duration_ms: number | null; tool_use_id: string | null; agent_id: string | null; agent_type: string | null; payload: string }, [string, number]>(
    `SELECT timestamp, tool_name, is_error, duration_ms, tool_use_id, agent_id, agent_type, payload FROM events
      WHERE session_id = ? AND hook_event_type IN ('PostToolUse','PostToolUseFailure')
        AND timestamp >= ?
      ORDER BY timestamp DESC LIMIT 400`).all(sessionId, oldest)) {
    const tool = r.tool_name || "tool";
    let ti: Record<string, unknown> = {};
    try { ti = (JSON.parse(r.payload).tool_input ?? {}) as Record<string, unknown>; } catch { /* keep empty */ }
    const note = typeof ti.description === "string" ? ti.description : null;
    // What the tool answered. Capped per row and only for the newest runs: a
    // session's outputs together dwarf everything else in this response, and a
    // `bun test` or a `git log` alone can be hundreds of lines. The head is
    // what tells you whether it worked, which is the question being asked.
    let output: string | null = null;
    let clipped = false;
    if (withOutput < OUTPUT_ROWS) {
      try {
        const raw = JSON.parse(r.payload)?.tool_response?.content;
        if (typeof raw === "string" && raw.trim()) {
          const t = raw.trimEnd();
          clipped = t.length > OUTPUT_MAX;
          output = clipped ? t.slice(0, OUTPUT_MAX) : t;
          withOutput++;
        }
      } catch { /* no parseable response — the row still stands on its own */ }
    }
    timeline.push({
      kind: "tool", ts: r.timestamp, tool,
      target: target(tool, ti),
      note: note && note !== target(tool, ti) ? note : null,
      is_error: !!r.is_error,
      duration_ms: r.duration_ms,
      tool_use_id: r.tool_use_id,
      agent_id: r.agent_id,
      agent_type: r.agent_type,
      output,
      output_clipped: clipped,
    });
  }
  timeline.sort((a, b) => b.ts - a.ts);

  return {
    session_id: sessionId,
    source_app: agg.source_app,
    model_name: agg.model_name ?? roll?.model_name ?? null,
    // Prefer the session row; fall back to the events for one that predates the
    // column. Without a directory the UI can't offer to resume the session.
    project_path: roll?.project_path ?? agg.project_path ?? null,
    started_at: agg.started_at,
    ended_at: roll?.ended_at ?? null,
    last_seen: agg.last_seen,
    events: agg.events,
    tools: agg.tools ?? 0,
    errors: agg.errors ?? 0,
    cost_usd: agg.cost_usd ?? 0,
    input_tokens: agg.input_tokens ?? 0,
    output_tokens: agg.output_tokens ?? 0,
    summary,
    tool_mix: toolMix,
    subagents: subRows.map((s) => ({ agent_id: s.agent_id, agent_type: s.agent_type || "subagent", events: s.n })),
    conversation: kept,
    timeline,
    changes: getChanges(40, sessionId),
  };
}

/** Full-text search across every event's prompts, commands and outputs. */
export function searchEvents(q: string, limit = 60): import("../../shared/types.ts").SearchHit[] {
  const match = q.trim().split(/\s+/).map((t) => t.replace(/[^a-zA-Z0-9_]/g, "")).filter(Boolean).map((t) => t + "*").join(" ");
  if (!match) return [];
  const s = scopeClause();
  const scoped = s.clause.replace(/\b(project_path|cwd_path)\b/g, "e.$1");
  try {
    return db
      .query<any, any[]>(
        `SELECT e.id, e.timestamp, e.source_app, e.session_id, e.hook_event_type, e.tool_name,
                e.cost_usd, e.duration_ms,
                snippet(events_fts, 0, char(1), char(2), ' … ', 14) AS snippet
         FROM events_fts f JOIN events e ON e.id = f.rowid
         WHERE events_fts MATCH ?${scoped} ORDER BY rank LIMIT ?`
      )
      .all(match, ...s.args, limit);
  } catch {
    return [];
  }
}

/** Stream rows for export (bounded). Scoped like everything else — an export
 *  from a project cockpit is that project's data, not the whole machine's. */
export function exportRows(limit = 100_000): WatchEvent[] {
  const s = scopeClause();
  return db
    .query<any, any[]>(`SELECT * FROM events WHERE 1=1${s.clause} ORDER BY id ASC LIMIT ?`)
    .all(...s.args, limit)
    .map(parseEventRow);
}

export { db };
