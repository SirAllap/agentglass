import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, chmodSync, readFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  UsageDay,
} from "../../shared/types.ts";
import type { NormalizedEvent } from "./ingest.ts";
import { costUsd, modelLabel, hasPrice, equivalentTokens } from "./pricing.ts";
import { providerOf as sharedProviderOf, UNKNOWN as UNKNOWN_MODEL } from "../../shared/models.ts";
import { workspaceRoot, scopeRoots, isWithin } from "./config.ts";

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
  /*
   * A PROBE'S STATE DIRECTORY OWNS ITS DATABASE TOO.
   *
   * `AGENTGLASS_STATE_DIR` is how a second server — a probe, a measurement, an
   * agent trying something — says "my state lives over here". Everything else
   * honoured it (tmux socket, panes, tasks) and this did not, so a probe with a
   * scratch state directory still opened the REAL history and wrote to it.
   *
   * Measured 2026-08-27: a probe started at 22:19 the night before was still
   * running eighteen hours later against this database, with the previous
   * day's code. Its watchdog stopped the deputy's shifts with a reason that no
   * longer exists in the source and closed the rows of runs that were alive —
   * from a process nobody was looking at, while the app itself was fixed and
   * reinstalled four times. The whole afternoon read as "the deputy does not
   * work".
   *
   * `AGENTGLASS_DB` still wins over this: naming a file exactly is a stronger
   * statement than naming a directory.
   */
  const state = process.env.AGENTGLASS_STATE_DIR;
  if (state) {
    try {
      mkdirSync(state, { recursive: true, mode: 0o700 });
      return join(state, "agentglass.db");
    } catch { /* unwritable: fall through to the ordinary answer */ }
  }
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

/**
 * Where a test's database lives, which is never the developer's.
 *
 * Several test files set AGENTGLASS_DB to a scratch file and only then import
 * this module, which is the right instinct and does not survive contact with a
 * full run: this file opens its Database at module load, so whichever test file
 * imports it first decides the path for the whole process. Everyone after that
 * silently reads and writes the real history instead. That is how 69 fixture
 * events ("scoped", "other", "mono") ended up in a developer's own database,
 * and why `whole-machine discovery` failed on a working machine while passing
 * in CI: it was being handed the machine's actual repositories.
 *
 * So under `bun test`, which sets NODE_ENV=test, a scratch file is the floor.
 * A test that asked for a specific path under the scratch directory still gets
 * it; anything else, including asking for nothing, gets a fresh empty database
 * that no import order can turn back into the real one.
 */
function testDbPath(): string {
  const asked = process.env.AGENTGLASS_DB;
  const scratch = tmpdir();
  if (asked && (asked === scratch || asked.startsWith(scratch + "/"))) return asked;
  return join(mkdtempSync(join(scratch, "agx-test-db-")), "agentglass.db");
}

const DB_PATH = process.env.NODE_ENV === "test"
  ? testDbPath()
  : process.env.AGENTGLASS_DB || defaultDbPath();
/** Where the history actually is, for the one page that says so out loud. */
export const dbPath = (): string => DB_PATH;
const db = new Database(DB_PATH, { create: true });
// The DB holds full prompts, file contents and command output in cleartext.
// Default file perms (0644) leave it world-readable; only $HOME being 0700
// keeps other local users out, which isn't a guarantee (a synced or shared
// home, a container mount). Lock the file — and the WAL/SHM that carry recent
// rows — to the owner.
for (const suffix of ["", "-wal", "-shm"]) {
  try { chmodSync(DB_PATH + suffix, 0o600); } catch { /* not created yet — created 0600 once WAL kicks in */ }
}
// Wait for a lock instead of failing on it. WAL lets readers and one writer
// work at once, but two writers still collide — and this database has several:
// the ingest path, the transcript scanner's sweep, and the retention prune.
// Without a timeout SQLite raises SQLITE_BUSY immediately, which surfaces as a
// dropped event rather than as the momentary contention it actually is.
//
// FIRST, before the journal_mode switch below, and that order is load-bearing:
// setting journal_mode takes a lock, and if another process is recovering the
// WAL at that instant it fails with SQLITE_BUSY_RECOVERY — measured, as an
// uncaught SQLiteError at module load that killed the whole server on the way
// up. busy_timeout is a connection setting that needs no lock of its own, so
// applying it first turns that crash into a wait.
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_app TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_id TEXT,
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
  cost_usd REAL NOT NULL DEFAULT 0,
  pricing_baseline_usd REAL NOT NULL DEFAULT 0
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

// Keep local pricing state separate from the authoritative cost shown to the
// user. Existing databases predate reported per-event costs, so their current
// total is the correct starting baseline. ALTER and backfill are one transaction:
// a crash cannot leave the column present with every old baseline still zero.
const hasPricingBaseline = db
  .query<{ name: string }, []>("PRAGMA table_info(sessions)")
  .all()
  .some((column) => column.name === "pricing_baseline_usd");
if (!hasPricingBaseline) {
  db.transaction(() => {
    db.exec("ALTER TABLE sessions ADD COLUMN pricing_baseline_usd REAL NOT NULL DEFAULT 0");
    db.exec("UPDATE sessions SET pricing_baseline_usd = cost_usd");
  })();
}

// Optional idempotency key for external harnesses. Scoped to the sender and
// session so independent agents can use the same local counter safely.
try { db.exec("ALTER TABLE events ADD COLUMN event_id TEXT"); } catch { /* already present */ }

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_events_ingest_idempotency
  ON events(source_app, session_id, event_id)
  WHERE event_id IS NOT NULL
`);

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
// Timestamp folded in on purpose. Scope never filters project_path/cwd_path
// alone — every /stats, /events and /changes query pairs it with a `timestamp >=
// since` window. A bare project_path index made the MULTI-INDEX OR fetch *every*
// row that project ever produced and then filter the window row by row: on a
// project with months of history that is the ~400ms synchronous /stats stall the
// idle PTY rides (#220). With timestamp in the index the same OR restricts to the
// window inside the index — measured 60ms -> 0.1ms on a 200k-row DB. The
// composite still serves the plain `project_path = ?` lookups the single-column
// index did (leftmost prefix), so it replaces it outright; the old single-column
// indexes are dropped so an existing DB rebuilds to the better shape.
db.exec("DROP INDEX IF EXISTS idx_events_project");
db.exec("CREATE INDEX IF NOT EXISTS idx_events_project_ts ON events(project_path, timestamp)");
// A scoped query tests `cwd_path` once per checkout of the project, and a virtual
// column is recomputed by json_extract for every row it touches. Without this
// index, the user this change is for — a dozen worktrees open — is exactly the
// one who pays a full table scan with a JSON parse per row on /events, /stats and
// /changes; and, as above, timestamp folded in keeps the scan inside the window.
db.exec("DROP INDEX IF EXISTS idx_events_cwd");
db.exec("CREATE INDEX IF NOT EXISTS idx_events_cwd_ts ON events(cwd_path, timestamp)");
// `model_name` had none, so the filter dropdown's third query — SELECT DISTINCT
// over it — was the one full scan with a temp B-tree in that endpoint. Cheap
// index, and the covering scan it enables is what the other two already had.
db.exec("CREATE INDEX IF NOT EXISTS idx_events_model ON events(model_name)");

// Provider per EVENT, not per session. `sessions.provider` is one column set
// first-non-null-wins, so a session that ran Opus then GPT reported all of it
// under whichever provider was seen first. Deriving it per event (providerOf of
// that event's model) lets a provider filter attribute each event to the model
// that actually produced it, and lets a multi-provider session show up under
// each provider it used. NULL when the event's model never resolved — the
// Unknown bucket. Backfilled from model_name in backfillProvider(). Paired with
// timestamp in the index, like the scope columns, because every provider-scoped
// query also windows by time.
try { db.exec("ALTER TABLE events ADD COLUMN provider TEXT"); } catch { /* already present */ }

// A PreToolUse can be paired with exactly one Post.
//
// Pairing used to be a bare SELECT ... LIMIT 1 with nothing marking the row,
// so a Pre could answer any number of Posts. Two concurrent calls to the same
// tool both measured against the newest Pre — the second one's real duration
// vanished — and a Post with no matching id fell back to *any* earlier Pre for
// that tool with no age bound at all, which is how a 3,600,000 ms tool call
// gets into the percentiles.
//
// Backfilled to 1 for every Pre that already has a Post, so the open-tool card
// does not retroactively sprout a fleet of calls that finished last week.
try {
  db.exec("ALTER TABLE events ADD COLUMN paired INTEGER NOT NULL DEFAULT 0");
  db.exec(`UPDATE events SET paired = 1
           WHERE hook_event_type = 'PreToolUse' AND tool_use_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM events p
                         WHERE p.tool_use_id = events.tool_use_id
                           AND p.hook_event_type IN ('PostToolUse','PostToolUseFailure'))`);
} catch { /* already present */ }
db.exec("CREATE INDEX IF NOT EXISTS idx_events_pre_open ON events(session_id, tool_name, paired, id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_events_provider_ts ON events(provider, timestamp)");
// Finding a session's FIRST prompt: the list asks for up to two hundred of
// them at once, and without this it is a scan of every UserPromptSubmit on the
// machine per refresh. See firstPrompts().
db.exec("CREATE INDEX IF NOT EXISTS idx_events_first_prompt ON events(hook_event_type, session_id, timestamp)");

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
// `project_path` and `cwd_path` are VIRTUAL columns — json_extract, recomputed
// for every row that touches them — so a scoped /stats paid a JSON parse twice
// per row for a filter the index could have carried. Indexing them materialises
// them here, which is the whole point. Measured on a real 476 MB cockpit scoped
// to one project: the summary went 158.9 -> 137.5 ms over 24 hours and
// 394.0 -> 301.4 ms over all of history — synchronous blocks, on the thread the
// terminal rides. The file grew by nothing: it went into the freelist retention
// had already left.
//
// The old index has to GO, not merely be joined: measured, with both present
// the planner still took the narrow one. Written as DROP-then-CREATE under a new
// name, the pattern this file already uses two blocks down, because this whole
// section runs at every module load — a `DROP INDEX idx_events_type_cov;
// CREATE INDEX idx_events_type_cov` pair under the SAME name would rebuild the
// index on every launch, for ever. Under a new name, both statements are no-ops
// from the second launch on.
db.exec("DROP INDEX IF EXISTS idx_events_type_cov");
db.exec(`CREATE INDEX IF NOT EXISTS idx_events_type_cov_scoped ON events(
  hook_event_type, timestamp, project_path, cwd_path, tool_name, duration_ms, is_error)`); // by_type + tool-latency durations

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
/**
 * One scanner per database file — enforced in the file, not by hoping.
 *
 * The transcript scanner is the one writer here that is NOT idempotent: its
 * events carry `event_id: null`, so the idempotency index above
 * (`WHERE event_id IS NOT NULL`) cannot see, let alone drop, a line ingested
 * twice. Two server processes on one file therefore inflate event counts,
 * tokens and dollars in silence — nothing errors, the totals just grow.
 *
 * That is not hypothetical. Measured on this machine's own 354 MB history on
 * 2026-08-07: 22 duplicate groups, 22 extra rows out of 100,354 scanner events.
 * Small, and that is exactly why it went unnoticed for so long. Measured in the
 * lab with two real processes racing one live tail: 4 appended turns became 5
 * events and 5,000 input tokens instead of 4,000.
 *
 * It is easy to reach: `defaultDbPath()` resolves to the XDG data dir, so any
 * checkout without a local `agentglass.db` — none of the worktrees on this
 * machine have one — runs its scanner over the real history. The README's
 * "attaches, never duplicates" only fires on a `:4000` port collision, and a
 * second server started on another port on purpose sails straight past it.
 *
 * So the second process is held off here: the claim row names a pid and a port,
 * and whoever finds a LIVE claim that is not theirs runs with the scanner
 * disabled (see `startScanner`). Everything else it does — serving, hook ingest,
 * git, the terminal — is unaffected, and hook ingest is idempotent anyway.
 *
 * A stale claim must never lock anyone out: this app is SIGKILLed routinely
 * (the desktop shell kills its sidecar, `pkill` during development), so the row
 * regularly outlives its process. `holderAlive` is what decides, and it is
 * deliberately three checks deep because a bare `kill(pid, 0)` is wrong twice
 * over — pids are reused after a reboot and after wraparound.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS db_claim (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  port INTEGER NOT NULL,
  host TEXT NOT NULL DEFAULT '',
  boot_id TEXT NOT NULL DEFAULT '',
  start_ticks INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER NOT NULL
);
`);

export interface DbClaimRow {
  pid: number;
  port: number;
  host: string;
  boot_id: string;
  start_ticks: number;
  claimed_at: number;
}

/** The escape hatch, for the case this mechanism is the thing in the way.
 *  `0` skips claiming AND skips being held off — the pre-fix behaviour. */
const CLAIM_ENABLED = process.env.AGENTGLASS_DB_CLAIM !== "0";

/** stdout of a command, or "" — for the two Mac readings below, where there is
 *  no file to read and the answer has to be asked for. */
function ask(argv: string[]): string {
  try {
    const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "ignore" });
    return r.success ? new TextDecoder().decode(r.stdout) : "";
  } catch { return ""; }
}

/** Identifies the boot, so a pid from before a reboot is never mistaken for a
 *  live process. Linux reads the kernel's boot_id; a Mac has no /proc, so it
 *  asks `sysctl -n kern.boottime` — `{ sec = 1757000000, usec = 123 } …` — whose
 *  seconds are fixed for the life of a boot and different after one. Empty
 *  elsewhere, where the ticks check below still applies (and, failing both, a
 *  wrongly-live claim only disables a scanner). */
function bootId(): string {
  if (process.platform === "darwin") {
    const m = /sec\s*=\s*(\d+)/.exec(ask(["sysctl", "-n", "kern.boottime"]));
    return m ? `boot:${m[1]}` : "";
  }
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { return ""; }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * When that pid started — the property that distinguishes "the claim holder
 * is still running" from "some unrelated process now has that pid".
 *
 * Linux: field 22 of /proc/<pid>/stat, in clock ticks. Parsed from after the
 * last `)` because field 2 is the command name in parentheses and may itself
 * contain spaces and parens; splitting the whole line on spaces gets the wrong
 * column for anything named like `(my prog)`.
 *
 * macOS: there is no /proc, and before this branch the answer was 0 — which
 * `holderAlive` reads as "cannot tell", so a reused pid on a Mac passed as the
 * live holder and the second instance stood its scanner down for a process
 * that had been gone since the last login. `ps -o lstart=` prints the start
 * time to the second (`Fri Sep  5 10:11:12 2026`), which is not ticks but is
 * the same fact: two processes cannot share a pid AND a start second unless
 * the pid was reused within one second, which the kernel does not do. Parsed
 * by hand rather than `Date.parse`, whose reading of that legacy shape is
 * engine-specific; the value only has to be stable across reads of the same
 * process, so local time is fine.
 */
function startTicks(pid: number): number {
  if (process.platform === "darwin") {
    const m = /^\s*\w{3}\s+(\w{3})\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d{4})\s*$/.exec(ask(["ps", "-o", "lstart=", "-p", String(pid)]));
    const month = m ? MONTHS.indexOf(m[1]!) : -1;
    if (!m || month < 0) return 0;
    return Math.floor(new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime() / 1000);
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(rest[19]) || 0; // rest[0] is field 3 (state) → field 22 is index 19
  } catch { return 0; }
}

/** Is the process named by this claim still running, and still the same one? */
function holderAlive(row: DbClaimRow): boolean {
  if (row.pid <= 0) return false;
  // A claim written by another machine cannot be checked from here — there is no
  // such pid locally to ask about. Treat it as stale rather than refuse to scan
  // for ever: a database reachable from two hosts at once is a broken setup
  // (SQLite over a network filesystem), and a permanent lockout would be worse
  // than the duplicate ingest this guards.
  if (row.host && row.host !== hostname()) return false;
  const boot = bootId();
  if (boot && row.boot_id && boot !== row.boot_id) return false; // rebooted since
  try {
    process.kill(row.pid, 0);
  } catch (e) {
    // EPERM means the pid exists and belongs to another user — alive, just not
    // ours to signal. Only ESRCH ("no such process") means gone.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
  const ticks = startTicks(row.pid);
  if (ticks && row.start_ticks && ticks !== row.start_ticks) return false; // pid reused
  return true;
}

const readClaim = db.query<DbClaimRow, []>(
  "SELECT pid, port, host, boot_id, start_ticks, claimed_at FROM db_claim WHERE id = 1"
);
const writeClaim = db.query(`
  INSERT INTO db_claim (id, pid, port, host, boot_id, start_ticks, claimed_at)
  VALUES (1, $pid, $port, $host, $boot, $ticks, $at)
  ON CONFLICT(id) DO UPDATE SET
    pid = excluded.pid, port = excluded.port, host = excluded.host,
    boot_id = excluded.boot_id, start_ticks = excluded.start_ticks,
    claimed_at = excluded.claimed_at
`);
const dropClaim = db.query("DELETE FROM db_claim WHERE id = 1 AND pid = $pid AND host = $host");

/** Set when another live process holds the file, so the scanner can stand down
 *  and `/projects` can report honestly instead of claiming it is scanning. */
let heldOffBy: DbClaimRow | null = null;
/** The live holder of this database, or null when it is ours. */
export function dbClaimedElsewhere(): DbClaimRow | null {
  return heldOffBy;
}

export interface DbClaimResult {
  /** True when this process owns the file and may run its scanner. */
  ok: boolean;
  /** The live process that beat us to it, when `ok` is false. */
  holder: DbClaimRow | null;
  /** A dead process's claim we cleared out of the way — a SIGKILLed predecessor. */
  tookOver: DbClaimRow | null;
}

/**
 * Claim this database for this process. Call once, at boot, with the real port.
 *
 * IMMEDIATE so two servers starting at the same instant cannot both read "no
 * claim" and both write one: the write lock is taken at BEGIN, before the read,
 * so the loser waits and then sees the winner's row.
 *
 * It FAILS OPEN — a throw here reports "claimed", not "held off". That is a
 * deliberate choice and not a hole: this runs on the boot path, so failing
 * closed would mean a broken guard can stop the app scanning at all, while
 * failing open costs at worst the pre-fix behaviour, which the compare-and-swap
 * on `lines_done` (transcripts.ts) still covers.
 */
export function claimDatabase(port: number): DbClaimResult {
  if (!CLAIM_ENABLED) return { ok: true, holder: null, tookOver: null };
  try {
    return db.transaction((): DbClaimResult => {
      const prev = readClaim.get();
      if (prev && prev.pid !== process.pid && holderAlive(prev)) {
        heldOffBy = prev;
        return { ok: false, holder: prev, tookOver: null };
      }
      writeClaim.run({
        $pid: process.pid,
        $port: port,
        $host: hostname(),
        $boot: bootId(),
        $ticks: startTicks(process.pid),
        $at: Date.now(),
      });
      heldOffBy = null;
      return { ok: true, holder: null, tookOver: prev && prev.pid !== process.pid ? prev : null };
    }).immediate();
  } catch (e) {
    console.warn(`[db] could not claim ${DB_PATH}: ${e instanceof Error ? e.message : e} — scanning anyway`);
    heldOffBy = null;
    return { ok: true, holder: null, tookOver: null };
  }
}

/** Give the claim back on a clean exit. Best-effort by design: the SIGKILL case
 *  is precisely what `holderAlive` exists to handle, so a missed release costs
 *  nothing beyond one liveness check at the next boot. */
export function releaseDatabaseClaim(): void {
  if (!CLAIM_ENABLED || heldOffBy) return;
  try { dropClaim.run({ $pid: process.pid, $host: hostname() }); } catch { /* exiting anyway */ }
}

// ---------------------------------------------------------------------------
/**
 * Who did what, kept.
 *
 * The cockpit performs real writes — it stages and discards, force-pushes,
 * merges pull requests, removes containers, and answers the gate that has an
 * agent stopped at the other end of it. Every one of those was recorded only in
 * a ring buffer that says of itself, at gitlog.ts:11, that it is "a live view of
 * the current session, not an audit trail". So the moment more than one person
 * can reach a cockpit — or one person can reach it from two devices — "who
 * approved that" has no answer, and neither does "what happened to my branch
 * while I was at lunch".
 *
 * Append-only, and small enough to stay that way: every row here is a human
 * pressing something, which is tens of rows a day, not the thousands an hour
 * the events table takes. Nothing prunes it and nothing needs to.
 *
 * `actor` is what the server can honestly assert, which is where the request
 * came from and nothing more. There are no accounts here — a token is shared,
 * not personal — so claiming a name would be a fiction. `local` means the
 * loopback caller, which is the dashboard on this machine; anything else is the
 * address it came from, which is how "I approved that from my phone" gets an
 * answer.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_actions_at ON actions(at);
`);

export interface ActionRow {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string;
  ok: number;
  detail: string | null;
}

const actionInsert = db.query(
  `INSERT INTO actions (at, actor, action, target, ok, detail) VALUES ($at, $actor, $action, $target, $ok, $detail)`
);

/** Write one row. Never throws: a failed audit write must not fail the action
 *  it was recording, which would be a worse outcome than a missing line. */
export function recordAction(a: {
  actor: string; action: string; target?: string; ok: boolean; detail?: string | null; at?: number;
}): void {
  try {
    actionInsert.run({
      $at: a.at ?? Date.now(),
      $actor: a.actor,
      $action: a.action,
      $target: a.target ?? "",
      $ok: a.ok ? 1 : 0,
      $detail: a.detail ?? null,
    } as any);
  } catch { /* the action already happened; losing its record is the lesser harm */ }
}

/** Newest first. Unscoped on purpose: the question this answers is "what has
 *  been done through this cockpit", and narrowing it by the project that
 *  happens to be open would hide exactly the answer somebody is looking for. */
export function actionLog(limit = 200, before?: number): ActionRow[] {
  const n = Math.max(1, Math.min(1000, limit));
  return before
    ? db.query<ActionRow, [number, number]>(`SELECT * FROM actions WHERE at < ? ORDER BY at DESC, id DESC LIMIT ?`).all(before, n)
    : db.query<ActionRow, [number]>(`SELECT * FROM actions ORDER BY at DESC, id DESC LIMIT ?`).all(n);
}

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
/**
 * What survives the prune.
 *
 * Raw events are deleted at AGENTGLASS_RETENTION_DAYS, which is right for
 * rows carrying prompts and command lines, and silently caps every question
 * worth asking: what a project cost last month, this sprint against the last,
 * whether a budget is being kept. The only escape was raising retention and
 * paying for it in database size and query time.
 *
 * So expiring events are folded into a day-grained summary before they are
 * deleted. One row per (day, project, session, model, provider) is small
 * enough to keep for years — a busy month of one project is a few thousand
 * rows against a few hundred thousand events.
 *
 * What does NOT survive, and cannot: percentiles. p50 and p95 do not
 * aggregate — an average of percentiles is not a percentile of anything. The
 * total duration and the number of timed calls are carried instead, which
 * gives an honest mean and nothing it cannot support.
 *
 * The key columns COALESCE to '' rather than allowing NULL, because NULLs are
 * distinct from each other in a UNIQUE index and the upsert would insert a
 * new row every night instead of accumulating.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS daily_rollup (
  day TEXT NOT NULL,            -- YYYY-MM-DD, UTC
  project_path TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_app TEXT NOT NULL,
  model_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  tool_errors INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  duration_ms_total INTEGER NOT NULL DEFAULT 0,
  timed_calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, project_path, session_id, model_name, provider)
);
CREATE INDEX IF NOT EXISTS idx_rollup_day ON daily_rollup(day);
CREATE INDEX IF NOT EXISTS idx_rollup_project_day ON daily_rollup(project_path, day);
`);

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

/*
 * When to tell somebody about something.
 *
 * The one part of the task feature that is ours. Taskwarrior owns what a task
 * IS and has nowhere to put a reminder; we own when to speak, which is also the
 * part that must keep working when Taskwarrior is absent, unconfigured, or
 * being written to by an editor at the same moment. task_uuid is nullable and
 * first-class: a reminder with no task behind it is a legitimate thing to want.
 *
 * title is a snapshot, not a join. It must be possible to fire a reminder on
 * a machine where the task list cannot be read at all — and a notification that
 * says "reminder about (unavailable)" is worse than none.
 *
 * civil + zone rather than an instant alone, because "Monday 9:00" is a
 * civil time. Fixing it to an epoch at creation fires it an hour wrong on the
 * far side of a daylight-saving change — twice a year, for anyone in Europe.
 * due is the resolved cache, recomputed when the two disagree.
 *
 * fired_at is the ledger. It is written inside the claim, before any delivery
 * is attempted: a crash between claim and send costs one missed ping, and the
 * other order costs a duplicate. A missed ping sits red on screen until
 * acknowledged; a duplicate at three in the morning is an uninstall.
 */
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  task_uuid TEXT,
  title TEXT NOT NULL,
  root TEXT,
  civil TEXT NOT NULL,
  zone TEXT NOT NULL,
  due INTEGER NOT NULL,
  created INTEGER NOT NULL,
  fired_at INTEGER,
  acked_at INTEGER,
  cancelled_at INTEGER,
  snooze_of TEXT
);
CREATE INDEX IF NOT EXISTS idx_reminders_live ON reminders(fired_at, due);
`);
/**
 * *Which* human, not just that one of them answered.
 *
 * `resolution` already said what kind of thing decided — a person, the clock, a
 * restart — and that was the whole answer while a cockpit had one door. Now a
 * paired phone carries its own credential and its own name (devices.ts), so a
 * gate can be approved by somebody who is not at the machine, and "a human
 * decided" stops being an answer to "who".
 *
 * It lives on the gate row rather than only in `actions` because the two cannot
 * be joined: an action line records the route and a clipped `tool · summary`,
 * so two gates on the same tool a second apart are indistinguishable in it. The
 * column is written by the same UPDATE that resolves the row, which is what
 * makes it impossible for the actor and the decision to disagree.
 *
 * NULL when nobody decided. A timeout is not an actor, and writing "system"
 * would invent one — the same reason `actorOf` refuses to invent a name.
 */
try { db.exec("ALTER TABLE gates ADD COLUMN decided_by TEXT"); } catch { /* already present */ }

// ---------------------------------------------------------------------------
/*
 * The understudy — what he would have done, and how often that matched.
 *
 * Four tables, created in one block, and the shape has to be right the first
 * time. This file has no migration system: it versions itself with CREATE TABLE
 * IF NOT EXISTS for anything new and an ad-hoc `try { ALTER TABLE … } catch {}`
 * for a column added later, which works for one column and degrades badly for a
 * table whose columns are the record. A rename here cannot be expressed at all,
 * so every column below is either one the scorecard reads today or one whose
 * absence would make an already-written row unreadable later.
 *
 * What the ledger is NOT is the thing worth stating first. It holds no request
 * body, no prompt, no keystroke and no free text. `subject` is an identifier —
 * a pull request number, a branch name, a pane id — and `predicted`/`actual`
 * are JSON of CATEGORICAL decisions: which branch pattern, which cwd, which of
 * the offered findings were rejected. That is enough to score agreement and not
 * enough to reconstruct what he was working on, which is the trade the whole
 * feature is built around. A ledger that kept the bodies would be a second copy
 * of everything sensitive in the product, in a table with a longer retention
 * than the events it was derived from.
 *
 * `sealed_at` and `situation_hash` are the reason the numbers mean anything.
 * The situation is hashed and written synchronously BEFORE he can answer it, so
 * a prediction can never be fitted to an answer already known. A prediction
 * that lands after his answer is kept with `late = 1` rather than dropped —
 * dropping late rows would quietly select for the situations that were easy to
 * predict fast — and an actual that arrives with no seal in front of it sets
 * `unsealed = 1`, which is counted against trigger recall instead of being
 * scored as a hit it never earned.
 *
 * `provenance` is what makes `n` honest: only `typed` and `clicked` count
 * toward a class's denominator. `agent-tolerated` is an agent not objecting,
 * which is not the user agreeing, and counting it would let the understudy
 * grade its own homework.
 *
 * `kind` splits the rows by how long they are worth keeping. A `stub` is the
 * bare fact that a write happened — route, actor, status — and it ages out at
 * ninety days. A `decision` (a prediction scored against an actual) and a
 * `fence` (a refusal, a halt) are the record itself and are never deleted.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS understudy_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  class TEXT NOT NULL DEFAULT '',
  route TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  repo TEXT NOT NULL DEFAULT '',
  partition TEXT NOT NULL DEFAULT 'global',
  actor TEXT NOT NULL DEFAULT '',
  provenance TEXT NOT NULL DEFAULT '',
  sealed_at INTEGER NOT NULL,
  situation_hash TEXT NOT NULL DEFAULT '',
  predicted TEXT,
  predicted_at INTEGER,
  late INTEGER NOT NULL DEFAULT 0,
  actual TEXT,
  actual_at INTEGER,
  unsealed INTEGER NOT NULL DEFAULT 0,
  verdict TEXT,
  mode TEXT NOT NULL DEFAULT 'shadow',
  status INTEGER,
  tokens INTEGER NOT NULL DEFAULT 0
);
/*
 * What it would do, written down before anybody agrees to it.
 *
 * The ladder has a rung called "queued" and until now nothing built it. This is
 * that rung: the understudy drafts a WHOLE action — the route, the arguments,
 * why, and the evidence it stood on — files it here, and a person presses or
 * throws it away. Nothing runs on its own.
 *
 * It is the base of everything above it, and not because it is easy. It is the
 * only thing that produces the evidence that actually matters. The scorecard
 * answers "would it have guessed the shape of my answer"; a queue answers
 * "would it have done the right thing", which is a different question and the
 * one somebody needs settled before letting it act.
 *
 * args is JSON and evidence is JSON: what the proposal would send, and the
 * precedents and rules behind it, so a person deciding can see the reasoning
 * rather than a verdict. decided_by records who resolved it, because a
 * proposal the clone resolved itself would be the whole point defeated.
 */
CREATE TABLE IF NOT EXISTS understudy_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class TEXT NOT NULL,
  /* The ledger row this was drafted against, when there is one. */
  ledger_id INTEGER,
  /*
   * What it is ABOUT — the branch, the pull request number — as distinct from
   * what it would SEND.
   *
   * Missing at first, and the gap was invisible until something needed to
   * reverse an action: undoing a worktree removal means adding it back, which
   * needs the branch name, and the request body for a removal does not carry
   * one. A proposal that knows only its arguments cannot always describe its
   * own subject, and an undo recipe is exactly the thing that has to.
   */
  subject TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  route TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT 'POST',
  args TEXT NOT NULL DEFAULT '{}',
  repo TEXT NOT NULL DEFAULT '',
  partition TEXT NOT NULL DEFAULT 'closed',
  why TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  /* pending | approved | discarded | done | failed */
  state TEXT NOT NULL DEFAULT 'pending',
  decided_at INTEGER,
  decided_by TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',
  status INTEGER
);
CREATE INDEX IF NOT EXISTS idx_understudy_proposals ON understudy_proposals(state, created_at);

/*
 * A shift: the understudy standing in, for a bounded while.
 *
 * Everything else here is per-decision, and per-decision is not what "cover for
 * me for an hour" means. A stand-in needs to know what it is doing, how long it
 * has, when it has done enough, and — the part that actually matters — when to
 * stop and wait rather than carry on being confidently wrong.
 *
 * SO THE LIMITS ARE WRITTEN DOWN FIRST, BEFORE IT STARTS. Not as a policy it
 * consults and could reason its way around, but as columns: an end time, a
 * budget of actions, and a stop reason it fills in when it halts. A shift that
 * cannot say why it stopped is a shift nobody can audit, and the first question
 * anybody asks on coming back is "what did it do and why did it quit".
 *
 * goal is the person's own words. It is not parsed and nothing branches on
 * it: it exists so that what comes back can be read against what was asked for,
 * by the human, which is the only comparison that means anything here.
 */
CREATE TABLE IF NOT EXISTS understudy_shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  /* Hard wall. Past this it proposes nothing, whatever else is true. */
  ends_at INTEGER NOT NULL,
  /* And a budget, because an hour is a long time at machine speed. */
  max_actions INTEGER NOT NULL DEFAULT 10,
  actions INTEGER NOT NULL DEFAULT 0,
  /* running | done | stopped */
  state TEXT NOT NULL DEFAULT 'running',
  stopped_at INTEGER,
  stopped_reason TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'open-only'
);
CREATE INDEX IF NOT EXISTS idx_understudy_shifts ON understudy_shifts(state, started_at);

/*
 * What it did on its own, and how to put each one back.
 *
 * The moment anything acts without a press, one question matters more than the
 * rest: what happened while I was away, and can I undo it. A queue answers the
 * first half; this answers the second.
 *
 * The recipe is written AT THE MOMENT OF ACTING, not reconstructed afterwards.
 * A repository moves on, and an undo derived later is a guess about a world
 * that has changed since — the branch it would recreate may no longer point
 * where it did, and nobody would find out until they needed it.
 *
 * undo_kind and undo_arg are a RECIPE, never a command line. Storing shell to
 * run later would mean the undo path can do whatever that string says, which is
 * exactly the reach this design spends its whole length refusing to hand over.
 */
CREATE TABLE IF NOT EXISTS understudy_acts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER NOT NULL,
  proposal_id INTEGER,
  class TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  repo TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT '',
  undo_kind TEXT NOT NULL DEFAULT '',
  undo_arg TEXT NOT NULL DEFAULT '{}',
  undone_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_understudy_acts ON understudy_acts(shift_id, at);

/*
 * The work loop's two tables, moved here from the modules that used them.
 *
 * They were created with a db.run at module scope — correct-looking, and it
 * made the schema depend on WHICH FILES HAD BEEN IMPORTED. Every other table in
 * this application is declared in this one place and exists the moment the
 * database opens; those two existed only once somebody had reached for the
 * module that made them.
 *
 * That is invisible until the import order changes. It surfaced when two
 * branches were merged together and the suite gained a file that pulled the
 * work module in earlier: the schema test, which enumerates the tables a fresh
 * database gets, suddenly saw two more than it had been told about — passing
 * alone and failing in the full run, which is the worst way for a defect to
 * announce itself.
 *
 * A schema that depends on import order is not a schema. It belongs where the
 * database is opened, with everything else.
 */
CREATE TABLE IF NOT EXISTS understudy_work (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER,
  source TEXT NOT NULL DEFAULT '',
  item_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  repo TEXT NOT NULL DEFAULT '',
  worktree TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  /* running | done | failed | abandoned | uncommitted | empty */
  state TEXT NOT NULL DEFAULT 'running',
  outcome TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_understudy_work ON understudy_work(state, started_at);


/*
 * Where it raises its hand.
 *
 * The failure this exists for is silence: a run that cannot finish used to end
 * as a row nobody reads, and the loop would move on as if nothing had been
 * asked. Measured over 108 runs — 26 ended without delivering, and not one of
 * them said what it needed. Five sat unfinished for over 45 minutes, the worst
 * for 513, because the only thing that noticed was the next server start.
 *
 * So: when it cannot, or does not know, it writes here instead of dying quiet.
 * A row is a question addressed to a person, with what it already tried, so
 * the answer does not have to start by reconstructing the attempt.
 */
CREATE TABLE IF NOT EXISTS understudy_help (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  /* The run that gave up, when there was one. Null for a task that never got
     far enough to have a run at all. */
  run_id INTEGER,
  title TEXT NOT NULL,
  /* What it needs from a person, in one sentence. */
  question TEXT NOT NULL,
  /* What it tried, so the answer does not start from nothing. */
  tried TEXT NOT NULL DEFAULT '',
  repo TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL,
  /* Set when a person has dealt with it. An open row is one still waiting. */
  answered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_understudy_help_open ON understudy_help(answered_at, id);

/* Work he queued by hand: the only source that can say which checkout. */
CREATE TABLE IF NOT EXISTS understudy_asked (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  repo TEXT NOT NULL,
  at INTEGER NOT NULL,
  taken_at INTEGER,
  /* The file this task owes, when what it owes is a file rather than a commit.
     Nullable: most tasks owe a commit and this does not apply to them. See the
     ALTER below for databases that predate it, and the check in
     understudy-loop.ts for why it exists. */
  deliverable TEXT
);
CREATE INDEX IF NOT EXISTS idx_understudy_sealed ON understudy_ledger(sealed_at);
CREATE INDEX IF NOT EXISTS idx_understudy_class ON understudy_ledger(kind, class, sealed_at);
CREATE INDEX IF NOT EXISTS idx_understudy_subject ON understudy_ledger(class, subject, actual_at);

/*
 * The situation a hash stands for, kept only long enough to argue about it.
 *
 * hash is the primary key because the seal IS the identity: two ledger rows
 * that saw the same situation point at one body, and a body that arrives twice
 * is the same body. It expires at thirty days while the ledger row it belongs
 * to lives for ninety or for ever, and that asymmetry is deliberate — the score
 * is a permanent claim, the evidence behind one disagreement is only useful
 * while somebody might still look at it.
 */
CREATE TABLE IF NOT EXISTS understudy_snapshots (
  hash TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  repo TEXT NOT NULL DEFAULT '',
  partition TEXT NOT NULL DEFAULT 'global',
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_understudy_snap_at ON understudy_snapshots(at);

/*
 * Why something was refused — and only why.
 *
 * The quarantine exists because the understudy reads material that can carry a
 * name it must never write down: an employer, a ticket id, a customer. When a
 * term like that is found, the honest record is that a refusal happened and
 * where it happened, so a person can go and look at the source themselves.
 * What must not be here is the text that was refused or the term that matched
 * it, because a table of the exact strings we promised never to keep is the
 * worst possible shape for a table whose whole purpose is that promise.
 *
 * term_index is the position in the term list, not the term: -1 when the
 * refusal was not a term match at all. source_ref points back at whatever the
 * material was, so the trail is followable without the trail holding the thing.
 */
CREATE TABLE IF NOT EXISTS understudy_quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_ref TEXT NOT NULL,
  class TEXT NOT NULL DEFAULT '',
  term_index INTEGER NOT NULL DEFAULT -1,
  at INTEGER NOT NULL
);

/*
 * Decisions he has already made, in his own words, for the classes to reason
 * from. Created empty, and stays empty: v1 ingests nothing at all — no
 * transcripts are read, no model is called, and there is no writer for this
 * table anywhere in the server.
 *
 * It is here anyway because of the paragraph at the top of this block. There is
 * no migration system, so the choice is between settling the shape once, now,
 * while it costs a CREATE TABLE nobody executes twice, or discovering later
 * that alternatives and outcome needed to exist on rows that were written
 * without them. The UNIQUE(source, source_ref, class) is the part that would be
 * genuinely painful to add afterwards — it is what makes a re-ingest idempotent
 * rather than a second copy of everything.
 */
CREATE TABLE IF NOT EXISTS understudy_precedents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class TEXT NOT NULL,
  partition TEXT NOT NULL DEFAULT 'global',
  repo TEXT NOT NULL DEFAULT '',
  situation TEXT NOT NULL DEFAULT '',
  decision TEXT NOT NULL DEFAULT '',
  his_words TEXT NOT NULL DEFAULT '',
  alternatives TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  source_ref TEXT NOT NULL DEFAULT '',
  provenance TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  UNIQUE(source, source_ref, class)
);

-- External-content full-text index over the precedents, the same arrangement
-- events_fts uses. There is not one trigger anywhere in server/src and this
-- does not introduce the first: fts5 does not synchronise an external-content
-- table by itself, so whatever eventually writes understudy_precedents writes
-- the matching INSERT INTO understudy_precedents_fts(rowid, …) beside it, by
-- hand, exactly as recordEvent does for events_fts. Nothing writes either today.
CREATE VIRTUAL TABLE IF NOT EXISTS understudy_precedents_fts USING fts5(
  class, repo, situation, decision, his_words, source_ref,
  content='understudy_precedents', content_rowid='id'
);
/*
 * WHAT THE WORKSPACE SWEEP ALREADY READ, kept.
 *
 * ClickUp's API has no text search, so "which cards mention this one" means
 * downloading the cards and looking. Measured on a real workspace: three
 * hundred cards WITH their bodies take about 45 seconds, and the same question
 * asked a minute later takes 33ms because the answer is still in memory. The
 * moment the app restarts, somebody pays the 45 seconds again.
 *
 * So the sweep writes down what it saw. The next question is answered from
 * here first — in milliseconds, cold or not — and the sweep still runs behind
 * it for anything the index has not seen yet.
 *
 * The body column is the whole point: it is where a mention of another card
 * lives, and it is the field that makes the read expensive. It stays here.
 * (No backticks in this comment on purpose — the schema is a template literal
 * and one of them ends it, which is a syntax error two hundred lines away.)
 */
CREATE TABLE IF NOT EXISTS clickup_cards (
  id TEXT PRIMARY KEY,
  custom_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  list TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  updated INTEGER NOT NULL DEFAULT 0,
  /* The whole card as the panel wants it, so a hit needs no second call. */
  json TEXT NOT NULL DEFAULT '',
  seen_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_clickup_cards_seen ON clickup_cards(seen_at);

/*
 * WHAT A NOTIFICATION SAID ABOUT A CARD.
 *
 * ClickUp's API gives no history: who assigned a card, who moved it, who added
 * a follower are all invisible to it (measured — /task/{id}/history is 404 on
 * v1 and v2, and the route their own web client uses wants a browser session).
 * But their desktop notification says exactly that, in a sentence with a name
 * in it, and this machine already mirrors those.
 *
 * So the ones that can be attributed to a card are kept here and shown on that
 * card, marked as what they are: seen on this machine, not read from the API.
 * A person who wants the full record still opens ClickUp; what this fixes is
 * "it happened, I was told, and the card shows nothing".
 */
CREATE TABLE IF NOT EXISTS clickup_card_notes (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_clickup_card_notes ON clickup_card_notes(card_id, at);

/*
 * WHAT EACH AGENT SAYS IT IS DOING.
 *
 * The deputy has a screen; the agents in the terminals do not, and "suddenly
 * they are doing lots of tasks and I do not even know which" is the cost of that. Six of
 * the seven columns of such a screen can be assembled from what this app
 * already reads — tmux panes, the sessions on disk, worktrees, the transcript
 * clock. The seventh, what an agent is working ON, is the one thing only the
 * agent knows, so it writes it here.
 *
 * One row per agent, replaced rather than appended: this is a status, not a
 * log. An agent that stops writing goes stale and the screen says so instead
 * of showing a claim from an hour ago as if it were now.
 */
CREATE TABLE IF NOT EXISTS agent_status (
  name TEXT PRIMARY KEY,
  doing TEXT NOT NULL DEFAULT '',
  worktree TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  /** What it last delivered — a commit, a branch, a sentence. */
  left_behind TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL DEFAULT 0
);
`);

/* Which hooked session wrote its status, when it said. A name is what a
   person reads; the session id is what the Lantern reminder needs to know it
   can stop asking — the reminder rides a hook, and a hook carries the session,
   not the name the agent chose for itself. An ALTER after the CREATE so a
   database from before today gains it too. */
try { db.exec("ALTER TABLE agent_status ADD COLUMN session_id TEXT NOT NULL DEFAULT ''"); } catch { /* already present */ }

/*
 * Which sessions are stopped on a person, written the moment the hook says so.
 *
 * Its own table rather than a query over `events`, and the reason is measured:
 * a session the scanner owns is answered by /ingest BEFORE its hook event is
 * inserted, so its Notification never reaches `events` at all — and what the
 * scanner writes there from the transcript runs behind by minutes and carries
 * no hook-only notifications in the first place. On this machine the newest
 * `events` row for 24 of 36 hooked sessions was a `Stop` from earlier, while
 * the hooks had said "waiting for your input" since. One row per session:
 * set by a wait-shaped Notification, cleared by anything the session does
 * after it.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS session_wait (
  session_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
`);

/*
 * What a session IS to the app, when it is not a person's agent. One row so
 * far: the Lantern's own chat, which is an observer — never counted as
 * waiting on anybody, never reminded, never a status row. Persisted because
 * the mark has to survive a server restart: the chat outlives the process
 * that opened it, and an in-memory set forgot it the afternoon it was written.
 */
db.run(`
CREATE TABLE IF NOT EXISTS session_role (
  session_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  at INTEGER NOT NULL
);
`);

/*
 * The understudy's one nap: when the agent's session limit is hit, the loop
 * sleeps until the reset the CLI announced and picks the work up again. One
 * row, overwritten; cleared by writing `until = 0`, never deleted — a person
 * looking at the Work view during the nap sees when it ends and why.
 */
db.run(`
CREATE TABLE IF NOT EXISTS understudy_hold (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  until INTEGER NOT NULL DEFAULT 0,
  why TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL DEFAULT 0
);
`);

/*
 * "At 08:00 start this agent with this prompt in this checkout" — a reminder
 * whose firing is a start (agentschedule.ts). Claimed in one statement when
 * due; what happened is written back on the row. Fired and cancelled rows age
 * out with the other ninety-day records.
 */
db.run(`
CREATE TABLE IF NOT EXISTS agent_schedule (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'claude',
  prompt TEXT NOT NULL DEFAULT '',
  yolo INTEGER NOT NULL DEFAULT 0,
  due INTEGER NOT NULL,
  created INTEGER NOT NULL,
  fired_at INTEGER,
  cancelled_at INTEGER,
  result TEXT NOT NULL DEFAULT ''
);
`);

/*
 * The agents a SCRIPT started by name — the launcher half of running the
 * team's unattended worker without Herdr (agentops.ts). One row per name: the
 * checkout it runs in and the engine pane it lives in. Liveness is the pane,
 * not this row; `ended_at` is stamped the moment somebody looks and the pane is
 * gone, and a name whose pane is gone is free to be started again.
 */
db.run(`
CREATE TABLE IF NOT EXISTS named_agent (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'claude',
  cwd TEXT NOT NULL,
  pane_id TEXT NOT NULL,
  window_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
`);

/* What a run's branch pointed at when something last looked at it.
 *
 * Added after a merged branch was deleted by hand and the run that made it was
 * re-offered as unstarted work: counting commits ahead cannot tell "merged and
 * tidied" from "never began", and a sha HEAD contains can. Kept as an ALTER
 * rather than a column in the CREATE above so a database made before today
 * gains it too — and placed AFTER that statement, because an ALTER on a table
 * that does not exist yet fails silently into the catch. */
try { db.exec("ALTER TABLE understudy_work ADD COLUMN tip_sha TEXT NOT NULL DEFAULT ''"); } catch { /* already present */ }
/* The tmux pane the run's agent is in. Its NAME was the only handle on that
   window, and a name is not an identity: tmux renames a window when the
   program inside sets a title, and the moment the match failed the watchdog
   read a working agent as gone, ended its row, and the empty-worktree sweep
   deleted the directory out from under it — `ENOENT … posix_spawn 'bun'`,
   sixteen minutes into a run. A pane id survives every rename. */
try { db.exec("ALTER TABLE understudy_work ADD COLUMN pane_id TEXT NOT NULL DEFAULT ''"); } catch { /* already present */ }

/*
 * The same column, for databases made before it existed.
 *
 * Has to sit AFTER the block above rather than up with the other migrations:
 * ALTER on a table that does not exist yet fails, the failure is swallowed by
 * the catch every migration here has, and a fresh database then never gets the
 * column at all. Which is exactly what happened — the suite went red on an
 * INSERT naming a column the CREATE had just been taught about.
 */
try { db.exec("ALTER TABLE understudy_asked ADD COLUMN deliverable TEXT"); } catch { /* already present */ }
/* How many times this task has been handed out and come back unfinished. A
   task that dies with the server is put back rather than lost, and without a
   count that is an infinite loop: the same task, restarted for ever, is worse
   than a task that stops. Two goes, then it asks for help. */
try { db.exec("ALTER TABLE understudy_asked ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0"); } catch { /* already present */ }

/*
 * WHAT KIND OF HAND THIS IS, so a machine can clear one it raised itself
 * without matching on the title — the title is not free for that. A requeue's
 * give-up hand is filed under the user's OWN task title, which a title match
 * would either miss or clear by accident depending on what he happened to call
 * the task. `kind` is the fixed, code-chosen tag ("idle-cannot-start", ...)
 * that names WHY the hand was raised, independent of what it is about. NULL
 * for a hand raised before this column existed, or one only a person is ever
 * meant to close — a give-up hand is never auto-cleared, so it never needed a
 * kind that means "clear me".
 */
try { db.exec("ALTER TABLE understudy_help ADD COLUMN kind TEXT"); } catch { /* already present */ }
db.exec("CREATE INDEX IF NOT EXISTS idx_understudy_help_kind ON understudy_help(kind, answered_at)");

/*
 * `review` and `reviewed_at` USED TO BE ADDED HERE, and are not any more.
 *
 * They held a person's ruling on a disagreement — the queue that went out with
 * the predictor's apparatus. Nothing writes them and nothing reads them, and a
 * column added on every startup for a feature that no longer exists is the
 * database's version of the dead export the guard next door catches.
 *
 * NOT DROPPED, only no longer created. `ALTER TABLE … DROP COLUMN` on somebody
 * else's database destroys whatever is in it to save two nulls per row, and
 * this file has no migration system to sequence that against. Databases that
 * already carry the columns keep them, inert; new ones never grow them.
 */

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
  /** Who, when a person decided. NULL for a timeout, a restart, and for every
   *  row written before this column existed — an absent actor is not `local`. */
  decided_by: string | null;
}

const gateInsert = db.query(`
  INSERT OR REPLACE INTO gates (id, source_app, session_id, tool_name, summary, created, expires)
  VALUES ($id, $source_app, $session_id, $tool_name, $summary, $created, $expires)`);
// Only ever resolves a still-pending row: a decision already recorded wins over
// a late timeout, so a human's approve can't be overwritten by the clock.
const gateResolve = db.query(`
  UPDATE gates SET decision = $decision, reason = $reason, resolution = $resolution,
                   decided_at = $decided_at, decided_by = $decided_by
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
  /** Only ever set for a human. The clock is not an actor. */
  decided_by: string | null = null,
): void {
  gateResolve.run({
    $id: id, $decision: decision, $reason: reason, $resolution: resolution,
    $decided_at: decided_at,
    // Belt as well as braces: the callers pass null for a timeout, and so does
    // this, so an actor cannot arrive attached to an outcome nobody chose.
    $decided_by: resolution === "human" ? decided_by : null,
  } as any);
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
/**
 * The vendor behind a model name, as this tier wants it.
 *
 * The rules live in shared/models.ts, shared with the web copy — they were two
 * hand-kept transcriptions of each other, which #282 pinned with a test after
 * they drifted. The only difference that survives is the miss value: the web
 * needs a string to put in a filter option, this tier writes NULL into the
 * `provider` column, and UNKNOWN_PROVIDER below is what makes the two
 * correspond.
 */
export function providerOf(model: string | null | undefined): string | null {
  const p = sharedProviderOf(model);
  return p === UNKNOWN_MODEL ? null : p;
}

/**
 * The sentinel a client sends to scope to sessions whose provider never
 * resolved (a session that only ever carried un-modelled events). It is stored
 * as NULL, so `provider = 'unknown'` would match nothing and the rows would
 * vanish from every provider-scoped view — the sum of the per-provider numbers
 * then came out below the unfiltered total. Matches the web's providerOf(null),
 * which returns this same string, so the "Unknown" filter option round-trips.
 */
export const UNKNOWN_PROVIDER = "unknown";

/** SQL fragment + args to scope an events query to one provider, on each event's
 *  OWN provider column rather than its session's single latched one — so a
 *  session that used two providers counts under each for exactly the events it
 *  ran there. Empty when no provider is selected. The Unknown bucket selects the
 *  NULL-provider events (model never resolved) so per-provider views reconcile
 *  with the total. Every call site queries `FROM events` unaliased. */
function providerScope(provider?: string | null): { clause: string; args: string[] } {
  if (!provider) return { clause: "", args: [] };
  if (provider === UNKNOWN_PROVIDER) return { clause: " AND provider IS NULL", args: [] };
  return { clause: " AND provider = ?", args: [provider] };
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
  // isWithin rather than a hardcoded `r + "/"`: these are resolve()-derived
  // host paths, so on Windows they are backslash-joined and the literal slash
  // matched a checkout root itself but nothing inside it — the same bug fixed
  // in config.ts one layer up (#188), which would have left a scoped cockpit
  // there showing an empty dashboard for every project it was opened on.
  const inScope = recordedPaths().filter((p) => roots.some((r) => isWithin(p, r)));
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
    source_app, session_id, event_id, hook_event_type, tool_name, tool_use_id,
    agent_id, agent_type, model_name, provider, is_error, error_text, duration_ms,
    input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
    cost_usd, summary, payload, timestamp
  ) VALUES (
    $source_app, $session_id, $event_id, $hook_event_type, $tool_name, $tool_use_id,
    $agent_id, $agent_type, $model_name, $provider, $is_error, $error_text, $duration_ms,
    $input_tokens, $output_tokens, $cache_creation_tokens, $cache_read_tokens,
    $cost_usd, $summary, $payload, $timestamp
  )
  ON CONFLICT(source_app, session_id, event_id) WHERE event_id IS NOT NULL
  DO NOTHING
  RETURNING id
`);

// Find the matching PreToolUse for a Post event: by tool_use_id when present,
// otherwise the most recent unpaired Pre for the same session+tool.
/**
 * Claim a Pre, rather than merely finding one.
 *
 * UPDATE ... RETURNING marks and reads in one statement, so a Pre answers one
 * Post and no more. Without the claim, two overlapping calls to the same tool
 * both measured from the newest Pre and one of the two durations was simply
 * lost.
 */
const claimPreById = db.query<{ timestamp: number }, [string]>(
  `UPDATE events SET paired = 1
   WHERE id = (SELECT id FROM events
               WHERE hook_event_type = 'PreToolUse' AND tool_use_id = ? AND paired = 0
               ORDER BY id DESC LIMIT 1)
   RETURNING timestamp`
);
/**
 * The fallback, for sources with no usable tool_use_id — hook payloads that
 * omit it, and the OTLP-logs path, which synthesises ids that never match.
 *
 * FIFO (`ORDER BY id ASC`), not LIFO: with three calls open, the Post that
 * arrives first belongs to the Pre that opened first. Taking the newest meant
 * interleaved calls reported the shortest possible duration each time.
 *
 * Bounded below as well as above. An orphaned Post used to reach back through
 * all of history and pair with a Pre from hours ago; now it finds nothing and
 * records NULL, which the percentiles already know how to skip.
 */
const claimPreByTool = db.query<{ timestamp: number }, [string, string, number, number]>(
  `UPDATE events SET paired = 1
   WHERE id = (SELECT id FROM events
               WHERE hook_event_type = 'PreToolUse' AND session_id = ? AND tool_name = ?
                 AND paired = 0 AND timestamp <= ? AND timestamp >= ?
               ORDER BY id ASC LIMIT 1)
   RETURNING timestamp`
);

interface SessionTokenRow {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  pricing_baseline_usd: number;
  model_name: string | null;
}
const getSessionTokens = db.query<SessionTokenRow, [string]>(
  `SELECT input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
          cost_usd, pricing_baseline_usd, model_name
   FROM sessions WHERE session_id = ?`
);

const rowToEvent = db.query<any, [number]>(`SELECT * FROM events WHERE id = ?`);
const eventByExternalId = db.query<any, [string, string, string]>(
  `SELECT * FROM events WHERE source_app = ? AND session_id = ? AND event_id = ? LIMIT 1`
);
const sessionById = db.query<Record<string, unknown>, [string]>(`SELECT * FROM sessions WHERE session_id = ?`);

/**
 * The one place an `events` row becomes a `WatchEvent`, which is why the
 * weighted token figure is attached here.
 *
 * The client folds these rows into fleet cards itself and has no price table —
 * that is deliberate, and it is exactly why `AgentCard.tokens` could only ever
 * be `input + output`. Carrying the weighted figure on the event is the same
 * trick `cost_usd` already uses: the arithmetic that needs prices happens where
 * the prices are.
 */
function parseEventRow(r: any): WatchEvent {
  return {
    ...r,
    equiv_tokens: equivalentTokens(r, r.model_name),
    payload: safeJson(r.payload),
  } as WatchEvent;
}

/**
 * Every `SessionRollup` the app produces comes through here — the list, the
 * socket frame, the fleet's roll-up lookup — which is why the one comparable
 * token figure is added here rather than at three call sites that would drift.
 *
 * It is derived rather than stored. `equiv_tokens` is a pure function of the
 * four columns and the model, all of which are on the row already, so it is
 * exact for history written before the idea existed — no column, no migration,
 * and no backfill that could be interrupted halfway.
 */
function parseSessionRow(r: Record<string, unknown>): SessionRollup {
  const { pricing_baseline_usd: _internal, ...session } = r;
  const s = session as unknown as SessionRollup;
  s.equiv_tokens = equivalentTokens(s, s.model_name);
  return s;
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

const isToolPost = (t: string) => t === "PostToolUse" || t === "PostToolUseFailure";
/**
 * The events that end a *session*.
 *
 * `SubagentStop` is not one of them, though it used to be listed here. It fires
 * in the parent session every time a Task subagent finishes, which in a long run
 * is many times before anything is over. Treating it as terminal stamped an
 * `ended_at` on a session that was still working: the fleet drew it as finished
 * and its duration stopped mid-run.
 */
const isTerminal = (t: string) => t === "Stop" || t === "SessionEnd";

// ---------------------------------------------------------------------------
// Retention — keep at least a full week of history so the 7d window is always
// answerable. Prune anything older than AGENTGLASS_RETENTION_DAYS (default 8;
// 0 disables pruning entirely).
// ---------------------------------------------------------------------------
export const RETENTION_DAYS = Math.max(0, Number(process.env.AGENTGLASS_RETENTION_DAYS ?? 8));

/**
 * The understudy's own two windows — see the table block above for what is in
 * them. Fixed rather than read from the environment, and deliberately not
 * derived from RETENTION_DAYS: that variable bounds the raw events and is the
 * user's to set, including to 0, while these bound a store the user did not ask
 * for and should not have to remember to bound. Exported so a panel can say
 * "thirty days" without keeping a second copy of the number that could disagree
 * with the sweep that enforces it.
 */
export const UNDERSTUDY_SNAPSHOT_DAYS = 30;

/** How long the bare fact of a write is kept. Decision and fence rows never
 *  expire: they are the score, and a score with holes in it is not a score. */
export const UNDERSTUDY_STUB_DAYS = 90;

/**
 * Fold every event older than `cutoff` into daily_rollup.
 *
 * Runs inside the prune transaction, immediately before the DELETE, so a
 * crash between the two cannot lose a day: either both happened or neither
 * did. Accumulating rather than replacing, because a day is folded once when
 * it expires and must not be double-counted if a prune is run twice — the
 * DELETE that follows is what guarantees each event is folded exactly once.
 */
function foldExpiringEvents(cutoff: number): number {
  const r = db.run(
    `INSERT INTO daily_rollup (
       day, project_path, session_id, source_app, model_name, provider,
       events, tool_calls, tool_errors, errors,
       input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
       cost_usd, duration_ms_total, timed_calls
     )
     SELECT date(timestamp / 1000, 'unixepoch'),
            COALESCE(project_path, ''), session_id, COALESCE(source_app, ''),
            COALESCE(model_name, ''), COALESCE(provider, ''),
            COUNT(*),
            SUM(CASE WHEN hook_event_type IN ('PostToolUse','PostToolUseFailure') THEN 1 ELSE 0 END),
            SUM(CASE WHEN hook_event_type IN ('PostToolUse','PostToolUseFailure') AND is_error = 1 THEN 1 ELSE 0 END),
            SUM(is_error),
            SUM(COALESCE(input_tokens, 0)), SUM(COALESCE(output_tokens, 0)),
            SUM(COALESCE(cache_creation_tokens, 0)), SUM(COALESCE(cache_read_tokens, 0)),
            SUM(COALESCE(cost_usd, 0)),
            SUM(COALESCE(duration_ms, 0)),
            SUM(CASE WHEN duration_ms IS NOT NULL THEN 1 ELSE 0 END)
     FROM events WHERE timestamp < ?
     GROUP BY 1, 2, 3, 4, 5, 6
     ON CONFLICT(day, project_path, session_id, model_name, provider) DO UPDATE SET
       events = events + excluded.events,
       tool_calls = tool_calls + excluded.tool_calls,
       tool_errors = tool_errors + excluded.tool_errors,
       errors = errors + excluded.errors,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
       cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
       cost_usd = cost_usd + excluded.cost_usd,
       duration_ms_total = duration_ms_total + excluded.duration_ms_total,
       timed_calls = timed_calls + excluded.timed_calls`,
    [cutoff]
  );
  return r.changes;
}

/**
 * Give back the pages retention has already freed.
 *
 * Pruning deletes rows; SQLite keeps their pages on a freelist and reuses them,
 * which is the right default — a database that grows back to its high-water
 * mark every week should not pay to shrink in between. This one does not grow
 * back: measured on a real cockpit, 62,706 of 116,162 pages were free, and the
 * file was 476 MB holding 214 MB of data.
 *
 * Guarded on that ratio rather than run every boot, because VACUUM rewrites the
 * whole file. At 30% free it is worth the rewrite; below that it is churn. On
 * the machine this was written for the rewrite took 0.43 s and returned 262 MB.
 *
 * SQLITE_TMPDIR is set because VACUUM builds its copy in the temp directory,
 * and `/tmp` here is a 16 GB tmpfs that runs at 94% full — a vacuum of a large
 * database would go into RAM and could fail on space. Next to the database is
 * where there is certainly room for a copy of it.
 */
export function reclaimFreePages(): { freed: number; ms: number } | null {
  try {
    const pageCount = Number((db.query("PRAGMA page_count").get() as { page_count?: number } | null)?.page_count ?? 0);
    const freelist = Number((db.query("PRAGMA freelist_count").get() as { freelist_count?: number } | null)?.freelist_count ?? 0);
    const pageSize = Number((db.query("PRAGMA page_size").get() as { page_size?: number } | null)?.page_size ?? 0);
    if (!pageCount || !pageSize || freelist / pageCount <= 0.3) return null;
    if (!process.env.SQLITE_TMPDIR) process.env.SQLITE_TMPDIR = dirname(DB_PATH);
    const started = Date.now();
    db.exec("VACUUM");
    return { freed: freelist * pageSize, ms: Date.now() - started };
  } catch {
    // A vacuum that cannot run is not a reason to fail a boot: the database is
    // correct either way, and the only thing lost is disk that was already lost.
    return null;
  }
}

export function pruneOldRows(): { events: number; sessions: number; rolled: number; snapshots: number; stubs: number } {
  /*
   * The understudy's two sweeps run ABOVE the early return, and the placement is
   * the point rather than an accident of ordering.
   *
   * AGENTGLASS_RETENTION_DAYS is a number the user sets, and 0 is a legitimate
   * value meaning "keep the events for ever". Hanging the understudy's expiry
   * off that switch would mean somebody turning event pruning off silently
   * turned off the expiry of the sealed situations too — a store that holds the
   * material the understudy was reading, growing without bound, because of a
   * setting about something else entirely. That is the worst failure available
   * in this file, so these two are unconditional and carry their own windows.
   *
   * Outside the transaction below on purpose: they share no invariant with the
   * fold-then-delete pair, and a snapshot sweep has no business being able to
   * roll back a day of rollup.
   */
  const snapCut = Date.now() - UNDERSTUDY_SNAPSHOT_DAYS * 86_400_000;
  const snapshots = db.run(`DELETE FROM understudy_snapshots WHERE at < ?`, [snapCut]).changes;
  // Stubs only. A `decision` row is the score and a `fence` row is a refusal we
  // promised to be able to show; neither has an expiry, at any age.
  const stubCut = Date.now() - UNDERSTUDY_STUB_DAYS * 86_400_000;
  const stubs = db.run(`DELETE FROM understudy_ledger WHERE kind = 'stub' AND sealed_at < ?`, [stubCut]).changes;

  /*
   * The queue, the shifts and the acts, which arrived with the actuator and
   * arrived without an expiry.
   *
   * Every other table in this feature had a window decided when it was written.
   * These three did not, which is how a store grows without bound: not by
   * anybody deciding to keep everything, but by three tables being added on an
   * afternoon when the interesting question was whether the thing worked.
   *
   * THE WINDOWS ARE NOT THE SAME, for the same reason the two above are not.
   *
   * A RESOLVED proposal is scaffolding — it was drafted, it was pressed or
   * thrown away, and a month later nobody wants the JSON body it would have
   * sent. A pending one never expires: it is the understudy waiting on a
   * person, and expiring it would answer on their behalf by doing nothing.
   *
   * An ACT is the record of something that happened on somebody's machine
   * without them pressing anything. That is the last row in this feature that
   * should quietly disappear, so it keeps the longest window — and an act that
   * has NOT been undone is never swept at all, because the undo recipe is the
   * only way back and deleting it is deciding on their behalf that they no
   * longer want one.
   */
  const proposalCut = Date.now() - UNDERSTUDY_STUB_DAYS * 86_400_000;
  const proposals = db.run(
    `DELETE FROM understudy_proposals WHERE state <> 'pending' AND created_at < ?`,
    [proposalCut],
  ).changes;
  /*
   * THE RECORD OF WHAT RAN UNATTENDED honours the user's switch; the rest of
   * this feature does not, and the split is deliberate.
   *
   * Everything above and below this block is scaffolding the understudy made
   * for itself — sealed situations, stubs, drafted proposals, the queue's
   * bookkeeping, a role, a schedule — and it expires on its own clock precisely
   * so that a setting about EVENTS cannot make it grow without bound. That
   * reasoning was written for those tables and it is still right for them.
   *
   * Shifts, acts and runs are a different kind of row. Each one says that an
   * agent did something on this machine, at night, with permissions skipped,
   * and nobody watching. The retention switch set to 0 is the user saying "keep
   * my history for ever", and until this block existed the three tables that
   * ARE the history of the unattended work were the ones that ignored him: the
   * raw prompts he typed himself were kept, and the record of what ran in his
   * name without him was swept at ninety days. Read aloud, that is backwards.
   * So these three, and only these three, keep for ever when the switch is 0
   * and otherwise keep their ninety-day window unchanged.
   *
   * Still above the early return on RETENTION_DAYS below, because that return
   * is about the fold-then-delete transaction on events and these share
   * nothing with it — the placement tests in understudy-retention.test.ts and
   * retention-promises.test.ts pin exactly this shape (and they find the guard
   * by its source text, which is why this comment does not quote it).
   */
  const keepsTheRecord = RETENTION_DAYS === 0;
  if (!keepsTheRecord) {
    db.run(`DELETE FROM understudy_shifts WHERE state <> 'running' AND started_at < ?`, [proposalCut]);
    db.run(
      `DELETE FROM understudy_acts WHERE undone_at IS NOT NULL AND at < ?`,
      [Date.now() - UNDERSTUDY_STUB_DAYS * 86_400_000],
    );
  }
  /*
   * The work loop's two tables, and this is the SECOND time this exact gap has
   * been opened in this feature.
   *
   * The proposals, the shifts and the acts arrived without a window and were
   * given one. Then the work loop arrived with two more tables and no window,
   * by the same route: tables added on an afternoon when the interesting
   * question was whether the thing worked at all. Writing the reasoning down
   * once changed nothing, because a comment is only read by somebody already
   * looking at the file — so the rule is enumerated in a test now, which walks
   * every understudy table and fails on one nobody has decided about.
   *
   * The exceptions match the ones above, for the same reasons. A FINISHED run
   * ages out; a RUNNING one never does, because "started, never finished" is
   * the only record that an agent was killed mid-task, and it is exactly the
   * row somebody wants when they find a worktree they do not recognise. A task
   * still QUEUED never expires either: it is a person waiting to be worked
   * for, and expiring it answers on their behalf by doing nothing.
   *
   * TWO RECORDS OF THE SAME FACT, and the queue's sweep reads both — the same
   * reason the queue's own reader does. `taken_at` is this table's mark and the
   * run table is the loop's, and for a while nothing wrote the first: rows
   * worked start to finish kept a NULL there. The reader consults both, so
   * those rows correctly stop being offered as work; a sweep trusting
   * `taken_at` alone would leave exactly them immortal — invisible in the app,
   * permanent on disk, which is the shape of bug this sweep exists to close,
   * reappearing inside the fix for it.
   *
   * Which makes the ORDER of the two statements load-bearing, and that is not
   * visible from either one alone. Sweeping the runs first deletes the evidence
   * the queue's sweep needs to read. The queue goes first; both use the same
   * cutoff, so a run old enough to be swept is one the queue has finished with.
   */
  db.run(
    `DELETE FROM understudy_asked
      WHERE at < ?
        AND (taken_at IS NOT NULL
             OR ('asked:' || id) IN (SELECT item_id FROM understudy_work WHERE source = 'asked'))`,
    [Date.now() - UNDERSTUDY_STUB_DAYS * 86_400_000],
  );
  /* The run table is the third of the three that honour the switch — see the
     shifts/acts block above. The queue's sweep just above it does NOT: it reads
     the run table to know what was worked, and a kept run keeps answering that
     question for it. */
  if (!keepsTheRecord) {
    db.run(
      `DELETE FROM understudy_work WHERE state <> 'running' AND started_at < ?`,
      [Date.now() - UNDERSTUDY_STUB_DAYS * 86_400_000],
    );
  }
  /* A named agent that has ENDED is a fact about a window that no longer
     exists; ninety days is plenty to read back what ran. A live one is never
     swept — its pane is the record that it is still working. */
  db.run(
    `DELETE FROM named_agent WHERE ended_at IS NOT NULL AND ended_at < ?`,
    [Date.now() - UNDERSTUDY_STUB_DAYS * 86_400_000],
  );
  /* A role outlives its session by ninety days, then nothing needs it. */
  db.run(`DELETE FROM session_role WHERE at < ?`, [Date.now() - UNDERSTUDY_STUB_DAYS * 86_400_000]);
  /* A schedule that fired or was cancelled is a record, kept ninety days; one
     still waiting is a person's intent and is never swept. */
  db.run(`DELETE FROM agent_schedule WHERE (fired_at IS NOT NULL OR cancelled_at IS NOT NULL) AND created < ?`, [Date.now() - UNDERSTUDY_STUB_DAYS * 86_400_000]);
  /*
   * Answered questions age out; an OPEN one never does.
   *
   * Same ruling the queue above makes, and for the same reason: a row still
   * waiting on a person is a person who has not answered yet, and expiring it
   * answers on their behalf by doing nothing. That is precisely the silence
   * this table was added to end, so it may not come back in through the sweep
   * that is supposed to keep the table small.
   */
  db.run(
    `DELETE FROM understudy_help WHERE answered_at IS NOT NULL AND at < ?`,
    [Date.now() - UNDERSTUDY_STUB_DAYS * 86_400_000],
  );
  void proposals;

  if (!RETENTION_DAYS) return { events: 0, sessions: 0, rolled: 0, snapshots, stubs };
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  // One transaction: the fold and the delete are the same decision, and a
  // crash between them would delete a day nobody had summarised.
  // Dropped here as well as validated in rollupPaths(). Not redundant: this is
  // the write that matters most — a folded day is history the events table no
  // longer has — and clearing it costs nothing. The validation is what makes
  // the cache correct for every OTHER writer, which is the assumption that
  // failed. See rollupPaths().
  rollupPathCache = null;
  return db.transaction(() => {
    const rolled = foldExpiringEvents(cutoff);
    db.run(`DELETE FROM events_fts WHERE rowid IN (SELECT id FROM events WHERE timestamp < ?)`, [cutoff]);
    const ev = db.run(`DELETE FROM events WHERE timestamp < ?`, [cutoff]);
    const se = db.run(`DELETE FROM sessions WHERE last_seen < ?`, [cutoff]);
    // Resolved gates only — a pending one is a live request, never retention's
    // business no matter how old its row looks.
    db.run(`DELETE FROM gates WHERE decision IS NOT NULL AND created < ?`, [cutoff]);
    // Acknowledged reminders age out; a live one is never retention's business
    // however old its row looks — the same ruling the gates line above makes.
    db.run(`DELETE FROM reminders WHERE (acked_at IS NOT NULL OR cancelled_at IS NOT NULL) AND due < ?`, [cutoff]);
    return { events: ev.changes, sessions: se.changes, rolled, snapshots, stubs };
  })();
}

/**
 * Every project path the rollup itself contains.
 *
 * Deliberately not recordedPaths(): that reads the events table, and the whole
 * point of the rollup is that those rows are gone. A project last touched a
 * month ago has no path left in events at all, so scoping rollup queries by
 * what events still remembers would hide precisely the history the rollup was
 * built to keep — the further back you look, the more of it disappears.
 *
 * ── why this is not simply cached, and what that cost ───────────────────
 * It used to be `if (cache) return cache`, dropped in the prune, on the stated
 * ground that the prune is the only writer. That was true of the product and
 * false as an invariant, and the difference was silent: ANY other write to
 * daily_rollup left the cache holding a list from before it, and a project
 * missing from that list has its whole folded history filtered out of the
 * chart — not wrong by a row, absent. The days that vanish are exactly the ones
 * the rollup exists for: the old ones, whose events are gone, so nothing else
 * can put them back.
 *
 * It surfaced under `bun test`, which shares one process across suites. A suite
 * that read the rollup while it was empty warmed the cache for every suite
 * after it, and a suite that then wrote its own rows directly — a fixture, not
 * a prune — was invisible to its own scope. Green for months, then red on an
 * unchanged commit when the runner's file order changed. The assumption was
 * load-bearing and undocumented at the call sites that broke it.
 *
 * So the cache is validated instead of trusted. COUNT(*) with MAX(rowid) is one
 * indexed read and catches inserts, deletes, and a delete-plus-insert that
 * leaves the count alone — which the count on its own does not.
 */
let rollupPathCache: { stamp: string; paths: string[] } | null = null;
function rollupPaths(): string[] {
  const row = db
    .query<{ n: number; hi: number | null }, []>("SELECT COUNT(*) AS n, MAX(rowid) AS hi FROM daily_rollup")
    .get();
  const stamp = `${row?.n ?? 0}:${row?.hi ?? 0}`;
  if (rollupPathCache && rollupPathCache.stamp === stamp) return rollupPathCache.paths;
  const rows = db.query<{ p: string }, []>("SELECT DISTINCT project_path AS p FROM daily_rollup").all();
  rollupPathCache = { stamp, paths: rows.map((r) => r.p).filter(Boolean) };
  return rollupPathCache.paths;
}

/**
 * Scope fragment for a `daily_rollup` query — the counterpart of scopeClause().
 *
 * Two differences from the events version, both forced by what the fold keeps.
 * It tests `isWithin` rather than equality against the scope roots, because
 * `project_path` is the path the event carried and that is often a directory
 * *inside* a checkout (a monorepo package) — an exact IN against the roots
 * matched none of those and reported a scoped project as having no history.
 * And there is no `cwd_path` to fall back on: the fold does not carry one, so
 * a row whose only in-scope path was the cwd cannot be recovered here.
 */
function rollupScopeClause(scope: string | null = workspaceRoot()): { clause: string; args: string[] } {
  if (!scope) return { clause: "", args: [] };
  const roots = scopeRoots(scope);
  const inScope = rollupPaths().filter((p) => roots.some((r) => isWithin(p, r)));
  // Same honest answer as scopeClause: nothing folded for this project yet.
  if (!inScope.length) return { clause: " AND 0", args: [] };
  return { clause: ` AND project_path IN (${inScope.map(() => "?").join(",")})`, args: inScope };
}

/** The per-day aggregate shared by rollupDays() and dailyUsage(), so the two
 *  cannot drift into answering the same question differently. */
const DAY_TOTALS = `SELECT day,
        SUM(events) AS events, SUM(tool_calls) AS tool_calls,
        SUM(tool_errors) AS tool_errors, SUM(errors) AS errors,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cost_usd) AS cost_usd,
        COUNT(DISTINCT session_id) AS sessions,
        CASE WHEN SUM(timed_calls) > 0
             THEN CAST(SUM(duration_ms_total) / SUM(timed_calls) AS INTEGER)
             ELSE 0 END AS avg_ms`;

/**
 * Daily totals from the rollup alone, scoped like every other metric.
 *
 * This reads only what the prune has already folded, so it answers about the
 * past and stops at the retention boundary. Callers wanting a series that runs
 * up to now want dailyUsage() instead — it is this plus the live events.
 */
export function rollupDays(fromDay?: string, toDay?: string): UsageDay[] {
  const scope = rollupScopeClause();
  const where: string[] = [];
  const args: any[] = [];
  if (fromDay) { where.push("day >= ?"); args.push(fromDay); }
  if (toDay) { where.push("day <= ?"); args.push(toDay); }
  const clause = ` WHERE 1${where.length ? ` AND ${where.join(" AND ")}` : ""}${scope.clause}`;
  return db
    .query<UsageDay, any[]>(`${DAY_TOTALS} FROM daily_rollup${clause} GROUP BY day ORDER BY day`)
    .all(...args, ...scope.args);
}

/**
 * One continuous daily series, across the retention boundary.
 *
 * The rollup holds the days the prune has folded; `events` holds the days it
 * has not. Neither alone can answer "what did this project cost this month" on
 * a default install — retention is 8 days, so a 30d window read from events is
 * eight days of data wearing a thirty-day label.
 *
 * The two sources are summed, not preferred, because the boundary is a
 * *timestamp*, not a midnight: the prune folds `timestamp < now - N days`, so
 * the day the cutoff lands in is split between the tables and is only whole
 * when both halves are added. Every other day is in exactly one of them, where
 * adding is the identity.
 *
 * Sessions are the one column that cannot be summed — a session that ran
 * across the cutoff has a row on both sides — so the union is counted distinct
 * over (day, session_id) instead of adding two counts that both include it.
 *
 * Days are UTC, matching what the fold wrote. The heatmap is the panel that
 * needs a viewer's local clock; a day-grained cost series does not, and
 * shifting it would put spend on a different day than the rollup recorded it.
 */
export function dailyUsage(fromDay?: string, toDay?: string): UsageDay[] {
  const rs = rollupScopeClause();
  const es = scopeClause();
  const rWhere: string[] = [];
  const rArgs: any[] = [];
  const eWhere: string[] = [];
  const eArgs: any[] = [];
  if (fromDay) {
    rWhere.push("day >= ?"); rArgs.push(fromDay);
    // Bounded on `timestamp` rather than on date(timestamp), so the events half
    // can use the timestamp index instead of computing a date per row. With
    // retention disabled this table holds everything, and "all time" is exactly
    // when that matters.
    eWhere.push("timestamp >= CAST(strftime('%s', ?) AS INTEGER) * 1000"); eArgs.push(fromDay);
  }
  if (toDay) {
    rWhere.push("day <= ?"); rArgs.push(toDay);
    eWhere.push("timestamp < (CAST(strftime('%s', ?) AS INTEGER) + 86400) * 1000"); eArgs.push(toDay);
  }
  const rc = ` WHERE 1${rWhere.length ? ` AND ${rWhere.join(" AND ")}` : ""}${rs.clause}`;
  const ec = ` WHERE 1${eWhere.length ? ` AND ${eWhere.join(" AND ")}` : ""}${es.clause}`;
  return db
    .query<UsageDay, any[]>(
      `WITH merged AS (
         SELECT day, session_id, events, tool_calls, tool_errors, errors,
                input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
                cost_usd, duration_ms_total, timed_calls
         FROM daily_rollup${rc}
         UNION ALL
         -- Folded the same way foldExpiringEvents() folds, down to the date
         -- expression: a day that is half here and half in the rollup has to
         -- land on the same key in both halves or it splits into two days.
         SELECT date(timestamp / 1000, 'unixepoch') AS day, session_id,
                COUNT(*),
                SUM(CASE WHEN hook_event_type IN ('PostToolUse','PostToolUseFailure') THEN 1 ELSE 0 END),
                SUM(CASE WHEN hook_event_type IN ('PostToolUse','PostToolUseFailure') AND is_error = 1 THEN 1 ELSE 0 END),
                SUM(COALESCE(is_error, 0)),
                SUM(COALESCE(input_tokens, 0)), SUM(COALESCE(output_tokens, 0)),
                SUM(COALESCE(cache_creation_tokens, 0)), SUM(COALESCE(cache_read_tokens, 0)),
                SUM(COALESCE(cost_usd, 0)),
                SUM(COALESCE(duration_ms, 0)),
                SUM(CASE WHEN duration_ms IS NOT NULL THEN 1 ELSE 0 END)
         FROM events${ec}
         GROUP BY 1, 2
       )
       ${DAY_TOTALS} FROM merged GROUP BY day ORDER BY day`
    )
    .all(...rArgs, ...rs.args, ...eArgs, ...es.args);
}

/**
 * What was spent, over a window, by one project and optionally one model.
 *
 * The same seam dailyUsage() crosses, asked a narrower question. Two things
 * make it a separate function rather than a filter on that one.
 *
 * The scope is *given*, not ambient. Every other metric here answers about the
 * project the cockpit is currently looking at; a budget answers about the
 * project it was set for, whatever is on screen. So the scope clauses are
 * passed a root rather than left to read `workspaceRoot()`.
 *
 * And cost is the one column that simply adds. dailyUsage has to count sessions
 * distinctly because a session running across the cutoff has a row on both
 * sides — cost does not: the prune folds `timestamp < cutoff`, so every dollar
 * is on exactly one side of it and summing both is the whole answer. That is
 * what makes this query short enough to be obviously right, which for the
 * number a budget fires on is worth more than sharing code.
 *
 * Days are UTC, matching what the fold wrote, and `toDay` is inclusive.
 */
export function spendBetween(opts: {
  fromDay: string;
  toDay: string;
  /** Project root, or null for the whole machine. */
  root?: string | null;
  /** Exact model name, or null for all of them. */
  model?: string | null;
}): number {
  const root = opts.root || null;
  const rs = rollupScopeClause(root);
  const es = scopeClause(root);
  const rModel = opts.model ? " AND model_name = ?" : "";
  const eModel = opts.model ? " AND model_name = ?" : "";
  const mArgs = opts.model ? [opts.model] : [];
  const r = db
    .query<{ cost: number | null }, any[]>(
      `SELECT
         (SELECT COALESCE(SUM(cost_usd), 0) FROM daily_rollup
           WHERE day >= ? AND day <= ?${rModel}${rs.clause})
       + (SELECT COALESCE(SUM(cost_usd), 0) FROM events
           WHERE timestamp >= CAST(strftime('%s', ?) AS INTEGER) * 1000
             AND timestamp < (CAST(strftime('%s', ?) AS INTEGER) + 86400) * 1000${eModel}${es.clause})
         AS cost`
    )
    .get(opts.fromDay, opts.toDay, ...mArgs, ...rs.args,
         opts.fromDay, opts.toDay, ...mArgs, ...es.args);
  return r?.cost ?? 0;
}

/** Every model that has cost anything, newest activity first — so a budget can
 *  be attached to one by picking rather than by typing its exact id. */
export function costedModels(): string[] {
  const rows = db
    .query<{ m: string }, []>(
      `SELECT model_name AS m FROM events WHERE model_name IS NOT NULL AND cost_usd > 0
       UNION SELECT model_name AS m FROM daily_rollup WHERE cost_usd > 0
       ORDER BY m`
    )
    .all();
  return rows.map((r) => r.m).filter(Boolean);
}

/** The oldest day the rollup can speak to, or null when it is empty. Lets a
 *  panel state the real range instead of implying it has everything. */
export function rollupEarliestDay(): string | null {
  const r = db.query<{ day: string | null }, []>('SELECT MIN(day) AS day FROM daily_rollup').get();
  return r?.day ?? null;
}

/**
 * The UTC day the retention boundary currently falls in, or null when nothing
 * is pruned. Days before it are day-grained summaries; the boundary day itself
 * and everything after are still whole events — which is worth saying on a
 * chart, because it is the difference between "no spend" and "no longer known
 * in that detail".
 */
export function retentionSeamDay(): string | null {
  if (!RETENTION_DAYS) return null;
  return new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
}

export interface InsertResult {
  event: WatchEvent;
  session: SessionRollup;
  inserted: boolean;
}

function duplicateResult(row: any): InsertResult {
  const event = parseEventRow(row);
  const sessionRow = sessionById.get(event.session_id);
  if (!sessionRow) throw new Error(`event ${event.id} exists without session ${event.session_id}`);
  return { event, session: parseSessionRow(sessionRow), inserted: false };
}

/**
 * Insert a normalized event, computing:
 *  - per-event token DELTA (from cumulative transcript usage) + cost
 *  - PostToolUse latency via pre→post pairing
 *  - the updated session rollup (authoritative token/cost totals)
 */
/** A side-channel notified of every event as it lands, live or backfilled, so a
 *  consumer can keep a derived view (the latest event per session, for the
 *  tab-strip "agent finished" dot) without importing this module's internals or
 *  re-querying on a hot path. Set once at startup; a missing hook is not called.
 *  A hook rather than a direct import so db.ts stays a leaf — the consumer reads
 *  pane_agent, which reads db, and importing it here would close a cycle. */
let eventHook: ((sessionId: string, type: string, ts: number) => void) | null = null;
export function setEventHook(fn: (sessionId: string, type: string, ts: number) => void): void { eventHook = fn; }

export function insertEvent(n: NormalizedEvent): InsertResult {
  const model = n.model_name;
  // Every event, before any dedup/rollup below: the derived view keeps by max
  // timestamp, so replaying a duplicate or an out-of-order backfill is harmless.
  eventHook?.(n.session_id, n.hook_event_type, n.timestamp);

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
  // Track what local pricing has already accounted for separately from what
  // the provider actually charged. Otherwise one exact reported cost changes
  // the baseline used by the next cumulative transcript and corrupts its delta.
  const estimatedEventCost =
    n.usage_is_cumulative && n.cost_cumulative != null
      ? Math.max(0, n.cost_cumulative - (prior?.pricing_baseline_usd ?? 0))
      : costUsd(
          { input_tokens: dIn, output_tokens: dOut, cache_creation_tokens: dCw, cache_read_tokens: dCr },
          model
        );
  const eventCost = n.reported_cost_usd ?? estimatedEventCost;

  // --- latency pairing ----------------------------------------------------
  let duration_ms: number | null = null;
  if (isToolPost(n.hook_event_type)) {
    let pre: { timestamp: number } | null = null;
    if (n.tool_use_id) pre = claimPreById.get(n.tool_use_id) ?? null;
    if (!pre && n.tool_name) {
      // Same ceiling the open-tool card uses to call a call lost.
      pre = claimPreByTool.get(n.session_id, n.tool_name, n.timestamp, n.timestamp - OPEN_TOOL_MAX_MS) ?? null;
    }
    if (pre) duration_ms = Math.max(0, n.timestamp - pre.timestamp);
  }

  const write = (): InsertResult => {
    const inserted = insertStmt.get({
      $source_app: n.source_app,
      $session_id: n.session_id,
      $event_id: n.event_id,
      $hook_event_type: n.hook_event_type,
      $tool_name: n.tool_name,
      $tool_use_id: n.tool_use_id,
      $agent_id: n.agent_id,
      $agent_type: n.agent_type,
      $model_name: model,
      $provider: providerOf(model),
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
    }) as { id: number } | null;

    if (!inserted) {
      const existing = n.event_id
        ? eventByExternalId.get(n.source_app, n.session_id, n.event_id)
        : null;
      if (!existing) throw new Error("event insert returned no row");
      return duplicateResult(existing);
    }

    const event = parseEventRow(rowToEvent.get(inserted.id));
    try { ftsInsert.run({ $id: inserted.id, $text: ftsText({ ...n, payload: n.payload }) }); } catch { /* fts best-effort */ }
    const session = upsertSession(n, dIn, dOut, dCw, dCr, eventCost, estimatedEventCost);
    return { event, session, inserted: true };
  };

  // One transaction on every path, not only the retry-key one.
  //
  // The Pre claim above is a write, and it has to commit or roll back with the
  // row it is measuring — otherwise two concurrent Posts can each claim a Pre
  // and then one of the inserts fails, leaving a Pre marked answered by an
  // event that does not exist. It also has to be in the *same* transaction as
  // the claim, which is why the claim is not lifted out of insertEvent.
  const result = db.transaction(write)();
  if (!result.inserted) return result;
  const { event } = result;

  // A path nobody has recorded before means the scope set is stale — a new
  // worktree must appear in a scoped dashboard on its first event, not on the
  // first event after a cache expiry. This stays after the successful insert so
  // an idempotent retry has no cache side effects.
  notePath(n.payload?.project_path);
  notePath((n.payload as { cwd?: unknown } | undefined)?.cwd);
  // Same rule, same place, for the filter dropdowns: three Set lookups per
  // event, and the memo behind them is dropped only when this event carries a
  // value those lists do not have. See getFilterOptions.
  noteFilterValues(n.source_app, n.hook_event_type, n.model_name);
  // A Pre opens a call and a Post closes one, so the open-tool memo the fleet
  // draws from just went stale. Drop it here, the single write chokepoint, so
  // the next read — the push that fires right after this returns — is fresh,
  // while an idle machine with no tool traffic never invalidates and so never
  // re-runs that scoped scan on the tick.
  if (n.hook_event_type === "PreToolUse" || isToolPost(n.hook_event_type)) invalidateOpenTools();
  return result;
}

const upsertStmt = db.query(`
  INSERT INTO sessions (
    session_id, source_app, model_name, provider, project_path, cwd_path, started_at, ended_at, last_seen,
    event_count, tool_count, error_count,
    input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
    cost_usd, pricing_baseline_usd
  ) VALUES (
    $sid, $src, $model, $provider, $project, $cwd, $ts, $ended, $ts,
    1, $tool, $err,
    $in, $out, $cw, $cr, $cost, $estimated
  )
  ON CONFLICT(session_id) DO UPDATE SET
    source_app = excluded.source_app,
    model_name = COALESCE(excluded.model_name, sessions.model_name),
    provider = COALESCE(excluded.provider, sessions.provider),
    project_path = COALESCE(excluded.project_path, sessions.project_path),
    cwd_path = COALESCE(excluded.cwd_path, sessions.cwd_path),
    -- An end can be taken back. A session that speaks after the moment it was
    -- said to have ended plainly did not end there: claude --resume picks a
    -- session back up, and a Stop is followed by more turns. COALESCE alone
    -- latched the first end for ever, so a resumed session stayed dead on the
    -- board. An event older than the recorded end is a late-arriving hook
    -- rather than new work, and leaves it standing.
    ended_at = CASE
      WHEN excluded.ended_at IS NOT NULL THEN excluded.ended_at
      WHEN sessions.ended_at IS NOT NULL AND excluded.last_seen > sessions.ended_at THEN NULL
      ELSE sessions.ended_at
    END,
    last_seen = excluded.last_seen,
    event_count = sessions.event_count + 1,
    tool_count = sessions.tool_count + $tool,
    error_count = sessions.error_count + $err,
    input_tokens = sessions.input_tokens + $in,
    output_tokens = sessions.output_tokens + $out,
    cache_creation_tokens = sessions.cache_creation_tokens + $cw,
    cache_read_tokens = sessions.cache_read_tokens + $cr,
    cost_usd = sessions.cost_usd + $cost,
    pricing_baseline_usd = sessions.pricing_baseline_usd + $estimated
  RETURNING *
`);

function upsertSession(
  n: NormalizedEvent,
  dIn: number,
  dOut: number,
  dCw: number,
  dCr: number,
  cost: number,
  estimatedCost: number
): SessionRollup {
  // cost is the event's cost computed once in insertEvent (transcript-priced for
  // the cumulative path); the session total must add exactly that, not a second,
  // differently-computed number, or the rollup drifts from the event rows.
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
    $estimated: estimatedCost,
  }) as Record<string, unknown>;
  return parseSessionRow(row);
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
  // Unscoped there is nothing to filter, so the index is walked in the order
  // the answer wants and SQLite stops at LIMIT — nothing to improve.
  if (!scope.clause && !prov.clause) return recentStmt.all(limit).map(parseEventRow).reverse();
  /*
   * Ids first, then the rows.
   *
   * `SELECT *` with a filter the index cannot serve makes SQLite sort the whole
   * matching set before it can know which 300 rows are the newest — and every
   * row it drags through that sort carries its payload, which for this table is
   * the prompt, the file contents and the command output. Measured on a real
   * 476 MB cockpit database scoped to one project: 31,090 rows through a temp
   * B-tree, 204 ms of a FULLY BLOCKED event loop, for 300 rows of answer.
   *
   * Sorting ids and fetching by primary key afterwards gives the identical
   * list — asserted id-for-id in the test, and in the measurement — for 13 ms.
   *
   * That loop is the one the PTY pump and every HTTP handler ride, and this
   * runs on every `/stream` connect: a visibility change, coming back online, a
   * server restart, or the 30-second pong deadline. It is the terminal that
   * stops echoing while it happens.
   */
  const ids = db
    .query<{ id: number }, any[]>(
      `SELECT id FROM events WHERE 1=1${prov.clause}${scope.clause} ORDER BY timestamp DESC, id DESC LIMIT ?`
    )
    .all(...prov.args, ...scope.args, limit)
    .map((r) => r.id);
  if (!ids.length) return [];
  // The outer ORDER BY stays: `IN` says nothing about order, and this list has
  // to come back newest-first before it is reversed for the client.
  return db
    .query<any, any[]>(
      `SELECT * FROM events WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY timestamp DESC, id DESC`
    )
    .all(...ids)
    .map(parseEventRow)
    .reverse();
}

/**
 * Bound the big strings inside a payload before it goes out on the wire.
 *
 * Measured on the `/stream` initial frame (300 events): 542 KB total, 374 KB
 * (69%) of it `payload`, and ten events — full file writes, long command
 * output — accounted for 150 KB of that on their own. The feed only ever reads
 * a handful of short fields back out of a payload (labels.ts, derive.ts): a
 * command, a path, a query, a message. Nothing on first paint reads the full
 * body of a 30 KB file write; a chat pane resuming mid-turn (chatStore.ts,
 * applyLiveEvent) does read a tool's real output, but for exactly the same
 * reason a human reading it would want a preview, not a wall of text — the
 * fold UI already collapses anything this long. Capped, not dropped: unlike
 * the fields the client never reads, this one occasionally is.
 */
const PAYLOAD_STRING_CAP = 4000;
export function capPayloadStrings<T>(value: T, max = PAYLOAD_STRING_CAP): T {
  if (typeof value === "string") {
    return (value.length > max ? `${value.slice(0, max)}…[+${value.length - max} chars]` : value) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => capPayloadStrings(v, max)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = capPayloadStrings(v, max);
    return out as T;
  }
  return value;
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
      -- "Has this call been closed by a Post?" — split into two NOT EXISTS
      -- rather than one with an OR inside. The OR mixed q.tool_use_id with
      -- q.session_id/tool_name, and SQLite cannot use an index across it: the
      -- subquery fell back to scanning EVERY PostToolUse for each open Pre
      -- (306 Pres x thousands of Posts = ~2.5s on a real DB, on the thread the
      -- terminal rides). Split, the id path uses idx on tool_use_id (the case
      -- for essentially every modern event) and the query drops to ~1ms.
      -- Equivalent by De Morgan: the two branches are mutually exclusive
      -- (tool_use_id present XOR absent), and a NULL id never equals any q's id,
      -- so the first clause is a no-op exactly when the second one applies.
      AND NOT EXISTS (
        SELECT 1 FROM events q
         WHERE q.hook_event_type IN ('PostToolUse','PostToolUseFailure')
           AND q.tool_use_id = p.tool_use_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM events q2
         WHERE p.tool_use_id IS NULL
           AND q2.hook_event_type IN ('PostToolUse','PostToolUseFailure')
           AND q2.session_id = p.session_id
           AND q2.tool_name = p.tool_name
           AND q2.timestamp >= p.timestamp
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
/*
 * The dropdowns only change when a value nobody has seen before arrives.
 *
 * This was a 30-second memo, so an idle machine recomputed three scoped
 * SELECT DISTINCTs about once every forty seconds for ever, to produce the list
 * it produced last time. The pattern that fits is the one `notePath` already
 * uses two hundred lines up: hold what has been seen, test the event at the
 * single write chokepoint, and drop the memo only on a miss — "so an idle
 * machine with no tool traffic never invalidates".
 *
 * It is also better behaviour, not merely cheaper. A new agent or a new model
 * appears in the dropdown on its FIRST event instead of up to thirty seconds
 * later, which is the same argument `notePath` makes for a new worktree.
 *
 * The long TTL stays as the net for the one case a write cannot signal:
 * retention pruning deleting the last event that carried a value, which is a
 * DELETE, not an insert. Ten minutes of a dropdown offering a value whose rows
 * have just aged out is a filter that finds nothing, not a wrong answer.
 */
const FILTER_TTL_MS = 10 * 60_000;
let filterCache: { at: number; scope: string | null; data: ReturnType<typeof computeFilterOptions> } | null = null;
/** The values the memo was built from, so an event can be tested against them
 *  without a query. Rebuilt with the memo; null while there is none. */
let filterSeen: { apps: Set<string>; types: Set<string>; models: Set<string> } | null = null;

/** One ingested event, against the lists the dropdowns are showing. A value
 *  that is not in them makes the memo stale — and nothing else does. */
function noteFilterValues(app: unknown, type: unknown, model: unknown): void {
  if (!filterSeen) return;
  const missing =
    (typeof app === "string" && app && !filterSeen.apps.has(app)) ||
    (typeof type === "string" && type && !filterSeen.types.has(type)) ||
    (typeof model === "string" && model && !filterSeen.models.has(model));
  if (missing) { filterCache = null; filterSeen = null; }
}

export function getFilterOptions() {
  const scope = workspaceRoot();
  if (filterCache && filterCache.scope === scope && Date.now() - filterCache.at < FILTER_TTL_MS) return filterCache.data;
  const data = computeFilterOptions();
  filterCache = { at: Date.now(), scope, data };
  filterSeen = {
    apps: new Set(data.source_apps),
    types: new Set(data.hook_event_types),
    models: new Set(data.models),
  };
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

/**
 * What each of these sessions was first asked to do.
 *
 * Most sessions have no name. `custom_title` is a rename by hand and `ai_title`
 * is one the agent generated, and both come from lines Claude Code writes into
 * the transcript — a session that never got one shows its own uuid forever,
 * which is why a real machine's list reads `agentglass:cd3fa401` thirty times
 * over and cannot be scanned by eye at all.
 *
 * The first thing you typed is a better name than a uuid and it has been in the
 * database the whole time: every prompt is already ingested as a
 * `UserPromptSubmit` event. So this is a query rather than a new column, an
 * ingest change or a backfill — and it names sessions recorded long before the
 * idea existed.
 *
 * One statement for the whole page rather than one per row. SQLite's
 * bare-column rule makes `payload` come from the row that produced `MIN(...)`,
 * which is exactly the first prompt.
 */
function firstPrompts(ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const holes = ids.map(() => "?").join(",");
  for (const r of db.query<{ session_id: string; payload: string }, string[]>(
    `SELECT session_id, payload, MIN(timestamp) FROM events
     WHERE hook_event_type = 'UserPromptSubmit' AND session_id IN (${holes})
     GROUP BY session_id`).all(...ids)) {
    try {
      const p = JSON.parse(r.payload)?.prompt;
      if (typeof p === "string" && p.trim()) out.set(r.session_id, p);
    } catch { /* a payload we cannot read is not a name */ }
  }
  return out;
}

/**
 * A short name for each of these sessions, by the same rule `getSessions`
 * already draws its own list by: a rename, then the title Claude Code
 * generated, then the first thing typed.
 *
 * Written for the Lantern, whose "seen" rows had nothing to call
 * themselves but their own tmux pane id — `%32` — because a hook only carries
 * a `sessionId`, and nobody had gone and asked what that session was
 * actually named. The name was sitting in this same table the whole time,
 * same as `firstPrompts` above: every session already has one, or the prompt
 * that started it. "what the hell are they, what do they do" was the question a bare pane
 * number cannot answer and this table already could.
 *
 * A handful of ids at a time — the panes a board is drawing right now — never
 * the whole table, which is what `getSessions`'s own paging is for.
 */
export function sessionNames(ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const holes = ids.map(() => "?").join(",");
  const nameless: string[] = [];
  for (const r of db.query<{ session_id: string; custom_title: string | null; ai_title: string | null }, string[]>(
    `SELECT session_id, custom_title, ai_title FROM sessions WHERE session_id IN (${holes})`,
  ).all(...ids)) {
    const t = (r.custom_title || r.ai_title || "").trim();
    if (t) out.set(r.session_id, t);
    else nameless.push(r.session_id);
  }
  if (nameless.length) {
    for (const [id, p] of firstDecentPrompts(nameless)) out.set(id, p);
  }
  return out;
}

/**
 * Whether a prompt could name a session to a person.
 *
 * Measured on the Lantern the first time it drew real names: three of eighteen
 * rows read `<cross-session-message from="uds:/run/user/…"` (a message another
 * session sent), one read `/model` (a slash command), and one `Where did you
 * leave off?` — a question, but at least a human one. The first two are not what
 * anybody typed to start work; they are what happened to arrive first.
 */
function decentPrompt(p: string): boolean {
  const t = p.trim();
  if (!t || t.length < 3) return false;
  if (t.startsWith("<") || t.startsWith("/") || t.startsWith("!")) return false;
  if (/^(y|yes|no|ok|si|sí|vale|dale)\b/i.test(t) && t.length < 12) return false;
  return true;
}

/**
 * The first prompt a person could recognise the session by, per session.
 *
 * `firstPrompts` above takes the earliest prompt and is what the sessions page
 * shows; this walks the first few and skips the ones that are not a name.
 * Trimmed to one line of the width a row has.
 */
function firstDecentPrompts(ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const holes = ids.map(() => "?").join(",");
  const seen = new Map<string, number>();
  for (const r of db.query<{ session_id: string; payload: string }, string[]>(
    `SELECT session_id, payload FROM events
     WHERE hook_event_type = 'UserPromptSubmit' AND session_id IN (${holes})
     ORDER BY timestamp ASC, id ASC`).all(...ids)) {
    if (out.has(r.session_id)) continue;
    const n = (seen.get(r.session_id) ?? 0) + 1;
    seen.set(r.session_id, n);
    if (n > 6) continue; // six prompts in and still nothing to call it: the pane id will do
    let p = "";
    try { p = String(JSON.parse(r.payload)?.prompt ?? ""); } catch { continue; }
    if (!decentPrompt(p)) continue;
    out.set(r.session_id, p.replace(/\s+/g, " ").trim().slice(0, 80));
  }
  return out;
}

/** Why a session is stopped on a person, as the Lantern draws it. */
export interface SessionWait {
  kind: "permission" | "input";
  /** The notification's own words, trimmed to a line. */
  why: string;
  since: number;
}

/**
 * What a hook event says about whether its session is waiting on a person.
 *
 * Lantern reads this off the pane text — "your approval", "may I merge",
 * "waiting on you" — with a regex. This app has the fact itself: Claude Code
 * fires a `Notification` hook when it stops for a person. The same words
 * alerts.ts already grades — measured over a week there: "needs your
 * permission" / "approval" are the blockages, "waiting for your input" is a
 * turn that ended and is waiting to be told what next. Both are somebody's
 * to answer; the board tells them apart.
 *
 * Anything the session does AFTER — a tool call, a prompt, a stop — is the
 * end of the wait, whatever it said. A notification that is merely news
 * ("usage limit reset") changes nothing either way.
 */
const roleUpsert = db.query<never, [string, string, number]>(`INSERT INTO session_role (session_id, role, at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET role = excluded.role, at = excluded.at`);
const roleAll = db.query<{ session_id: string; role: string }, []>(`SELECT session_id, role FROM session_role`);
export function setSessionRole(sessionId: string, role: string, at = Date.now()): void { if (sessionId) roleUpsert.run(sessionId, role, at); }
export function sessionRoles(): Map<string, string> { return new Map(roleAll.all().map((r) => [r.session_id, r.role])); }
/** Sessions whose first prompt carries a marker — how the Lantern's chats
 *  from before the role existed are found, once, at boot. */
export function sessionsWhosePromptStarts(mark: string): string[] {
  const out = new Set<string>();
  for (const r of db.query<{ session_id: string }, [string]>(
    `SELECT DISTINCT session_id FROM events WHERE hook_event_type = 'UserPromptSubmit' AND payload LIKE ?`).all(`%${mark}%`)) out.add(r.session_id);
  return [...out];
}

export function noteWaitFromHook(e: { session_id?: unknown; hook_event_type?: unknown; payload?: unknown; role?: unknown }, at = Date.now()): void {
  /* The Lantern's own chat never waits on anybody in the board's sense: a
     person asked it something and it answered. Its notifications are dropped
     here, and any wait it once recorded is cleared. */
  if (e.role === "lantern") {
    if (typeof e.session_id === "string" && e.session_id) db.run(`DELETE FROM session_wait WHERE session_id = ?`, [e.session_id]);
    return;
  }
  const session = typeof e.session_id === "string" ? e.session_id : "";
  if (!session || session === "unknown") return;
  if (e.hook_event_type === "Notification") {
    const msg = String((e.payload as { message?: unknown } | undefined)?.message ?? "");
    const kind = /needs your (permission|approval)/i.test(msg) ? "permission"
      : /waiting for your input/i.test(msg) ? "input"
        : null;
    if (!kind) return;
    try {
      db.query("INSERT OR REPLACE INTO session_wait (session_id, kind, why, at) VALUES (?, ?, ?, ?)")
        .run(session, kind, msg.replace(/\s+/g, " ").trim().slice(0, 160), at);
    } catch { /* the board says a little less; the event still lands */ }
    return;
  }
  try { db.query("DELETE FROM session_wait WHERE session_id = ?").run(session); } catch { /* same */ }
}

/** Which of these sessions are stopped on a person right now, and why. */
export function latestWaits(ids: string[]): Map<string, SessionWait> {
  const out = new Map<string, SessionWait>();
  if (!ids.length) return out;
  const holes = ids.map(() => "?").join(",");
  try {
    for (const r of db.query<{ session_id: string; kind: string; why: string; at: number }, string[]>(
      `SELECT session_id, kind, why, at FROM session_wait WHERE session_id IN (${holes})`).all(...ids)) {
      if (r.kind !== "permission" && r.kind !== "input") continue;
      out.set(r.session_id, { kind: r.kind, why: r.why, since: r.at });
    }
  } catch { /* a database that cannot answer is not a reason to lose the board */ }
  return out;
}

export function getSessions(limit = 100, provider?: string): SessionRollup[] {
  const key = `${limit}|${provider ?? ""}|${workspaceRoot() ?? ""}`;
  const hit = sessionsCache.get(key);
  if (hit && Date.now() - hit.at < SESSIONS_TTL_MS) return hit.data;
  const s = sessionScopeClause();
  // A session belongs to a provider when it ran ANY event there, not by its one
  // latched sessions.provider — so a multi-provider session appears under each
  // provider it used instead of only the first one seen.
  const prov = !provider
    ? { clause: "", args: [] as string[] }
    : provider === UNKNOWN_PROVIDER
      ? { clause: " AND session_id IN (SELECT session_id FROM events WHERE provider IS NULL)", args: [] as string[] }
      : { clause: " AND session_id IN (SELECT session_id FROM events WHERE provider = ?)", args: [provider] };
  const data = db
    .query<Record<string, unknown>, any[]>(
      `SELECT * FROM sessions WHERE 1=1${prov.clause}${s.clause} ORDER BY last_seen DESC LIMIT ?`
    )
    .all(...prov.args, ...s.args, limit)
    .map(parseSessionRow);
  // Only for the rows that need one: a session with a real title does not want
  // its first prompt, and asking for it would be work thrown away.
  const nameless = data.filter((d) => !d.custom_title && !d.ai_title).map((d) => d.session_id);
  if (nameless.length) {
    const prompts = firstPrompts(nameless);
    for (const d of data) {
      const p = prompts.get(d.session_id);
      if (p) d.first_prompt = p;
    }
  }
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
export function statsSummary(windowMs = 24 * 3600 * 1000, provider?: string, tz?: string): StatsSummary {
  // tz belongs in the key, not only the arguments. The heatmap buckets by
  // weekday and hour, which are only defined relative to a clock — and the
  // viewer is often not on the server (remote access, the phone companion).
  // Without it here, one viewer's grid is served to another in a different
  // zone for the whole TTL.
  const key = `${windowMs}|${provider ?? ""}|${workspaceRoot() ?? ""}|${tz ?? ""}`;
  const hit = statsCache.get(key);
  if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.data;
  const data = computeStatsSummary(windowMs, provider, tz);
  // One entry per (window, provider, scope). The window set is fixed and small
  // (the header's chips) and scope rarely changes, so this never grows unbounded
  // in practice; prune stale entries anyway so a long-lived server can't leak.
  statsCache.set(key, { at: Date.now(), data });
  if (statsCache.size > 64) for (const [k, v] of statsCache) if (Date.now() - v.at >= STATS_TTL_MS) statsCache.delete(k);
  return data;
}

function computeStatsSummary(windowMs: number, provider?: string, tz?: string): StatsSummary {
  const since = Date.now() - windowMs;
  const { clause: prov, args: pa } = providerScope(provider);
  const { clause: sc, args: sa } = scopeClause();
  // Every query below appends `pf` and binds `A` in this order, so folding the
  // project filter in here reaches all of them at once.
  const pf = prov + sc;
  const A = [since, ...pa, ...sa]; // bind order: timestamp, provider (if any), project (if any)

  // Every total here is from events within the window — cost and tokens
  // included — because /stats is a windowed view (last 15m / 1h / …), not a
  // lifetime one: cost_usd summed over the window's events is the spend in that
  // window, which is what the dashboard asks for. (The sessions table holds the
  // authoritative lifetime totals; those are what getSessions serves per row,
  // not what a window summary wants.) One pass, not several: counts, errors,
  // sessions, tokens and cost all cover exactly these rows, and over a wide
  // window each separate pass would be another full scan.
  const totals = db
    .query<any, any[]>(
      `SELECT COUNT(*) AS events,
              SUM(CASE WHEN hook_event_type IN ('PostToolUse','PostToolUseFailure') THEN 1 ELSE 0 END) AS tool_calls,
              SUM(is_error) AS errors,
              -- Errors that were actually a tool failing, which is the only
              -- numerator tool_calls can honestly serve as a denominator for.
              -- The errors column counts every errored event, and an LLM span
              -- or a notification can carry is_error too (otlp.ts sets it on
              -- "Turn complete") — dividing that by tool calls produced a
              -- health ring below zero, and insights reading "6 of 4 tool
              -- calls failed". Both ship; each answers its own question.
              SUM(CASE WHEN hook_event_type IN ('PostToolUse','PostToolUseFailure') AND is_error = 1 THEN 1 ELSE 0 END) AS tool_errors,
              COUNT(DISTINCT session_id) AS sessions,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cache_creation_tokens) AS cache_creation_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens,
              SUM(cost_usd) AS cost_usd
       FROM events WHERE timestamp >= ?${pf}`
    )
    .get(...A)!;
  const evtTotals = totals as { events: number; tool_calls: number; errors: number; tool_errors: number };
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
  /**
   * Fold the raw ids into their labels before the panel sees them.
   *
   * The SQL groups by `model_name`, which is the raw id, and the label is
   * applied after — so two ids that share a label ("claude-opus-4-1" and
   * "claude-opus-4-5" both being Opus) arrived as two rows reading "Opus",
   * each carrying part of that model's spend, under the same name and the
   * same colour. The donut's centre was right and no legend row was.
   *
   * `sessions` is the one column that cannot be summed: it is a
   * COUNT(DISTINCT session_id) per raw id, so a session that switched model
   * version mid-run counts once in each row and twice in the fold. It is
   * counted over distinct pairs instead, below.
   */
  const sessionRows = db
    .query<{ model_name: string | null; session_id: string }, any[]>(
      `SELECT DISTINCT model_name, session_id FROM events
       WHERE timestamp >= ? AND model_name IS NOT NULL${pf}`
    )
    .all(...A);
  const sessionsByLabel = new Map<string, Set<string>>();
  for (const r of sessionRows) {
    const label = modelLabel(r.model_name);
    const set = sessionsByLabel.get(label) ?? new Set<string>();
    set.add(r.session_id);
    sessionsByLabel.set(label, set);
  }

  const modelFold = new Map<string, CostByModel>();
  for (const r of modelRows) {
    const label = modelLabel(r.model_name);
    const e = modelFold.get(label) ?? {
      model_name: label,
      input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0,
      equiv_tokens: 0, cost_usd: 0, sessions: 0, unpriced: false,
    };
    // Any contributing id without a rate makes the whole row's cost partly a
    // fallback — the honest reading, since the row is one number.
    if (!hasPrice(r.model_name)) e.unpriced = true;
    e.input_tokens += r.input_tokens ?? 0;
    e.output_tokens += r.output_tokens ?? 0;
    e.cache_creation_tokens += r.cache_creation_tokens ?? 0;
    e.cache_read_tokens += r.cache_read_tokens ?? 0;
    /*
     * Weighted here, inside the loop, against the RAW id.
     *
     * Two ids can fold into one label and be priced differently — that is the
     * whole reason the fold exists — so weighting the folded row would apply
     * one model's ratios to another's tokens. Per raw id and then summed is
     * exact, and keeps the identity that makes this number worth leading with:
     * equivalent tokens times the base input rate is the cost.
     */
    e.equiv_tokens = (e.equiv_tokens ?? 0) + equivalentTokens(r, r.model_name);
    e.cost_usd += r.cost_usd ?? 0;
    modelFold.set(label, e);
  }
  for (const [label, e] of modelFold) e.sessions = sessionsByLabel.get(label)?.size ?? 0;
  /*
   * The window's one comparable number, summed from the same rows the
   * breakdown is built from.
   *
   * Deliberately not a separate query. The headline and the legend under it are
   * the two figures somebody checks against each other, and computing them from
   * two SQL statements is how they come to disagree — `modelRows` has no
   * `model_name IS NOT NULL` filter, so this covers events with no model too,
   * which fall to the fallback rate exactly as their cost already does.
   */
  const equivTotal = [...modelFold.values()].reduce((n, e) => n + (e.equiv_tokens ?? 0), 0);
  // Ordered on the way out: the query has no ORDER BY, and the panel renders
  // the array in the order it arrives, so without this the donut's slices
  // reshuffle between refreshes for no reason the viewer can see.
  const by_model: CostByModel[] = [...modelFold.values()].sort((a, b) => b.cost_usd - a.cost_usd);

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
        // The percentile sample, which is not the call count: a Post with no
        // paired Pre is an invocation with no duration. Shipped so the panel
        // can say when a p95 rests on two measurements.
        timed: sorted.length,
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
  /*
   * Grouped by app AND model, then folded.
   *
   * `tokens` used to be `SUM(input_tokens + output_tokens)`, which is not a
   * quantity: it adds a token that costs five to a token that costs a tenth and
   * drops the cache classes entirely. Weighting needs the model, and the model
   * is not in a group keyed on the app alone — so the group carries it and the
   * fold puts the apps back together. The extra rows are apps × models, which
   * is single digits times single digits.
   */
  const appRows = db
    .query<any, any[]>(
      `SELECT source_app, model_name,
              COUNT(*) AS events,
              SUM(CASE WHEN hook_event_type IN ('PostToolUse','PostToolUseFailure') THEN 1 ELSE 0 END) AS tool_calls,
              SUM(cost_usd) AS cost_usd,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cache_creation_tokens) AS cache_creation_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens
       FROM events WHERE timestamp >= ?${pf}
       GROUP BY source_app, model_name`
    )
    .all(...A);
  // `sessions` is a COUNT(DISTINCT), which does not survive a fold: a session
  // that used two models would be counted once per model and twice in the sum.
  const appSessions = db
    .query<{ source_app: string; sessions: number }, any[]>(
      `SELECT source_app, COUNT(DISTINCT session_id) AS sessions
       FROM events WHERE timestamp >= ?${pf} GROUP BY source_app`
    )
    .all(...A);
  const appFold = new Map<string, AppUsage>();
  for (const r of appRows) {
    const e = appFold.get(r.source_app) ?? { source_app: r.source_app, events: 0, sessions: 0, tool_calls: 0, cost_usd: 0, tokens: 0 };
    e.events += r.events ?? 0;
    e.tool_calls += r.tool_calls ?? 0;
    e.cost_usd += r.cost_usd ?? 0;
    e.tokens += equivalentTokens(r, r.model_name);
    appFold.set(r.source_app, e);
  }
  for (const r of appSessions) { const e = appFold.get(r.source_app); if (e) e.sessions = r.sessions ?? 0; }
  const by_app: AppUsage[] = [...appFold.values()].sort((a, b) => b.cost_usd - a.cost_usd || b.events - a.events);

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
  // The buckets are aligned DOWN from `since`, so they span [start, start +
  // 60*bucketMs), whose upper edge is <= now — the most recent up-to-one-bucket
  // of events (an event at `now` always) fell past the last bucket and vanished
  // from the chart while still counting in the totals. Fold anything at or past
  // the last bucket into it, so every event in the window lands somewhere and
  // sum(bucket events) == totals.events.
  const lastKey = start + (bucketCount - 1) * bucketMs;
  const buckets = new Map<number, TimeBucket>();
  for (let i = 0; i < bucketCount; i++) {
    const t = start + i * bucketMs;
    buckets.set(t, { t, events: 0, errors: 0, cost_usd: 0, tokens: 0 });
  }
  const tlRows = db
    .query<any, any[]>(
      // model_name and both cache columns come along so the bucket's `tokens`
      // can be weighted per row — see the fold below and equivalentTokens().
      `SELECT timestamp, is_error, cost_usd, model_name,
              input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens
         FROM events WHERE timestamp >= ?${pf}`
    )
    .all(...A);
  /**
   * The heatmap is a weekday x hour grid, and neither exists without a clock.
   *
   * It used to bucket with getDay()/getHours(), which read the *server*
   * process's zone, while the timeline beside it buckets UTC epochs and is
   * rendered in the viewer's. So the cell labelled "Tue 14:00" and the tick
   * labelled 14:00 described different real hours whenever the two clocks
   * differed — shifted by the offset, with whole day columns moving when it
   * crossed midnight. Remote access and the phone companion exist precisely
   * so that the viewer is not on the server, so this was reachable rather
   * than theoretical.
   *
   * The formatter is built once: formatToParts per event over a wide window
   * is thousands of calls. An absent or unknown zone falls back to the old
   * behaviour rather than throwing — the server's clock is still better than
   * a 500.
   */
  const heatmap = new Array(168).fill(0);
  const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let fmt: Intl.DateTimeFormat | null = null;
  if (tz) {
    try {
      fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", hour12: false });
    } catch { fmt = null; }
  }
  const cellOf = (ms: number): number => {
    if (!fmt) { const d = new Date(ms); return d.getDay() * 24 + d.getHours(); }
    const parts = fmt.formatToParts(ms);
    const wd = WEEKDAY[parts.find((x) => x.type === "weekday")?.value ?? "Sun"] ?? 0;
    // hour12:false spells midnight "24" in some locales.
    const hr = Number(parts.find((x) => x.type === "hour")?.value ?? 0) % 24;
    return wd * 24 + hr;
  };
  for (const r of tlRows) {
    const t = Math.min(lastKey, Math.floor(r.timestamp / bucketMs) * bucketMs);
    const b = buckets.get(t);
    if (b) {
      b.events++;
      b.errors += r.is_error;
      b.cost_usd += r.cost_usd ?? 0;
      b.tokens += equivalentTokens(r, r.model_name);
    }
    heatmap[cellOf(r.timestamp)]++;
  }

  return {
    totals: {
      events: evtTotals.events ?? 0,
      sessions: tokTotals.sessions ?? 0,
      tool_calls: evtTotals.tool_calls ?? 0,
      errors: evtTotals.errors ?? 0,
      tool_errors: evtTotals.tool_errors ?? 0,
      cost_usd: tokTotals.cost_usd ?? 0,
      input_tokens: tokTotals.input_tokens ?? 0,
      output_tokens: tokTotals.output_tokens ?? 0,
      cache_creation_tokens: tokTotals.cache_creation_tokens ?? 0,
      cache_read_tokens: tokTotals.cache_read_tokens ?? 0,
      equiv_tokens: equivTotal,
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
            SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens,
            -- Selected so the session's tokens can be weighted. Their absence
            -- is why this pane's "Tokens" stat was input+output: not a
            -- decision, just the two columns that happened to be here.
            SUM(cache_creation_tokens) cache_creation_tokens,
            SUM(cache_read_tokens) cache_read_tokens
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
    /*
     * What this session is called.
     *
     * The type has declared these since it was written and nothing ever filled
     * them in, so `sessionTitle(detail)` had nothing to work with and every
     * conversation header — on the phone and at the desk — showed a uuid, next
     * to a list row that showed the real name. The row is right there in
     * `roll`; it was simply never copied across.
     */
    custom_title: roll?.custom_title ?? null,
    ai_title: roll?.ai_title ?? null,
    // Same rule as the list: only when there is no title to use instead.
    first_prompt: roll?.custom_title || roll?.ai_title
      ? null
      : firstPrompts([sessionId]).get(sessionId) ?? null,
    // Prefer the session row; fall back to the events for one that predates the
    // column. Without a directory the UI can't offer to resume the session.
    project_path: roll?.project_path ?? agg.project_path ?? null,
    // The checkout it ran in, when that isn't the repo root — what a resume has
    // to use, and what names the worktree in the header.
    cwd_path: roll?.cwd_path ?? agg.cwd_path ?? null,
    // All three from the session row, falling back to the events only for a
    // session with no row at all. Mixing the two sources is how one session
    // reported two different durations: `ended_at` came from the row while the
    // start came from the events, and retention deletes events. Every prune
    // walked the start forward and left the end where it was, so the deep dive
    // disagreed with the list it was opened from.
    started_at: roll?.started_at ?? agg.started_at,
    ended_at: roll?.ended_at ?? null,
    last_seen: roll?.last_seen ?? agg.last_seen,
    events: agg.events,
    tools: agg.tools ?? 0,
    errors: agg.errors ?? 0,
    cost_usd: agg.cost_usd ?? 0,
    input_tokens: agg.input_tokens ?? 0,
    output_tokens: agg.output_tokens ?? 0,
    equiv_tokens: equivalentTokens(agg, agg.model_name),
    summary,
    tool_mix: toolMix,
    subagents: subRows.map((s) => ({ agent_id: s.agent_id, agent_type: s.agent_type || "subagent", events: s.n })),
    conversation: kept,
    timeline,
    changes: getChanges(40, sessionId),
  };
}

/** Full-text search across every event's prompts, commands and outputs. */
/**
 * Turn what somebody typed into an fts5 MATCH expression.
 *
 * The old one-liner stripped every character that was not alphanumeric or an
 * underscore, then prefix-starred what was left. That welds a term with an
 * inner separator into a single token the unicode61 tokenizer can never
 * produce, so the search returned ZERO hits for text sitting verbatim in the
 * index:
 *
 *   src/db.ts       -> srcdbts*     0 hits
 *   foo-bar         -> foobar*      0 hits
 *   error: ENOENT   -> error* enoent*
 *   C++             -> C*           matches nearly everything
 *
 * Paths, hyphenated flags, dotted symbols and email addresses are most of
 * what anyone searches an agent's output for, so this was the common case
 * rather than the edge.
 *
 * Each term becomes a quoted fts5 phrase with the prefix star OUTSIDE the
 * quotes: `src/db.ts` -> `"src/db.ts"*`, which the tokenizer splits into the
 * phrase src+db+ts and matches. Double quotes in the input are honoured as a
 * phrase rather than split on whitespace, because a user who quotes means it.
 * A term that tokenizes to nothing at all (`C++`, `--`) is dropped rather
 * than degraded into a bare star that matches the whole table.
 */
export function ftsQuery(q: string): string {
  const terms: string[] = [];
  // "quoted phrase" | bare-run-of-non-space
  for (const m of q.matchAll(/"([^"]*)"|(\S+)/g)) {
    const raw = (m[1] ?? m[2] ?? "").trim();
    if (!raw) continue;
    // fts5 escapes a double quote inside a phrase by doubling it.
    const phrase = raw.replace(/"/g, '""');
    // Nothing the tokenizer can index — a run of pure punctuation. Skipping it
    // is what stops `C++` becoming `C*`.
    if (!/[\p{L}\p{N}]/u.test(raw)) continue;
    // The star is a prefix operator on the last token of the phrase, and it
    // only means that outside the quotes.
    terms.push(`"${phrase}"*`);
  }
  return terms.join(" ");
}

export function searchEvents(q: string, limit = 60): import("../../shared/types.ts").SearchHit[] {
  const match = ftsQuery(q);
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
