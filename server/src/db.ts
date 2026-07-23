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
import { workspaceRoot, scopeRoots } from "./config.ts";

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
// Wait for a lock instead of failing on it. WAL lets readers and one writer
// work at once, but two writers still collide — and this database has several:
// the ingest path, the transcript scanner's sweep, and the retention prune.
// Without a timeout SQLite raises SQLITE_BUSY immediately, which surfaces as a
// dropped event rather than as the momentary contention it actually is.
db.exec("PRAGMA busy_timeout = 5000;");

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

// What this session is *called*. Claude Code writes both into the transcript:
// `custom-title` when you rename a session by hand, `ai-title` for the one it
// generates. Stored separately rather than resolved on write, because a rename
// arrives later than the AI title and must not be overwritten by it.
//
// Without these the only handle on a session is its uuid, and
// "orbit:2a3ee05b-7cb5-4652-ac0b-785ed3751479" is not something a human can
// pick out of a list of five.
for (const col of ["custom_title", "ai_title"]) {
  try { db.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`); } catch { /* already present */ }
}

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
// A scoped query now tests `cwd_path` once per checkout of the project, and a
// virtual column is recomputed by json_extract for every row it touches. Without
// this index, the user this change is for — a dozen worktrees open — is exactly
// the one who pays a full table scan with a JSON parse per row on /events,
// /stats and /changes. It also bounds the backfill below.
db.exec("CREATE INDEX IF NOT EXISTS idx_events_cwd ON events(cwd_path)");
// `model_name` had none, so the filter dropdown's third query — SELECT DISTINCT
// over it — was the one full scan with a temp B-tree in that endpoint. Cheap
// index, and the covering scan it enables is what the other two already had.
db.exec("CREATE INDEX IF NOT EXISTS idx_events_model ON events(model_name)");

// Covering indexes for /stats — the endpoint that freezes the terminal.
//
// statsSummary() runs six aggregations over a time window, and every one of
// them used to land on the `events` table itself: the single-column indexes it
// had (idx_events_ts / _model / _source / _type) satisfy the WHERE or the
// GROUP BY, but not the columns being SUMmed, so SQLite seeks each matching
// rowid back into the table to read them. That table is the problem — its rows
// carry a `payload` TEXT up to 68 KB (a full prompt, a file's contents, command
// output), so a "scan and sum a few integers" is really a walk over 190 MB of
// pages that are 98% payload the query never looks at. Warm it is tens of ms;
// with those historical pages evicted (nothing else keeps eight-day-old rows
// hot) each probe is a disk seek, and the six of them together are the 2–4 s
// `/stats` stalls the loop watchdog caught — on the one thread that also pumps
// the PTY WebSocket, so the terminal stops echoing for the duration.
//
// Worse, the GROUP BY queries drove off idx_events_{model,source,type}, which
// carry no timestamp, so they scanned *every* row and probed the table to
// re-check the window — the default 1 h view paid a full 50 k-row table walk
// three times over, five-second poll after five-second poll.
//
// The columns each aggregation reads are few and small, so fold them into the
// index and the query never touches the table at all — SQLite answers straight
// from index leaves (EXPLAIN: "USING COVERING INDEX"). Leading with the GROUP
// BY / range column keeps the grouping and the `timestamp >= ?` cutoff working
// off the same b-tree. Measured on the 50 k-row production copy: the whole
// /stats dropped 69 ms → 3.7 ms at 1 h and 125 ms → 35 ms at "all" *warm*, and
// far more cold, because a covering scan reads a few MB of compact index rather
// than seeking all over a 190 MB table. The indexes reused free pages left by
// retention pruning (net file growth ~0), and a fatter write path costs about
// 1 µs per inserted event — nothing next to the read it saves.
//
// One index per grouping, because the leading column has to match the GROUP BY
// for the scan to stay ordered *and* covering; a single timestamp-leading index
// covers the columns but the planner won't take it for a GROUP BY (it would owe
// a sort), so it falls back to the table probe. Kept alongside the narrow
// indexes, which still win the plain `col = ?` point lookups elsewhere.
db.exec(`CREATE INDEX IF NOT EXISTS idx_events_stats ON events(
  timestamp, hook_event_type, is_error, session_id,
  input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd)`); // totals + timeline
db.exec(`CREATE INDEX IF NOT EXISTS idx_events_model_cov ON events(
  model_name, timestamp, session_id,
  input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd)`); // by_model
db.exec(`CREATE INDEX IF NOT EXISTS idx_events_app_cov ON events(
  source_app, timestamp, session_id, hook_event_type,
  cost_usd, input_tokens, output_tokens)`); // by_app (hook_event_type for the tool_calls CASE)
db.exec(`CREATE INDEX IF NOT EXISTS idx_events_type_cov ON events(
  hook_event_type, timestamp, tool_name, duration_ms, is_error)`); // by_type + tool-latency durations

// Sessions have no payload of their own, so these are real columns, written at
// upsert and backfilled from the session's events for rows that predate them.
//
// `cwd_path` is what makes an agent attributable to the worktree it ran in.
// `project_path` folds every checkout onto the one repo — which is right for
// grouping, and useless for telling two agents apart when a user has a dozen
// worktrees open at once and wants to know which card each one is working.
for (const col of ["project_path", "cwd_path"]) {
  try { db.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`); } catch { /* already present */ }
  // The `IN` guard is what stops this from being a permanent startup cost.
  // Most sessions legitimately have no cwd — it's only recorded when the turn
  // ran somewhere other than the repo root — so `WHERE cwd_path IS NULL` alone
  // never stops matching them, and the correlated subquery would re-run for
  // every one of them on every single boot, forever. Driving from the indexed
  // event columns bounds the work to sessions that actually have an answer,
  // which after the first run is none.
  db.exec(`
    UPDATE sessions SET ${col} = (
      SELECT e.${col} FROM events e
       WHERE e.session_id = sessions.session_id AND e.${col} IS NOT NULL
       ORDER BY e.id DESC LIMIT 1
    ) WHERE ${col} IS NULL
      AND session_id IN (SELECT session_id FROM events WHERE ${col} IS NOT NULL)`);
}
db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path)");

// ---------------------------------------------------------------------------
// Control plane: gate requests.
//
// The gate used to live only in memory, which made the one feature whose job is
// human oversight the least durable thing in the server: a restart dropped
// every held request, the hook's long-poll fell into its timeout branch, and
// "waiting for a human" silently became "auto-allowed". Every request is now
// written on arrival and updated when it resolves, so a restart can re-hydrate
// the queue and every outcome — including the ones nobody decided — has a row.
//
// `decision` NULL means still pending. `resolution` records *who* decided:
// human, timeout, or restart (expired while the server was down).
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS gates (
  id TEXT PRIMARY KEY,
  source_app TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  decision TEXT,
  reason TEXT,
  resolution TEXT,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_gates_pending ON gates(decision, expires);
CREATE INDEX IF NOT EXISTS idx_gates_created ON gates(created);
`);

export interface GateRow {
  id: string;
  source_app: string;
  session_id: string;
  tool_name: string;
  summary: string;
  created: number;
  expires: number;
  decision: "allow" | "deny" | null;
  reason: string | null;
  resolution: "human" | "timeout" | "restart" | null;
  decided_at: number | null;
}

const gateInsert = db.query(`
  INSERT OR REPLACE INTO gates (id, source_app, session_id, tool_name, summary, created, expires)
  VALUES ($id, $source_app, $session_id, $tool_name, $summary, $created, $expires)`);
// Only ever resolves a still-pending row: a decision already recorded wins over
// a late timeout, so a human's approve can't be overwritten by the clock.
const gateResolve = db.query(`
  UPDATE gates SET decision = $decision, reason = $reason, resolution = $resolution, decided_at = $decided_at
   WHERE id = $id AND decision IS NULL`);
const gateById = db.query<GateRow, [string]>(`SELECT * FROM gates WHERE id = ?`);
const gatesPending = db.query<GateRow, []>(`SELECT * FROM gates WHERE decision IS NULL ORDER BY created ASC`);
const gatesRecent = db.query<GateRow, [number]>(
  `SELECT * FROM gates WHERE decision IS NOT NULL ORDER BY decided_at DESC LIMIT ?`);

export function recordGate(g: {
  id: string; source_app: string; session_id: string; tool_name: string;
  summary: string; created: number; expires: number;
}): void {
  gateInsert.run({
    $id: g.id, $source_app: g.source_app, $session_id: g.session_id, $tool_name: g.tool_name,
    $summary: g.summary, $created: g.created, $expires: g.expires,
  } as any);
}

export function resolveGateRow(
  id: string,
  decision: "allow" | "deny",
  reason: string,
  resolution: "human" | "timeout" | "restart",
  decided_at = Date.now(),
): void {
  gateResolve.run({ $id: id, $decision: decision, $reason: reason, $resolution: resolution, $decided_at: decided_at } as any);
}

export function getGate(id: string): GateRow | null {
  return gateById.get(id) ?? null;
}

/** Gate requests written but never resolved — the queue to re-hydrate on boot. */
export function undecidedGates(): GateRow[] {
  return gatesPending.all();
}

/** Recently resolved gates, newest first — the "what happened while you were
 *  away" record, including the ones a timeout or a restart decided for you. */
export function gateHistory(limit = 50): GateRow[] {
  return gatesRecent.all(Math.max(1, Math.min(500, limit)));
}

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

/**
 * Every project/cwd path the events table actually contains.
 *
 * Tiny — single digits on a real database, because it is one entry per checkout
 * anyone has ever worked in — and both columns are indexed, so this is two
 * covering scans measured at 5ms and 2ms. Cached anyway, and invalidated the
 * moment an event arrives carrying a path that is not in it, so a brand-new
 * worktree shows up on its first event rather than up to a TTL later.
 */
const PATHS_TTL_MS = 30_000;
let pathCache: { at: number; paths: string[] } | null = null;

function recordedPaths(): string[] {
  if (pathCache && Date.now() - pathCache.at < PATHS_TTL_MS) return pathCache.paths;
  const seen = new Set<string>();
  for (const col of ["project_path", "cwd_path"] as const) {
    for (const r of db.query<{ p: string | null }, []>(`SELECT DISTINCT ${col} AS p FROM events`).all()) {
      if (r.p) seen.add(r.p);
    }
  }
  const paths = [...seen];
  pathCache = { at: Date.now(), paths };
  return paths;
}

/** Called at ingest when a row carries a path the cached set has not seen. */
function notePath(p: unknown): void {
  if (typeof p !== "string" || !p) return;
  if (pathCache && !pathCache.paths.includes(p)) pathCache = null;
}

/** SQL fragment + args restricting an events query to one project.
 *
 *  A scoped cockpit is *about* that project, so rows from anywhere else stay
 *  hidden even though they remain in the DB — an earlier machine-wide run, or
 *  hooks fired by a sibling repo. In scope means the resolved repo root or the
 *  raw cwd is one of the project's checkouts, or sits inside one (a monorepo
 *  subdir) — the same test the scanner applies at ingest.
 *
 *  Rows with no recorded path (pre-scanner events) are treated as out of scope:
 *  a project view that quietly includes "unknown" is worse than one that is
 *  honestly narrow. Empty clause when unscoped — the whole-machine view.
 *
 *  The shape of this clause is the whole point. It used to be one four-way OR
 *  group per checkout — `= ? OR LIKE ? OR = ? OR LIKE ?` — which on a repo with
 *  eighteen worktrees is seventy-two predicates, half of them LIKE, evaluated
 *  against every row. No index survives that, and it got worse with every
 *  worktree added: the loop watchdog caught `/events/filter-options` at 1432ms
 *  and `/sessions` at 1078ms, on the thread that carries the terminal.
 *
 *  So the prefix logic moves out of SQL. The set of paths the table actually
 *  contains is tiny and indexed; work out which of *those* are in scope here,
 *  in a language that can do it once instead of per row, and hand SQLite an
 *  equality test it can index. Same rows, measured 194ms → 9ms on the same
 *  query — and it no longer degrades as checkouts are added.
 *
 *  The JS test is also stricter than the SQL it replaces: `LIKE 'x/%'` treats
 *  `_` as a wildcard, so a path containing an underscore matched more than it
 *  should have. `startsWith` does not.
 */
export function scopeClause(scope: string | null = workspaceRoot()): { clause: string; args: string[] } {
  if (!scope) return { clause: "", args: [] };
  // Every checkout of the project, not the scope path alone: linked worktrees
  // usually live in sibling directories, so a prefix test against the scope
  // matches none of them — a project opened at ~/code/orbit would show an empty
  // dashboard for a day spent working in ~/code/orbit-WEB-1042, which is where
  // the work actually happens.
  const roots = scopeRoots(scope);
  const inScope = recordedPaths().filter((p) => roots.some((r) => p === r || p.startsWith(r + "/")));
  // Nothing recorded for this project yet. `AND 0` is the honest answer and the
  // fast one; an empty IN list is a syntax error.
  if (!inScope.length) return { clause: " AND 0", args: [] };
  // Column names stay unqualified: openToolCalls() rewrites them to `p.<col>`
  // for its aliased query.
  const q = inScope.map(() => "?").join(",");
  return {
    clause: ` AND (project_path IN (${q}) OR cwd_path IN (${q}))`,
    args: [...inScope, ...inScope],
  };
}

/** Same restriction for the `sessions` table, which carries its own columns. */
function sessionScopeClause(scope: string | null = workspaceRoot()): { clause: string; args: string[] } {
  // Delegate to scopeClause rather than keep a second copy: this used its own
  // `LIKE 'root/%'` pattern — the very thing scopeClause was rewritten to drop,
  // because an underscore in a scope root is a single-char wildcard in LIKE and
  // over-matches sibling projects (root_backup as well as root). The sessions
  // table carries the same project_path/cwd_path columns, so the resolved-path
  // IN clause applies unchanged, and correctly.
  return scopeClause(scope);
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
  // Resolved gates only — a pending one is a live request, never retention's
  // business no matter how old its row looks.
  db.run(`DELETE FROM gates WHERE decision IS NOT NULL AND created < ?`, [cutoff]);
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
  // A path nobody has recorded before means the scope set is stale — a new
  // worktree must appear in a scoped dashboard on its first event, not on the
  // first event after a cache expiry.
  notePath(n.payload?.project_path);
  notePath((n.payload as { cwd?: unknown } | undefined)?.cwd);

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
  // A Pre opens a call and a Post closes one, so the open-tool memo the fleet
  // draws from just went stale. Drop it here, the single write chokepoint, so
  // the next read — the push that fires right after this returns — is fresh,
  // while an idle machine with no tool traffic never invalidates and so never
  // re-runs that scoped scan on the tick.
  if (n.hook_event_type === "PreToolUse" || isToolPost(n.hook_event_type)) invalidateOpenTools();
  return { event, session };
}

const upsertStmt = db.query(`
  INSERT INTO sessions (
    session_id, source_app, model_name, provider, project_path, cwd_path, started_at, ended_at, last_seen,
    event_count, tool_count, error_count,
    input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd
  ) VALUES (
    $sid, $src, $model, $provider, $project, $cwd, $ts, $ended, $ts,
    1, $tool, $err,
    $in, $out, $cw, $cr, $cost
  )
  ON CONFLICT(session_id) DO UPDATE SET
    source_app = excluded.source_app,
    model_name = COALESCE(excluded.model_name, sessions.model_name),
    provider = COALESCE(excluded.provider, sessions.provider),
    project_path = COALESCE(excluded.project_path, sessions.project_path),
    cwd_path = COALESCE(excluded.cwd_path, sessions.cwd_path),
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
    // Only present when the turn ran somewhere other than the repo root — a
    // linked worktree or a monorepo subdir. COALESCE keeps the last known one
    // rather than letting a root-level turn erase it.
    $cwd: typeof n.payload?.cwd === "string" ? n.payload.cwd : null,
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
/**
 * Record what a session is called.
 *
 * Each title is written only when we actually have one, so an AI title arriving
 * on a later sweep can't blank a rename, and a rename can't be undone by the
 * next AI title. COALESCE on the argument rather than on the column, because
 * "no title in this file" and "the title is empty" have to behave differently.
 */
export function setSessionTitles(session_id: string, custom: string | null, ai: string | null): void {
  if (custom) db.query("UPDATE sessions SET custom_title = ? WHERE session_id = ?").run(custom, session_id);
  if (ai) db.query("UPDATE sessions SET ai_title = ? WHERE session_id = ?").run(ai, session_id);
}

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
          COALESCE(p.tool_name, 'tool') AS tool_name, p.timestamp AS since,
          json_extract(p.payload, '$.tool_input.file_path') AS target,
          -- Where the call is running, for the tools whose only possible
          -- evidence is that something moved in it: the turn's cwd when it ran
          -- somewhere other than the repo root, the project path otherwise.
          COALESCE(json_extract(p.payload, '$.cwd'), json_extract(p.payload, '$.project_path')) AS dir
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

/**
 * Short memo for the open-tool list, with write-driven invalidation.
 *
 * This scoped query — correlated subqueries over the whole worktree family — is
 * one of the ~250 ms event-loop blocks the loop watchdog caught firing on every
 * 4 s fleet tick on a real cockpit, and the loop it blocks is the one the PTY
 * rides. The list only changes when a tool opens or closes, i.e. on a
 * PreToolUse / PostToolUse write, so insertEvent() calls invalidateOpenTools()
 * on exactly those. Two properties make the memo safe:
 *   - an *empty* result stays valid until a write — an idle machine with
 *     nothing running recomputes never, so the tick stops costing anything;
 *   - a *non-empty* result ages out after a short TTL, so a tool whose process
 *     died without a PostToolUse still drops off as its 30 min age-out passes,
 *     within the TTL rather than only on the next unrelated write.
 * Keyed on scope so switching project can never serve another project's list.
 */
const OPEN_TOOL_TTL_MS = 2000;
let openToolCache: { at: number; scope: string | null; data: OpenToolCall[] } | null = null;

/** Drop the open-tool memo. insertEvent() calls this on a Pre/PostToolUse write
 *  so a tool that just opened or closed shows on the very next read. */
export function invalidateOpenTools(): void {
  openToolCache = null;
}

/** Currently-running tool calls across the fleet (open Pre, unpaired, session
 *  still alive) — the seed for the client's per-agent "running" state. */
export function openToolCalls(): OpenToolCall[] {
  const scope = workspaceRoot();
  if (openToolCache && openToolCache.scope === scope) {
    // Empty is valid until a write invalidates it; non-empty honours the TTL so
    // an age-out cannot hide behind a quiet period.
    if (openToolCache.data.length === 0 || Date.now() - openToolCache.at < OPEN_TOOL_TTL_MS) {
      return openToolCache.data;
    }
  }
  // Aliased to `p`, so the shared clause needs qualifying to stay unambiguous
  // against the correlated subqueries above.
  const s = scopeClause(scope);
  const scoped = s.clause.replace(/\b(project_path|cwd_path)\b/g, "p.$1");
  const data = db
    .query<OpenToolCall, any[]>(openToolSql(scoped))
    .all(Date.now() - OPEN_TOOL_MAX_MS, ...s.args);
  openToolCache = { at: Date.now(), scope, data };
  return data;
}

/**
 * The filter dropdowns' contents, cached.
 *
 * Measured by the loop watchdog on a real cockpit: 1432ms of blocked event
 * loop, five times in two minutes — the single worst freeze in the app, and
 * every millisecond of it is a terminal that has stopped echoing, because the
 * PTY rides this same thread.
 *
 * Three `SELECT DISTINCT` over 35k rows should be instant, and would be if the
 * scope filter did not expand to one four-way OR group per checkout of the
 * project. Eighteen worktrees is seventy-two predicates, half of them LIKE, on
 * every row — which no index survives. Fixing that clause is worth doing and is
 * not a thing to rush; caching what it feeds is worth doing anyway, because
 * this is the contents of a dropdown. A new app or model appearing thirty
 * seconds late costs nothing; the freeze costs the terminal.
 */
const FILTER_TTL_MS = 30_000;
let filterCache: { at: number; scope: string | null; data: ReturnType<typeof computeFilterOptions> } | null = null;

export function getFilterOptions() {
  const scope = workspaceRoot();
  if (filterCache && filterCache.scope === scope && Date.now() - filterCache.at < FILTER_TTL_MS) return filterCache.data;
  const data = computeFilterOptions();
  filterCache = { at: Date.now(), scope, data };
  return data;
}

function computeFilterOptions() {
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

/**
 * Short-TTL memo for /sessions, same shape and rationale as statsCache below.
 * The fleet polls this list on the same 4 s timer and from more than one
 * surface at once — desktop app plus a browser tab, a StrictMode double-mount —
 * so the identical (limit, provider, scope) list gets asked for several times
 * inside a second. The query is scoped to the whole worktree family and was
 * another ~250 ms block the loop watchdog caught; one second keeps the list
 * live to the eye while stopping the loop that also drives the PTY from running
 * the same scan back to back. Keyed with scope, so switching project can never
 * serve another project's sessions.
 */
const SESSIONS_TTL_MS = 1000;
const sessionsCache = new Map<string, { at: number; data: SessionRollup[] }>();

export function getSessions(limit = 100, provider?: string): SessionRollup[] {
  const key = `${limit}|${provider ?? ""}|${workspaceRoot() ?? ""}`;
  const hit = sessionsCache.get(key);
  if (hit && Date.now() - hit.at < SESSIONS_TTL_MS) return hit.data;
  const s = sessionScopeClause();
  const prov = provider ? { clause: " AND provider = ?", args: [provider] } : { clause: "", args: [] };
  const data = db
    .query<SessionRollup, any[]>(
      `SELECT * FROM sessions WHERE 1=1${prov.clause}${s.clause} ORDER BY last_seen DESC LIMIT ?`
    )
    .all(...prov.args, ...s.args, limit);
  sessionsCache.set(key, { at: Date.now(), data });
  // One entry per (limit, provider, scope); the limit set is tiny and scope
  // rarely changes, so prune stale entries anyway so a long-lived server cannot
  // leak.
  if (sessionsCache.size > 64) for (const [k, v] of sessionsCache) if (Date.now() - v.at >= SESSIONS_TTL_MS) sessionsCache.delete(k);
  return data;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/**
 * Short-TTL memo for /stats, on top of the covering-index fix above.
 *
 * The dashboard polls /stats on a timer (every 4 s for the live 1 h view) and
 * usually from more than one surface at once — the desktop app and a browser
 * tab, a StrictMode double-mount, a modal opened over the header — so the same
 * (window, provider, project) summary gets asked for several times inside a
 * second. The indexes made one computation cheap; this stops the loop from
 * doing three or four identical ones back to back, which matters precisely
 * because that loop also drives the PTY. A one-second life keeps it live: the
 * numbers are a rolling summary the eye reads for shape, not a counter anyone
 * watches tick, and the poll cadence is slower than the TTL anyway. Same idea
 * as filterCache above, keyed the same way (scope in the key, so switching
 * project can never serve another project's totals).
 *
 * Deliberately not applied to /gate/pending: that queue is what a human is
 * waiting on to approve a tool call, and a held-back gate is worse than a slow
 * one — it already answers from memory, not the DB, so it needs no cache.
 */
const STATS_TTL_MS = 1000;
const statsCache = new Map<string, { at: number; data: StatsSummary }>();

/** Full analytics summary over a rolling window (default 24h), optionally scoped
 *  to a single provider (Anthropic / OpenAI / Google / …). Always scoped to the
 *  open project, so spend, tool mix and the radar describe that project alone. */
export function statsSummary(windowMs = 24 * 3600 * 1000, provider?: string): StatsSummary {
  const key = `${windowMs}|${provider ?? ""}|${workspaceRoot() ?? ""}`;
  const hit = statsCache.get(key);
  if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.data;
  const data = computeStatsSummary(windowMs, provider);
  // One entry per (window, provider, scope). The window set is fixed and small
  // (the header's chips) and scope rarely changes, so this never grows unbounded
  // in practice; prune stale entries anyway so a long-lived server can't leak.
  statsCache.set(key, { at: Date.now(), data });
  if (statsCache.size > 64) for (const [k, v] of statsCache) if (Date.now() - v.at >= STATS_TTL_MS) statsCache.delete(k);
  return data;
}

function computeStatsSummary(windowMs: number, provider?: string): StatsSummary {
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
  // Project scope, same as every other aggregation in computeStatsSummary. Its
  // absence here leaked top_skills — and the cost charged to them — from every
  // other project on the machine into a cockpit opened for one.
  const { clause: sc, args: sa } = scopeClause();
  const invocations = db
    .query<{ session_id: string; timestamp: number; skill: string }, any[]>(
      `SELECT session_id, timestamp, json_extract(payload, '$.tool_input.skill') AS skill
       FROM events
       WHERE hook_event_type = 'PreToolUse' AND tool_name = 'Skill'
         AND json_extract(payload, '$.tool_input.skill') IS NOT NULL AND timestamp >= ?${pf}${sc}
       ORDER BY session_id, timestamp`
    )
    .all(since, ...pa, ...sa);
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

  // Charge each cost-bearing event to the running skill at that moment — scoped
  // too, or an out-of-project session's spend is attributed to an in-project
  // skill it never ran.
  const costRows = db
    .query<{ session_id: string; timestamp: number; cost_usd: number }, any[]>(
      `SELECT session_id, timestamp, cost_usd FROM events WHERE cost_usd > 0 AND timestamp >= ?${sc}`
    )
    .all(since, ...sa);
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
            MAX(cwd_path) cwd_path,
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
    // The checkout it ran in, when that isn't the repo root — what a resume has
    // to use, and what names the worktree in the header.
    cwd_path: roll?.cwd_path ?? agg.cwd_path ?? null,
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
