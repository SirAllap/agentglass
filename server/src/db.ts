// First, so that the database is never opened in a helper role. The entry point
// imports these gates before db.ts, but bun 1.3.14 evaluates a sibling import
// while an earlier one's top-level await is still pending, so the relay opened
// the file. A module that imports a gate cannot run until the gate settles,
// and in the relay, broker and reader roles it never does.
import "./relay/gate.ts";
import "./broker/gate.ts";
import "./reader/gate.ts";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, chmodSync, readFileSync, copyFileSync, linkSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  DbNotice,
} from "../../shared/types.ts";
import type { NormalizedEvent } from "./ingest.ts";
import { costUsd, modelLabel, hasPrice, equivalentTokens } from "./pricing.ts";
import { resumedAs, setIntervalAs, setTimeoutAs, spawnSyncAs, waitedFor } from "./loopwatch.ts";
import { DAY_TOTALS, READS, dailyUsageRead, serverZone, skillUsageRead, statsSummaryRead, type DailyCtx, type ReadName, type ReadVia, type StatsCtx } from "./reader/reads.ts";
import { providerOf as sharedProviderOf, UNKNOWN as UNKNOWN_MODEL } from "../../shared/models.ts";
import { changesMemo, changesAffectedBy } from "./changesMemo.ts";
import { workspaceRoots, scopeKey, scopeRoots, isWithin, sessionInScope, type Scope } from "./config.ts";
import { RETENTION_DAYS, RETENTION_FROM_ENV, setRetentionDays, UNDERSTUDY_STUB_DAYS, setLedgerStubDays } from "./retention.ts";
import { changeRisks, sessionRisks, SESSION_RISK_CAP } from "../../shared/riskFlags.ts";
import { COLD_AFTER_MS, dropRepeatedIterations, RESPONSE_CAP, sameInput, slimColdEvent, slimForInsert, slimToolInput, slimToolResponse } from "./payloadslim.ts";

/**
 * Where the database lives.
 *
 * A relative path resolves against the working directory, which is fine when
 * the server is started from the repo but not when it's launched from a
 * desktop icon — the cwd is then arbitrary, and each launch would quietly
 * start a fresh database somewhere new. Use the XDG data dir so the history
 * is the same no matter how the server was started. An explicit AGENTGLASS_DB
 * still wins.
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
  const base =
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const dir = join(base, "agentglass");
  const refused = defaultDbRefusal(join(dir, "agentglass.db"), {
    // `B:/~BUN/root/…` is the same thing on Windows.
    compiled: Bun.main.startsWith("/$bunfs/") || Bun.main.includes("~BUN"),
    execPath: process.execPath,
    appImage: process.env.APPIMAGE,
    tmp: tmpdir(),
  });
  if (refused) throw new Error(refused);
  const data = join(dir, "agentglass.db");
  /*
   * A FILE IN THE WORKING DIRECTORY NO LONGER WINS.
   *
   * It used to: a `./agentglass.db` already on disk beat the data dir, so a
   * server started from `server/` in a checkout that once had one read that
   * old history instead of the current one — real sessions, weeks stale, and
   * nothing on screen to say which file it was. The data dir is the answer
   * whatever the cwd.
   *
   * That same file is the whole history of anyone who ran from source before
   * the data dir won, and part of it — gate decisions, notes, the activity
   * log — is hook-only and no transcript rescan brings it back. So when the
   * data dir has no database yet, the stray one is COPIED there, once. Never
   * moved, never merged: two histories are not combined automatically, and
   * the original stays byte for byte where it was. When both exist, the
   * stray one is not opened, and it is named on stderr and to the app
   * (`dbNotice`), because a line among the dev server's output is a line
   * nobody reads.
   */
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (local !== data && existsSync(local)) {
      // No database here means no copy of one either: a marker left from an
      // earlier copy must not hide the stray file if this copy fails.
      if (!existsSync(data)) rmSync(importedMarker(data), { force: true });
      if (!existsSync(data) && copyInto(local, data)) {
        notice = { kind: "copied", stray: local, db: data };
        console.warn(`[db] copied ${local} to ${data}, which is the database from now on; the original is untouched and no longer used`);
      } else if (readImported(data) !== local) {
        notice = { kind: "ignored", stray: local, db: data, switchCommand: switchCommand(local, data) };
        console.warn(`[db] ignoring ${local} in the working directory; the database is ${data} (to use the other file instead: stop agentglass, then ${switchCommand(local, data)} — that replaces the current history; or set AGENTGLASS_DB)`);
      }
    }
    return data;
  } catch {
    return local; // unwritable data dir — better a local file than no database
  }
}

let notice: DbNotice | null = null;
/** What the app should say about a second database, or null. Decided once,
 *  at startup, with the path. */
export const dbNotice = (): DbNotice | null => notice;

/** The shell line that puts `stray` where `db` is, for a person to run with
 *  agentglass stopped. The -wal files are part of it: a server that was
 *  killed leaves rows in `stray-wal` that a move of the main file alone
 *  loses, and a `db-wal` left in place would be replayed over the moved
 *  file. Written to work in bash, zsh and fish alike. */
export function switchCommand(stray: string, db: string): string {
  const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
  return `rm -f ${q(db + "-wal")} ${q(db + "-shm")} && mv ${q(stray)} ${q(db)}; mv ${q(stray + "-wal")} ${q(db + "-wal")} 2>/dev/null`;
}

/** Next to the database: which stray file it was copied from, so the next
 *  start does not report that file as a second history. It only ever silences
 *  the notice — a data dir whose database was deleted gets a fresh copy. Its
 *  ceiling: an old build that keeps writing to the stray file after the copy
 *  is not noticed. */
const importedMarker = (data: string): string => `${data}.imported-from`;
function readImported(data: string): string | null {
  try { return readFileSync(importedMarker(data), "utf8").trim(); } catch { return null; }
}

/**
 * Copy a database, with whatever of it is still in its `-wal` file, and only
 * if the copy opens as a database. The source is read and nothing else: no
 * connection is opened on it, because even a read-only one can leave a
 * `-shm` behind. The copy is assembled under a temporary name, checked,
 * checkpointed and linked into place, so a crash half-way never leaves a
 * data-dir database for the next start to trust. The temporary name is this
 * process's own, and the link fails if the database appeared meanwhile: two
 * servers starting together neither delete each other's copy nor put one
 * over a database the other has already opened. A `-wal` or `-shm` a deleted
 * database left behind is removed first — SQLite would replay it over the
 * copy. A copy taken while another server is writing the source can be torn;
 * `quick_check` refuses that one, and the start goes on with an empty
 * database and the "ignored" notice. That start is not retried: the data dir
 * has a database from then on.
 */
function copyInto(src: string, dst: string): boolean {
  const tmp = `${dst}.copying-${process.pid}`;
  const clear = () => { for (const s of ["", "-wal", "-shm"]) rmSync(tmp + s, { force: true }); };
  try {
    clear();
    copyFileSync(src, tmp);
    if (existsSync(src + "-wal")) copyFileSync(src + "-wal", tmp + "-wal");
    const c = new Database(tmp);
    let ok = false;
    try {
      ok = (c.query("PRAGMA quick_check").get() as { quick_check: string } | null)?.quick_check === "ok";
      if (ok) c.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { c.close(); }
    if (!ok) { clear(); return false; }
    chmodSync(tmp, 0o600);
    if (!existsSync(dst)) for (const s of ["-wal", "-shm"]) rmSync(dst + s, { force: true });
    linkSync(tmp, dst);
    clear();
    try { writeFileSync(importedMarker(dst), src + "\n", { mode: 0o600 }); } catch { /* the copy stands; the next start just says "ignored" */ }
    return true;
  } catch {
    clear();
    return false;
  }
}

/**
 * Why this process may not open the default database, or null when it may.
 *
 * THE DEFAULT DATABASE BELONGS TO THE INSTALLED APP. Nothing else asked for it:
 * a server run from a checkout, a `bun -e` that imports this file, a binary
 * built into a worktree's staging directory — each reaches the XDG data dir
 * only because it named nothing else. Measured: a worktree build whose
 * migration rebuilt a table with a new primary key ran there, and the
 * installed release then failed on its first line at every launch, because
 * its upsert names a conflict target the rebuilt table no longer has.
 *
 * "Installed" is a compiled binary that lives neither inside a checkout of
 * this repo (one with `electron/build.mjs`, so a home directory kept in git
 * does not count) nor under the temp directory, where a probe copies a build.
 * An AppImage mount, a .deb, a Mac bundle and `make desktop-install`'s copy all
 * qualify; `bun run src/index.ts` and `electron/staging/agentglass-server` do
 * not. A database under the temp directory is nobody's history and is let
 * through, as `testDbPath` lets it through.
 *
 * The ceilings: an installed binary of an OLDER or NEWER release is still an
 * install, and opens the file — that is the schema generation's job below. A
 * build copied somewhere else by hand passes for an install. And a run from
 * source with XDG_DATA_HOME pointed at a scratch directory outside the temp
 * directory is refused too: nothing here can tell that from a real data dir.
 */
export function defaultDbRefusal(
  path: string,
  run: { compiled: boolean; execPath: string; tmp: string; appImage?: string },
): string | null {
  const under = (p: string, dir: string) => { const r = relative(dir, p); return !!r && !r.startsWith("..") && !isAbsolute(r); };
  if (under(path, run.tmp)) return null;
  let where: string | null = null;
  if (run.compiled) {
    // An AppImage runs from a mount (or an extraction) under the temp directory
    // but is installed: the file the person launched, named by the runtime in
    // APPIMAGE, lives elsewhere. A build copied into the temp directory has no
    // such file outside it. A variable set by hand passes for an install, as a
    // binary copied by hand does (see the ceilings above).
    if (under(run.execPath, run.tmp) && run.appImage && !under(run.appImage, run.tmp) && existsSync(run.appImage)) return null;
    if (under(run.execPath, run.tmp)) where = run.tmp;
    else for (let d = dirname(run.execPath); ; d = dirname(d)) {
      if (existsSync(join(d, ".git")) && existsSync(join(d, "electron", "build.mjs"))) { where = d; break; }
      if (dirname(d) === d) break;
    }
    if (!where) return null;
  }
  const what = run.compiled ? `a binary built or copied into ${where}` : "a run from source";
  return `agentglass: refusing to open the default database ${path} from ${what}; ` +
    "only the installed app opens it. Give this run its own with AGENTGLASS_STATE_DIR=<dir>, " +
    "or name the file with AGENTGLASS_DB=<path> to open it on purpose.";
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

/**
 * Which schema generation last wrote this file, and the refusal when it is
 * newer than this build.
 *
 * Almost every change to this schema is additive — a new table, a new column
 * with a default — and an older build simply never looks at it. The ones that
 * are not (a table rebuilt with a different primary key, a column or a unique
 * index dropped) leave an older build preparing statements against a shape
 * that is gone, and it dies on its first line with an SQLite message that says
 * nothing about versions. A change of that kind bumps SCHEMA_GENERATION; every
 * build from this one on reads the number first and stops with a sentence.
 *
 * Checked BEFORE anything below writes: an older build must not create its
 * tables, switch the journal or run a migration inside a database it has just
 * decided it does not understand. Its own table, not `PRAGMA user_version` —
 * that already counts the error backfill in index.ts.
 *
 * `real-db-guard.test.ts` lists every statement in the source that an older
 * build could not survive, and fails on one that arrives without a bump.
 */
export const SCHEMA_GENERATION = 2;
/*
 * auto_vacuum = INCREMENTAL, so retention can give pages back in small steps
 * (see shrinkFreePages) instead of the file keeping its high-water mark for ever.
 *
 * Before journal_mode AND before the schema_generation table below, on purpose: that table is the first page written, and the
 * mode sticks only if nothing has been written yet (measured: a fresh fixture file read 0 with this after it).
 * Before journal_mode too: on a fresh file the mode sticks only if it is
 * set before the first page is written (checked: set before WAL it reads back 2,
 * after it reads back 0). On an existing file this does nothing by itself — the
 * mode changes only at the next VACUUM, which reclaimFreePages runs once.
 */
db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
{
  const has = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_generation'").get();
  const found = has
    ? db.query<{ generation: number }, []>("SELECT generation FROM schema_generation WHERE id = 1").get()?.generation ?? 0
    : 0;
  if (found > SCHEMA_GENERATION) {
    db.close();
    throw new Error(`agentglass: the database is newer than this app (${DB_PATH} is schema generation ${found}, ` +
      `this build knows ${SCHEMA_GENERATION}). Install the newer release, or point AGENTGLASS_DB at another file.`);
  }
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_generation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL,
  written_at INTEGER NOT NULL
)`);
    if (found < SCHEMA_GENERATION) {
      db.run("INSERT INTO schema_generation (id, generation, written_at) VALUES (1, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET generation = excluded.generation, written_at = excluded.written_at " +
        "WHERE excluded.generation > schema_generation.generation",
        [SCHEMA_GENERATION, Date.now()]);
    }
  } catch (e) {
    // A read-only database has nothing to record and nothing will be written.
    // Anything else (a lock held past busy_timeout) is said, not swallowed.
    if (!/readonly/i.test(String((e as Error)?.message ?? e))) console.error("[db] schema generation not recorded:", e);
  }
}

db.exec("PRAGMA journal_mode = WAL;");
/*
 * synchronous = NORMAL: in WAL mode a commit no longer fsyncs the log.
 *
 * The default, FULL, fsyncs the WAL at every commit, on the event loop, and on
 * btrfs an fsync can wait for a whole transaction commit. Measured on the
 * installed app, 15 h of /proc wchan samples of the server's main thread: during
 * terminal freezes of 5-31 s it sat in state D in write_all_supers (the btrfs
 * commit behind an fsync) in 11 samples and in folio_wait_bit (a page read) in
 * 22, with CPU at 100-300 ms and no memory pressure. WAL + NORMAL cannot corrupt
 * the database; a power cut can lose the last commits, and checkpoints still
 * fsync. History and cockpit state are not worth a frozen terminal.
 */
db.exec("PRAGMA synchronous = NORMAL;");
/*
 * The price of NORMAL is that a power cut or an OS crash can lose the last few
 * commits. Most rows are rebuildable (events are re-read from transcripts; PR,
 * CI, ClickUp and Jira state are caches). A few are a person's decision or a
 * credential that nothing can rebuild: a gate answer, a Go, a sign-off, an
 * agent rule, a seat token. Those writes go through durably(), which makes the
 * commit fsync before it returns. They are rare and paced by a person, so the
 * wait is affordable there and nowhere else.
 *
 * PRAGMA synchronous is a no-op inside an open transaction, so durably() has to
 * wrap the call that opens the transaction, never a statement inside one; called
 * inside one it just runs, and that write stays at NORMAL. A depth counter keeps
 * a nested call from putting NORMAL back under the outer one.
 */
let durableDepth = 0;
let warnedInTransaction = false;
// `run` must be synchronous: FULL goes back to NORMAL when it returns, so a
// Promise's write would land after that. `T extends Promise` is rejected.
export function durably<T>(run: () => T extends PromiseLike<unknown> ? never : T): T {
  if (durableDepth > 0) return run();
  if (db.inTransaction) {
    // Said once: a caller that lands here is a durable write left at NORMAL.
    if (!warnedInTransaction) { warnedInTransaction = true; console.warn("durably() called inside a transaction: this write stays at synchronous = NORMAL"); }
    return run();
  }
  durableDepth++;
  db.exec("PRAGMA synchronous = FULL;");
  try { return run(); }
  finally { durableDepth--; db.exec("PRAGMA synchronous = NORMAL;"); }
}
/*
 * Cap the WAL file, which SQLite otherwise never shrinks.
 *
 * A checkpoint copies the WAL back into the database and lets the next writer
 * start over at the top of the file, but the file keeps the size of its
 * largest run. VACUUM writes the whole database through the WAL, so after one
 * the -wal file is as big as the database, for good: measured at 933 MB beside
 * a 945 MB database. With this limit the writer that restarts the log
 * truncates it back to 64 MB; on a scratch 246 MB database the WAL went from
 * 83 MB after a VACUUM to 67 MB at the next write, where without it it stayed
 * at 83 MB through every write after. trimWal() below takes it to zero.
 */
export const WAL_SIZE_LIMIT = 64 * 1024 * 1024;
db.exec(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT};`);
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
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
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
// sessions table that is already there, so ALTER it in before any statement referencing
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
// `model_name`: SELECT DISTINCT over it is served by idx_events_model_cov below,
// which leads with it. See the DROP block after idx_events_type_cov_scoped.

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
// The per-agent "last seen" walk in agentprobe.ts (distinct source_app, then its newest timestamp) is served by
// idx_events_app_cov below: (source_app, timestamp) is its leftmost prefix, so idx_events_app_ts is redundant. It is NOT
// dropped: a DROP INDEX would need a SCHEMA_GENERATION bump and lock older builds out. Named ceiling: it stays on installed
// DBs and costs one index write per event.
// Finding a session's FIRST prompt: the list asks for up to two hundred of
// them at once, and without this it is a scan of every UserPromptSubmit on the
// machine per refresh. See firstPrompts().
db.exec("CREATE INDEX IF NOT EXISTS idx_events_first_prompt ON events(hook_event_type, session_id, timestamp)");
// GET /agents/board counts each drawn session's last hour (seatpulse.ts) on every poll. With only
// idx_events_session the plan read EVERY event of each session to test its timestamp: measured on a
// fake DB of 430k events over 20 sessions (30k in the last hour), 175 ms of blocked loop per poll,
// and it grows with history, not with the hour. With (session_id, timestamp) it is a covering range
// seek: 5 ms, same rows. idx_events_session is now redundant but, as above, is not dropped.
db.exec("CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events(session_id, timestamp)");

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

// Three single-column indexes are the leftmost prefix of a wider one above, so
// every query they served is served by that one, and each cost a write on every
// inserted event. EXPLAIN QUERY PLAN on a 275,315-page copy of a real cockpit
// (86,099 events, 1.07 GB), with the three dropped:
//   idx_events_source (1.5 MB) -> idx_events_app_cov   (source_app = ? [AND timestamp ...], DISTINCT scan)
//   idx_events_type   (1.7 MB) -> idx_events_type_cov_scoped / idx_events_first_prompt (hook_event_type = ?)
//   idx_events_model  (1.5 MB) -> idx_events_model_cov (model_name = ?, DISTINCT scan)
// Every plan stays an index-only search; only the DISTINCT scans read the wider
// leaves (about 4x the pages of a few MB). Dropping them took 0.7 s on that copy
// and ran once, at module load before the server serves; later boots find
// nothing to drop. 4.7 MB of 1,075 MB: the saving that matters is three fewer
// b-trees to update per insert, not the file size.
// NOT dropped, measured: idx_events_ts (without it `ORDER BY timestamp DESC, id
// DESC LIMIT n` falls to idx_events_stats and adds a TEMP B-TREE for the id
// term) and idx_events_session (session lookups such as the boot backfill's EXISTS).
db.exec("DROP INDEX IF EXISTS idx_events_source");
db.exec("DROP INDEX IF EXISTS idx_events_type");
db.exec("DROP INDEX IF EXISTS idx_events_model");

/** Empty the old full-text index of events, once. True when there was something to empty. */
export function emptyDeadEventsFts(): boolean {
  try {
    // Rows, or index segments left behind by rows long deleted (an empty fts5 table keeps two records).
    const rows = !!db.query("SELECT 1 FROM events_fts LIMIT 1").get();
    const segments = (db.query("SELECT COUNT(*) AS n FROM events_fts_data").get() as { n: number }).n;
    if (!rows && segments <= 2) return false;
    // Dropped and made again: fts5's own 'delete-all' is for contentless tables only, and a DELETE
    // of the rows leaves the segments, which are the 58 MB.
    db.transaction(() => { db.run("DROP TABLE events_fts"); db.run("CREATE VIRTUAL TABLE events_fts USING fts5(text)"); })();
    return true;
  } catch { return false; }
}
// An older build that still fills events_fts (bf9517ce6 did, at boot, for
// every event missing from it) puts the rows back on its first start after
// this one ran: about 1.29 M on the copy measured, and the 58 MB with them.
// That costs a downgrade time and disk once; it does not break it, and an
// empty fts5 table answers MATCH with no rows, not an error.
// Nothing has written or searched events_fts since the search moved off it:
// there is no INSERT and no MATCH left in server/src, only the two retention
// deletes that keep it in step with `events`. Measured on a copy of a real
// database: 7 rows, every rowid below the oldest event still kept (72,431
// against 1,291,600), and 58 MB of index pages under them, in a file the
// server's only thread re-reads from disk after memory pressure. The table
// stays (the retention deletes name it); its content goes, and the freed
// pages return through shrinkFreePages. Later boots find it empty and do
// nothing.
emptyDeadEventsFts();

/**
 * The boot backfill of one sessions column from its events.
 *
 * The guard is an EXISTS driven from the (few) sessions still NULL, probing
 * idx_events_session, not `session_id IN (SELECT … FROM events WHERE col IS NOT
 * NULL)`: that form materialised every distinct session of the events table on
 * every boot, a full scan of events. Measured on a copy of the live DB (173,425
 * events, 863 sessions, 40 with no project_path, 0 rows to fill): 957 ms for
 * project_path and 205 ms for cwd_path with IN, 12 ms and under 1 ms with EXISTS.
 * Same rows either way. It was 1.7 s of a 1.9 s boot (cpu-prof).
 */
export function sessionBackfillSql(col: "project_path" | "cwd_path", limit?: number): string {
  const guard = `${col} IS NULL
      AND EXISTS (SELECT 1 FROM events e WHERE e.session_id = sessions.session_id AND e.${col} IS NOT NULL)`;
  // A slice: only the first `limit` sessions that still qualify. A session with no events never
  // qualifies, so it cannot fill the window and starve the ones behind it.
  const slice = limit ? `\n      AND session_id IN (SELECT session_id FROM sessions WHERE ${guard} LIMIT ${Math.floor(limit)})` : "";
  return `
    UPDATE sessions SET ${col} = (
      SELECT e.${col} FROM events e
       WHERE e.session_id = sessions.session_id AND e.${col} IS NOT NULL
       ORDER BY e.id DESC LIMIT 1
    ) WHERE ${guard}${slice}`;
}

/** Sessions one backfill slice fills before it hands the loop back. */
export const SESSION_BACKFILL_CHUNK = 200;
/**
 * Fill sessions.project_path / cwd_path from their events, a slice at a time with the loop free in
 * between. It was one statement at import: 1.27 s on 200k events for a database that predates the
 * columns, and nothing could answer until it finished. Same rows in the end; a session reads NULL
 * until its slice runs, which is what it already read for a session with no events.
 */
export async function backfillSessionPaths(chunk = SESSION_BACKFILL_CHUNK): Promise<number> {
  let filled = 0;
  for (const col of ["project_path", "cwd_path"] as const) {
    for (;;) {
      const n = waitedFor("boot:session-path-backfill:slice", () => db.run(sessionBackfillSql(col, chunk)).changes);
      filled += n;
      if (n < chunk) break;
      await new Promise<void>((r) => setImmediate(r));
    }
  }
  return filled;
}

// Sessions have no payload of their own, so these are real columns, written at
// upsert and backfilled from the session's events for rows that predate them.
//
// `cwd_path` is what makes an agent attributable to the worktree it ran in.
// `project_path` folds every checkout onto the one repo — which is right for
// grouping, and useless for telling two agents apart when a user has a dozen
// worktrees open at once and wants to know which card each one is working.
for (const col of ["project_path", "cwd_path"] as const) {
  try { db.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`); } catch { /* already present */ }
  // Most sessions legitimately have no cwd — it's only recorded when the turn
  // ran somewhere other than the repo root — so `WHERE cwd_path IS NULL` alone
  // never stops matching them. The guard in sessionBackfillSql is what stops
  // this from being a permanent startup cost; see the note there. The fill itself is
  // backfillSessionPaths(), run in slices after boot.
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
 * checkout runs its scanner over the real history. The README's
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
    const r = spawnSyncAs("db spawn", argv, { stdout: "pipe", stderr: "ignore" });
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

/*
 * What has been read, shared between every device on this server.
 *
 * The browser keeps its own copy in localStorage and reads from that; this
 * table is how a pull request read on the desk stops being "3 new" on the
 * laptop. One row per thing, not a log: the question is only ever "how far
 * has it been read", and marks.ts owns the rules for moving a row.
 *
 * `updated_at` is the server's clock and nobody else's, so `?since=` asks one
 * clock a question about itself instead of comparing two devices' ideas of
 * the time.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS read_marks (
  kind TEXT NOT NULL,                  -- 'pr' | 'inbox' | 'card'
  key TEXT NOT NULL,                   -- pr: 'owner/repo#n'; inbox: thread id; card: card id
  seen_at INTEGER NOT NULL DEFAULT 0,  -- pr/card: read up to (epoch ms); 0 = cleared
  state TEXT NOT NULL DEFAULT '',      -- inbox: 'saved' | 'done' | '' (off)
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
);
CREATE INDEX IF NOT EXISTS read_marks_updated ON read_marks (kind, updated_at);
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
// human, timeout, restart (expired while the server was down), or rule
// (a gate rule in config.json that answered on arrival).
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
-- History reads newest-decided first, polled every 15 s, and a rule's allows
-- make the table one row per allowed call.
CREATE INDEX IF NOT EXISTS idx_gates_decided ON gates(decided_at);

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
/*
 * Whether this one request is denied when nobody answers, whatever the
 * machine's policy — an outward action is. It lived only on the timer, so a
 * restart re-armed a held push under the fail-open default and let it through.
 * 0 on every row written before the column existed, which is what they were.
 */
try { db.exec("ALTER TABLE gates ADD COLUMN fail_closed INTEGER NOT NULL DEFAULT 0"); } catch { /* already present */ }
/* The line a person decides from — what an outward action does and the text
 * it would send, or why a budget made this worth an interruption. It lived in
 * memory beside the timer, so a request restored after a restart came back as
 * a bare summary while still being denied if nobody answered. NULL when there
 * was none, which is most rows. */
try { db.exec("ALTER TABLE gates ADD COLUMN note TEXT"); } catch { /* already present */ }

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
     the ALTER below for why it exists. */
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
 * name it must never write down: a company, a ticket id, a customer. When a
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
 * Decisions the person has already made, as they wrote them, for the classes to reason
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
/*
 * Which one-off re-filings of the bank this database has already been through.
 *
 * classify() decides a precedent's class when it is banked, so changing a
 * class's words leaves every row already in the drawer filed by the old ones.
 * The walk that moves them has to happen once per database and never again,
 * and this file has no migration system — so the marker IS the version, the
 * same way every CREATE TABLE here is.
 *
 * Declared here rather than made on demand by the code that writes it: a table
 * created at the moment somebody reaches for a module is a table a fresh
 * database has only sometimes, which is the defect understudy_asked and
 * understudy_help already taught this file once.
 */
CREATE TABLE IF NOT EXISTS understudy_refiled (
  tag TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);

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

/*
 * WHAT A PERSON SAID ABOUT A COMMIT THEY TESTED.
 *
 * Keyed by commit, not by branch or subject: a rebase rewrites the shas and the
 * old verdict matches no row, which is right — a verdict is about a commit.
 * Additive, so SCHEMA_GENERATION does not move.
 */
CREATE TABLE IF NOT EXISTS signoff (
  project TEXT NOT NULL,
  sha TEXT NOT NULL,
  verdict TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'person',
  by TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project, sha)
);
`);

/*
 * WHERE A PROJECT'S MANIFEST COUNT BEGINS.
 *
 * One row per project: the trunk commit that was HEAD the first time Manifest
 * read it, and when. A repository with years of history would otherwise ask a
 * person to sign off every old commit; the line is what makes the view start at
 * the person's own arrival. Additive, so SCHEMA_GENERATION does not move.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS manifest_start (
  project TEXT PRIMARY KEY,
  sha TEXT NOT NULL,
  at INTEGER NOT NULL
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

/*
 * THE ORCHESTRATOR'S SEAT — one row per project, whether or not anybody is
 * sitting in it (seat.ts).
 *
 * Keyed by checkout root rather than by name, because the seat is a property
 * of a project and not of a machine: the rules a project runs by, the model it
 * is worth paying for, and how much the seat is allowed to do are all answers
 * that change between one repository and the next. The row survives the agent
 * — `ended_at` closes a seating, the row keeps the settings and the last thing
 * the seat said, so opening it again does not start from a blank doctrine.
 *
 * Liveness is NOT this row: like every named agent, the seat is alive while
 * its pane exists, and `named_agent` holds that fact.
 */
db.run(`
CREATE TABLE IF NOT EXISTS seat (
  root TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'claude',
  model TEXT NOT NULL DEFAULT '',
  powers TEXT NOT NULL DEFAULT 'speak',
  started_at INTEGER NOT NULL DEFAULT 0,
  ended_at INTEGER,
  last_line TEXT NOT NULL DEFAULT '',
  last_turn_at INTEGER NOT NULL DEFAULT 0
);
`);

/*
 * WHETHER A POLICY RULE IS ON, kept so a restart does not forget it.
 *
 * A rule's switch has hysteresis: it turns on at a threshold and off only some
 * way past it, so a reading that wobbles around the line cannot flap it. That
 * is memory, and memory in the process dies with it. `memory` is each
 * trigger's own last answer (and the `resetsAt` it saw), `holding` the reason
 * the last reading could not change anything, `reading` what the rule saw when
 * it last changed. See server/src/orchpolicy.ts.
 */
db.run(`
CREATE TABLE IF NOT EXISTS policy_state (
  scope TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  since INTEGER NOT NULL DEFAULT 0,
  reading TEXT NOT NULL DEFAULT '',
  reading_at INTEGER NOT NULL DEFAULT 0,
  holding TEXT NOT NULL DEFAULT '',
  memory TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (scope, rule_id)
);
`);

/*
 * THE SEAT'S QUEUE — what a project's orchestrator has been asked to see done,
 * and who it handed each one to (seatqueue.ts).
 *
 * Claimed at the START of a handing-out and not at the end, which is the one
 * thing the clone's own queue had to learn twice: stamping `taken_at` when the
 * work FINISHED left everything that failed looking untouched, and the next
 * round picked it straight back up against the checkout the failure had left
 * behind. `attempts` counts the goes; past a ceiling the seat is told to stop
 * offering it and say so to a person instead.
 *
 * `taken_by` is a named agent's name, not a pane: panes are recycled by tmux
 * and a row that outlives one would point at somebody else's work.
 */
db.run(`
CREATE TABLE IF NOT EXISTS seat_task (
  id TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  weight INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  taken_at INTEGER,
  taken_by TEXT NOT NULL DEFAULT '',
  done_at INTEGER,
  outcome TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0
);
`);
db.run(`CREATE INDEX IF NOT EXISTS seat_task_root ON seat_task (root, done_at, taken_at)`);
/* WHAT WOULD PROVE IT IS DONE, written when the work is asked for and not
 * argued about afterwards. Every published orchestration contract carries this
 * field under some name — Orca calls it "observable acceptance" — because the
 * failure it prevents is the one everybody reports: a worker that stops early
 * reports "done" in prose, and without a named artefact nobody can tell that
 * apart from the real thing. An ALTER rather than a column above, so a
 * database made yesterday gains it too. */
try { db.exec("ALTER TABLE seat_task ADD COLUMN proof TEXT NOT NULL DEFAULT ''"); } catch { /* already present */ }
try { db.exec("ALTER TABLE seat_task ADD COLUMN preflight_run TEXT"); } catch { /* already present */ }

/*
 * WHAT THE SEAT SAID, kept.
 *
 * One line per round is the whole report, and only the latest was kept — which
 * made the view a status light. Four of them is the day: what needed a person
 * this morning, what it handed out at lunch, and whether anything landed. The
 * cost of that is one short row per round, and a round happens when the field
 * changes rather than on a clock, so this grows in tens per day and not in
 * thousands.
 *
 * Swept with the ninety-day records. A line older than that is not history,
 * it is a log nobody will read.
 */
db.run(`
CREATE TABLE IF NOT EXISTS seat_line (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root TEXT NOT NULL,
  line TEXT NOT NULL,
  at INTEGER NOT NULL
);
`);
db.run(`CREATE INDEX IF NOT EXISTS seat_line_root ON seat_line (root, at DESC)`);

/*
 * REPORTS FROM THE AGENTS DOING THE WORK.
 *
 * The one thing the orchestrator this feature was modelled on wanted first: a
 * tray where every worker's report arrives in the same fixed shape, without it
 * being pasted in five times by hand. Today each worker messages it, and the
 * report lands in the most expensive context on the machine as prose that has
 * to be read, re-read and remembered.
 *
 * So a report is a ROW, in the four fields the brief asks for. The seat drains
 * them in one call instead of five, the view shows what is unread, and a
 * report arriving is a change — which is what wakes the seat, so nobody polls.
 *
 * `read_at` rather than a delete: what an agent said is the record of what it
 * said, and the seat having read it is a different fact from it not existing.
 */
db.run(`
CREATE TABLE IF NOT EXISTS seat_report (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root TEXT NOT NULL,
  agent TEXT NOT NULL,
  session TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  blocked TEXT NOT NULL DEFAULT '',
  need TEXT NOT NULL DEFAULT '',
  cost TEXT NOT NULL DEFAULT '',
  raw TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL,
  read_at INTEGER
);
`);
db.run(`CREATE INDEX IF NOT EXISTS seat_report_root ON seat_report (root, read_at, at DESC)`);

/*
 * WHAT THE SEAT ASKS OF THE PERSON — the other direction of the tray.
 *
 * A report is a worker saying what it needs. This is the seat saying what IT
 * needs, and the two are not the same list: one is work asking to be
 * unblocked, the other is a decision asking to be made. The orchestrator here
 * named the gap after a day of it living nowhere but a chat: a branch pushed
 * and waiting on a re-upload, a bot-clean PR waiting on a reviewer, three
 * conflict-free branches waiting on a push — every one of them something ready,
 * waiting on one action only a person can take.
 *
 * Four fields and every one of them earns its place. `cost` and `recommend`
 * because a decision handed over without what it costs and what the seat would
 * do is a decision the person has to research before making. `proof` because
 * "done" has to be a thing somebody could check — the same rule the queue
 * already keeps for work.
 *
 * Not folded into `seat_task`: that queue is work to hand DOWN to an agent,
 * and this is a question handed UP. Same shape, opposite direction, and one
 * table would have made the view guess which was which.
 */
db.run(`
CREATE TABLE IF NOT EXISTS seat_need (
  id TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  text TEXT NOT NULL,
  cost TEXT NOT NULL DEFAULT '',
  recommend TEXT NOT NULL DEFAULT '',
  proof TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  done_at INTEGER,
  outcome TEXT NOT NULL DEFAULT ''
);
`);
db.run(`CREATE INDEX IF NOT EXISTS seat_need_root ON seat_need (root, done_at, created)`);

/*
 * AN ORCHESTRATOR THAT WAS ALREADY WORKING.
 *
 * The seat opens an agent and owns it. But the first orchestrator this feature
 * was modelled on had been running a real project for a day when the seat was
 * built, with five agents reporting to it and a context nobody wants to throw
 * away — and "take the seat" would have replaced it with a stranger.
 *
 * So a session can be ADOPTED instead: the row points at a pane that already
 * exists, and liveness is that pane, exactly as it is for a seat this app
 * opened. Nothing is restarted and nothing is re-prompted; what changes is
 * that the app knows who the orchestrator is.
 */
try { db.exec("ALTER TABLE seat ADD COLUMN adopted_session TEXT NOT NULL DEFAULT ''"); } catch { /* already present */ }
try { db.exec("ALTER TABLE seat ADD COLUMN adopted_pane TEXT NOT NULL DEFAULT ''"); } catch { /* already present */ }
/* Whether the adoption on this row passed the person's click. A re-link from a
   window named like the seat clears it: the name is not an approval. */
try { db.exec("ALTER TABLE seat ADD COLUMN adopted_approved INTEGER NOT NULL DEFAULT 0"); } catch { /* already present */ }
/*
 * THE PANE'S IDENTITY, NOT JUST ITS %id.
 *
 * tmux renumbers panes from %0 on a fresh server, so after a restart an
 * unrelated pane can get the same id an adopted seat's row still names. This
 * is that pane's `pid.start_time` at the moment it was adopted (see
 * `paneIdentity` in agentops.ts) — empty on a row adopted before this column
 * existed, which `seatPaneVerdict` in seat.ts reads as "unknown", never a
 * match.
 */
try { db.exec("ALTER TABLE seat ADD COLUMN adopted_pane_identity TEXT NOT NULL DEFAULT ''"); } catch { /* already present */ }

/*
 * A SEAT'S CREDENTIAL, SURVIVING A RESTART.
 *
 * `seatTokens` in auth.ts is in-memory, so a restart used to 401 every adopted
 * orchestrator's own token — the seat lost Go/resolve and the person had to
 * approve the adoption card again. Only the hash is kept here, the same way
 * devices.ts keeps a paired phone's: the raw token is never written to disk,
 * and a row proves nothing without the token that made it. Dropped on
 * release/re-adopt (`revokeSeatTokens`) and when the adopted pane this row
 * named is gone at boot — see `reapDeadSeatTokens` in seat.ts.
 */
db.run(`
CREATE TABLE IF NOT EXISTS seat_credential (
  hash TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  powers TEXT NOT NULL
);
`);
db.run(`CREATE INDEX IF NOT EXISTS seat_credential_root ON seat_credential (root)`);

/* A worker's `wk_` credential across a restart. It lived only in memory, so
   every app restart or install turned the browser calls of a live worker into
   `unauthorized` mid-turn, and the worker stopped. Same shape as
   seat_credential: only the hash is kept, plus the name, root and the expiry
   the credential already had; a row proves nothing without the token. Dropped
   with the in-memory entry on every revoke and at expiry. */
db.run(`
CREATE TABLE IF NOT EXISTS worker_credential (
  hash TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root TEXT,
  expires_at INTEGER NOT NULL
);
`);
db.run(`CREATE INDEX IF NOT EXISTS worker_credential_name ON worker_credential (name)`);

/*
 * A NAMED AGENT THIS APP DID NOT START.
 *
 * The registry held only what `startAgent` opened, so a person's own tmux tab
 * running an agent did not exist as far as `broadcast`, `prompt` or `stop`
 * were concerned — measured by the orchestrator here, whose whole fleet is
 * tabs it opened by hand, where `list` showed 0 with 2 tabs alive. Enlisting one writes
 * the same row, and this column is what keeps `stop` honest afterwards: a
 * window somebody opened is not this app's to kill.
 */
try { db.exec("ALTER TABLE named_agent ADD COLUMN adopted INTEGER NOT NULL DEFAULT 0"); } catch { /* already present */ }
/* Who started a worker and how it ended: the seat that owns it, the model it
   runs, the policy decision as JSON, the engine's session to resume, and the
   exit status and last stderr line of its latest turn (agents/workerstart.ts). */
for (const col of ["seat_root TEXT", "model TEXT", "started_by TEXT", "resume_id TEXT", "exit_code INTEGER", "exit_line TEXT"]) {
  try { db.exec(`ALTER TABLE named_agent ADD COLUMN ${col}`); } catch { /* already present */ }
}
/* The worker role it was started as, kept for a start that did not go through
   the orchestration policy: that row has no `started_by` stamp, so the board
   had nothing to count it by and a project's Flow read "0 in flight" with its
   builders running. */
try { db.exec("ALTER TABLE named_agent ADD COLUMN role TEXT"); } catch { /* already present */ }

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
  resolution: "human" | "timeout" | "restart" | "rule" | null;
  decided_at: number | null;
  /** Who, when a person decided. NULL for a timeout, a restart, a rule, and for
   *  every row written before this column existed — an absent actor is not `local`. */
  decided_by: string | null;
  /** 1 when this request is denied on timeout whatever the machine's policy. */
  fail_closed: number;
  /** The hold's own line, shown beside the summary. */
  note: string | null;
}

const gateInsert = db.query(`
  INSERT OR REPLACE INTO gates (id, source_app, session_id, tool_name, summary, created, expires, fail_closed, note)
  VALUES ($id, $source_app, $session_id, $tool_name, $summary, $created, $expires, $fail_closed, $note)`);
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
const gatesRecentUnlisted = db.query<GateRow, [number]>(
  `SELECT * FROM gates WHERE decision IS NOT NULL AND NOT (resolution = 'rule' AND decision = 'allow')
   ORDER BY decided_at DESC LIMIT ?`);

export function recordGate(g: {
  id: string; source_app: string; session_id: string; tool_name: string;
  summary: string; created: number; expires: number; fail_closed?: boolean; note?: string;
}): void {
  gateInsert.run({
    $id: g.id, $source_app: g.source_app, $session_id: g.session_id, $tool_name: g.tool_name,
    $summary: g.summary, $created: g.created, $expires: g.expires, $fail_closed: g.fail_closed ? 1 : 0,
    $note: g.note ?? null,
  } as any);
}

/**
 * A gate a rule decided on arrival: written and resolved in one transaction.
 * Two separate writes could leave the row pending with no waiter when the
 * second failed, and the next boot resolves a pending row by the timeout
 * policy — history then read "allowed, restart" for a call the rule denied.
 */
export function recordRuleGate(
  g: { id: string; source_app: string; session_id: string; tool_name: string; summary: string; created: number },
  decision: "allow" | "deny",
  reason: string,
): void {
  db.transaction(() => {
    recordGate({ ...g, expires: g.created });
    resolveGateRow(g.id, decision, reason, "rule", g.created);
  })();
}

export function resolveGateRow(
  id: string,
  decision: "allow" | "deny",
  reason: string,
  resolution: "human" | "timeout" | "restart" | "rule",
  decided_at = Date.now(),
  /** Only ever set for a human. The clock is not an actor. */
  decided_by: string | null = null,
): void {
  const write = () => gateResolve.run({
    $id: id, $decision: decision, $reason: reason, $resolution: resolution,
    $decided_at: decided_at,
    // Belt as well as braces: the callers pass null for a timeout, and so does
    // this, so an actor cannot arrive attached to an outcome nobody chose.
    $decided_by: resolution === "human" ? decided_by : null,
  } as any);
  // A person's answer is a decision nothing can rebuild; a timeout or a restart is the clock's and is.
  if (resolution === "human") durably(write); else write();
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
export function gateHistory(limit = 50, opts: { ruleAllows?: boolean } = {}): GateRow[] {
  const n = Math.max(1, Math.min(500, limit));
  // A rule's allows are one row per waved-through call; a reader looking for
  // what nobody chose asks without them, or twenty-five allowed Reads push the
  // one denial it is looking for out of its window.
  return opts.ruleAllows === false ? gatesRecentUnlisted.all(n) : gatesRecent.all(n);
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
 * anyone has ever worked in. The two DISTINCT scans that find it are cheap warm
 * (4 ms) and not cold: 94-98 ms of index pages read from disk on a 1.1 GB
 * database, repeated every 30 s on the loop. So it is read once, kept for the
 * life of the process, and grown at ingest by the one place a path can arrive.
 * Only retention's delete can remove one, and it drops the set.
 */
export function pathSet(seed: () => string[]) {
  let paths: Set<string> | null = null;
  return {
    all: (): string[] => [...(paths ??= new Set(seed()))],
    /** A path the table has not held before: a new worktree must appear in a
     *  scoped dashboard on its first event. No-op until the set is first read. */
    note: (p: unknown): void => { if (typeof p === "string" && p) paths?.add(p); },
    forget: (): void => { paths = null; },
  };
}

const recorded = pathSet(() => {
  const seen = new Set<string>();
  for (const col of ["project_path", "cwd_path"] as const) {
    // Skip scan: one index seek per distinct path instead of walking all of the column's index (143 ms on
    // 785k rows, cold; the DISTINCT it replaces read every entry just to see the same handful of values).
    for (const r of db.query<{ p: string | null }, []>(
      `WITH RECURSIVE t(p) AS (SELECT MIN(${col}) FROM events
         UNION ALL SELECT (SELECT MIN(${col}) FROM events WHERE ${col} > t.p) FROM t WHERE t.p IS NOT NULL)
       SELECT p FROM t WHERE p IS NOT NULL`).all()) {
      if (r.p) seen.add(r.p);
    }
  }
  return [...seen];
});
const recordedPaths = recorded.all;
const notePath = recorded.note;

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
export function scopeClause(scope: Scope = workspaceRoots()): { clause: string; args: string[] } {
  // Every checkout of every open project, not the scope paths alone: linked
  // worktrees usually live in sibling directories, so a prefix test against the
  // scope matches none of them — a project opened at ~/code/orbit would show an
  // empty dashboard for a day spent working in ~/code/orbit-WEB-1042, which is
  // where the work actually happens. Empty when unscoped.
  const roots = scopeRoots(scope);
  if (!roots.length) return { clause: "", args: [] };
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
function sessionScopeClause(scope: Scope = workspaceRoots()): { clause: string; args: string[] } {
  // Delegate to scopeClause rather than keep a second copy: this used its own
  // `LIKE 'root/%'` pattern — the very thing scopeClause was rewritten to drop,
  // because an underscore in a scope root is a single-char wildcard in LIKE and
  // over-matches sibling projects (root_backup as well as root). The sessions
  // table carries the same project_path/cwd_path columns, so the resolved-path
  // IN clause applies unchanged, and correctly.
  return scopeClause(scope);
}

/*
 * WHETHER A SESSION'S EVENTS CHANGED SINCE SOMEBODY LAST LOOKED.
 *
 * Bumped per session by every insert and for everybody by an erase or a
 * retention pass, so a reader that keeps a per-session answer (lantern.ts,
 * the board's facts) can tell an idle session from one that moved without
 * asking the table. An idle session's index pages go cold, and re-reading
 * them on every poll was most of what GET /agents/board read from disk.
 */
const sessionGens = new Map<string, number>();
let eventEpoch = 0;
export function sessionEventStamp(id: string): string { return `${eventEpoch}.${sessionGens.get(id) ?? 0}`; }

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

/** The claimed Pre, with its input as JSON text, so the Post can tell whether
 *  it carries the same input (and the Pre's copy can go: see payloadslim.ts). */
type PreClaim = { id: number; timestamp: number; ti: string | null };
const slimPreInput = db.query<unknown, [string, number]>(
  `UPDATE events SET payload = json_set(payload, '$.tool_input', json(?), '$.tool_input_slim', json('true')) WHERE id = ?`);
/** Drop the big fields of a Pre's input when its Post carries the same input. */
function slimPairedPre(pre: PreClaim, postInput: unknown): void {
  if (!pre.ti || !postInput || typeof postInput !== "object") return;
  let preInput: unknown;
  try { preInput = JSON.parse(pre.ti); } catch { return; }
  if (!sameInput(preInput, postInput)) return;
  const slim = slimToolInput(preInput);
  if (slim) slimPreInput.run(JSON.stringify(slim), pre.id);
}

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
const claimPreById = db.query<PreClaim, [string]>(
  `UPDATE events SET paired = 1
   WHERE id = (SELECT id FROM events
               WHERE hook_event_type = 'PreToolUse' AND tool_use_id = ? AND paired = 0
               ORDER BY id DESC LIMIT 1)
   RETURNING id, timestamp, json_extract(payload, '$.tool_input') AS ti`
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
const claimPreByTool = db.query<PreClaim, [string, string, number, number]>(
  `UPDATE events SET paired = 1
   WHERE id = (SELECT id FROM events
               WHERE hook_event_type = 'PreToolUse' AND session_id = ? AND tool_name = ?
                 AND paired = 0 AND timestamp <= ? AND timestamp >= ?
               ORDER BY id ASC LIMIT 1)
   RETURNING id, timestamp, json_extract(payload, '$.tool_input') AS ti`
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
  return withParsedPayload(r, safeJson(r.payload));
}

function withParsedPayload(r: any, payload: Record<string, unknown>): WatchEvent {
  return {
    ...r,
    equiv_tokens: equivalentTokens(r, r.model_name),
    payload,
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
// The retention lives in retention.ts so Settings can change it without opening this database; re-exported live.
export { RETENTION_DAYS, RETENTION_FROM_ENV, setRetentionDays };

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
 *  expire: they are the score, and a score with holes in it is not a score.
 *  A live setting (see retention.ts) with its own default of 90, re-exported
 *  here so every sweep below reads the one binding. */
export { UNDERSTUDY_STUB_DAYS, setLedgerStubDays };

/**
 * Fold every event older than `cutoff` into daily_rollup.
 *
 * Runs inside the prune transaction, immediately before the DELETE, so a
 * crash between the two cannot lose a day: either both happened or neither
 * did. Accumulating rather than replacing, because a day is folded once when
 * it expires and must not be double-counted if a prune is run twice — the
 * DELETE that follows is what guarantees each event is folded exactly once.
 */
function foldExpiringEvents(cutoff: number, hts = Number.MAX_SAFE_INTEGER, hid = Number.MAX_SAFE_INTEGER): number {
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
     FROM events WHERE timestamp < ? AND (timestamp, id) <= (?, ?)
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
    [cutoff, hts, hid]
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
/**
 * Checkpoint the WAL into the database and truncate the file to zero bytes,
 * without ever waiting for it.
 *
 * TRUNCATE has to wait for every reader to leave the WAL, and it waits through
 * the busy handler: with the 5 s busy_timeout this connection runs on, a reader
 * in another process (a CLI holding a read transaction) would stall the event
 * loop for those 5 s. So the timeout is zero for this one statement, and a busy
 * WAL is simply left for the next call. Nothing is lost by that: the frames are
 * still checkpointed as far as the readers allow, and journal_size_limit still
 * caps the file.
 *
 * The cost is the frames not yet checkpointed, which auto-checkpoint keeps to
 * about 1000 pages (4 MB); measured at 5-6 ms on a scratch database with an
 * 8 MB write behind it.
 */
export function trimWal(): { busy: boolean; ms: number } {
  const started = performance.now();
  let busy = true;
  try {
    db.exec("PRAGMA busy_timeout = 0;");
    const r = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy?: number } | null;
    busy = Number(r?.busy ?? 1) !== 0;
  } catch {
    // SQLITE_BUSY raised rather than reported: the same answer, try later.
  } finally {
    db.exec("PRAGMA busy_timeout = 5000;");
  }
  return { busy, ms: performance.now() - started };
}

/**
 * The routine checkpoint, moved off the event loop.
 *
 * SQLite's auto-checkpoint runs inside whichever commit pushes the WAL past
 * 1000 pages, on the connection that committed: here, the event loop. It copies
 * the WAL into the database and fsyncs both files, and on this btrfs disk an
 * fsync waits for whatever else is writing. Measured on an isolated 200 MB copy
 * with ingest-shaped writes every 20 ms and a 16 MB write+fsync loop beside it
 * (a test suite's disk load): loop delay p99 28.6 / 54.5 ms, max 427 ms, and
 * every slow tick was a slow insert. Auto-checkpoint off, same load: p99 1.9 /
 * 1.8 ms, max 105 / 45 ms. The server's "no JS was running" stalls during test
 * runs are this: an unlabelled insert waiting on the disk.
 *
 * So a worker thread with its own connection runs a PASSIVE checkpoint every
 * few seconds. PASSIVE never takes the write lock, so the loop's writers do not
 * wait on it, and its busy_timeout is 0 so it never waits on them. Only once the
 * worker says it is up does this connection stop auto-checkpointing; if the
 * worker cannot start or dies, auto-checkpoint comes back, so the WAL is never
 * left without anyone to fold it in. A watchdog on this loop treats silence
 * (3 intervals), 3 errors in a row, or a WAL past WAL_CAP_FRAMES the same way,
 * says so once in the server log, and starts a new worker with backoff. The worker's source is a string because a
 * second file is not carried by `bun build --compile`; a Blob URL is.
 *
 * The WAL only starts over at the top when a write begins with every frame
 * already copied back. Under steady writes the worker's fsync outlasts the gap
 * between two inserts, so that moment never comes: measured, the WAL grew to
 * 117 MB in 25 s. So when the worker reports more than CATCHUP_FRAMES in the
 * log, this connection runs one PASSIVE itself: it copies only the frames
 * written since the worker's pass, and the next write restarts the log. That is
 * one loop fsync per ~32 MB written instead of one per 4 MB, and none at all
 * while writes leave gaps.
 */
const CHECKPOINT_EVERY_MS = 2_000;
const CATCHUP_FRAMES = 2_048;
export const WAL_PACE_FRAMES = CATCHUP_FRAMES;
/** ~256 MB of 4 KB pages: past this the worker is not keeping up, whatever it reports. */
const WAL_CAP_FRAMES = 65_536;
/** Errors in a row before the worker counts as broken. A PASSIVE busy does not throw, so these are real: IOERR, CORRUPT, read-only. */
const MAX_ERRORS = 3;
const RESTART_MAX_MS = 5 * 60_000;
let checkpointer: Worker | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let ckpt = { every: CHECKPOINT_EVERY_MS, code: "", lastReport: 0, errors: 0, backoff: 0, said: false, fresh: true };
/** The worker's last pass: frames in the WAL and frames it copied back, plus failures and restarts. For /health and the test. */
let lastPass = { passes: 0, log: 0, copied: 0, failures: 0, restarts: 0 };
export const checkpointerPass = () => ({ ...lastPass });
const CHECKPOINT_WORKER = `import { Database } from "bun:sqlite";
self.onmessage = (e) => {
  let d;
  try { d = new Database(e.data.path); d.exec("PRAGMA busy_timeout = 0;"); }
  catch (err) { postMessage({ failed: String(err) }); return; }
  postMessage({ ready: true });
  setInterval(() => { // loop-ok: runs in the checkpoint worker thread, not the server loop
    try { const r = d.prepare("PRAGMA wal_checkpoint(PASSIVE)"); const row = r.get(); r.finalize(); postMessage({ busy: row?.busy ?? 0, log: row?.log ?? 0, copied: row?.checkpointed ?? 0 }); }
    catch (err) { postMessage({ error: "wal_checkpoint threw: " + (err?.message ?? "") }); }
  }, e.data.every);
};`;
const autoCheckpointOn = () => { try { db.exec("PRAGMA wal_autocheckpoint = 1000;"); } catch { /* closed */ } };
/**
 * One catch-up step: a PASSIVE checkpoint on this connection. SQLite has no page
 * limit on it, so the bound is the WAL itself: callers run a step before more
 * than CATCHUP_FRAMES are unwritten back, so one step copies at most about that
 * many pages (8 MB), not the 28 MB that stalled the loop 0.5-7.5 s on a first
 * cold cut. Returns frames in the log and frames copied back, or null if busy.
 */
export const walStepStats = { steps: 0, longestMs: 0, maxLog: 0, bigSteps: 0 };
const BIG_STEP_FRAMES = CATCHUP_FRAMES * 4;
function checkpointStep(): { log: number; copied: number } | null {
  return waitedFor("wal catch-up checkpoint", () => {
    const t0 = performance.now();
    try {
      const row = db.query("PRAGMA wal_checkpoint(PASSIVE)").get() as { log?: number; checkpointed?: number } | null;
      const log = row?.log ?? 0;
      const copied = row?.checkpointed ?? 0;
      const before = lastPass.log <= log ? lastPass.copied : 0; // frames already copied from this WAL
      if (log - before > BIG_STEP_FRAMES) walStepStats.bigSteps++;
      lastPass.log = log;
      lastPass.copied = copied;
      walStepStats.steps++;
      walStepStats.maxLog = Math.max(walStepStats.maxLog, log);
      return { log, copied };
    } catch { return null; /* busy: next check */ }
    finally { walStepStats.longestMs = Math.max(walStepStats.longestMs, performance.now() - t0); }
  });
}
function catchUp(): void {
  if (!checkpointer || lastPass.log - lastPass.copied < CATCHUP_FRAMES) return;
  checkpointStep();
}
/**
 * Pace a bulk writer by WAL growth: before the next slice, if more than
 * CATCHUP_FRAMES are written and not yet copied back, run bounded steps (the
 * loop is handed back after each) until the log has caught up. Gives up after a
 * few tries so a reader that pins the WAL cannot hold the cut forever.
 */
let paceSkip = 0;
let lastPaceStepAt = 0;
const PACE_BACKOFF_SLICES = 8;
const PACE_RECHECK_MS = 20;
export async function paceByWal(): Promise<void> {
  if (!checkpointer) return;
  if (paceSkip > 0) { paceSkip--; return; }
  // Known backlog small and checked a moment ago: no PASSIVE (it fsyncs on the loop).
  if (lastPass.log - lastPass.copied < CATCHUP_FRAMES && performance.now() - lastPaceStepAt < PACE_RECHECK_MS) return;
  lastPaceStepAt = performance.now();
  for (let tries = 0; tries < 20; tries++) {
    const s = checkpointStep();
    if (!s || s.log - s.copied < CATCHUP_FRAMES) return;
    await new Promise<void>((res) => setTimeoutAs("wal pace", res as () => void, 10)); // loop-ok: one-shot yield inside a running pass, not a periodic timer
  }
  paceSkip = PACE_BACKOFF_SLICES; // a reader pins the WAL: do not pay the wait on every slice
}
/** The worker is gone or not doing its job: auto-checkpoint back on, say so once, try a new worker later. */
function checkpointerFailed(why: string): void {
  const w = checkpointer;
  checkpointer = null;
  if (w) w.terminate();
  autoCheckpointOn();
  lastPass.failures++;
  if (!ckpt.said) { ckpt.said = true; console.warn(`[db] checkpoint worker failed (${why}); auto-checkpoint is back on, retrying the worker with backoff`); }
  if (restartTimer || !watchdog) return;
  ckpt.backoff = Math.min(RESTART_MAX_MS, ckpt.backoff ? ckpt.backoff * 2 : ckpt.every * 4);
  restartTimer = setTimeoutAs("boot:checkpointer:restart", () => { restartTimer = null; lastPass.restarts++; spawnCheckpointer(); }, ckpt.backoff);
  (restartTimer as { unref?: () => void }).unref?.();
}
function spawnCheckpointer(): void {
  ckpt.lastReport = Date.now();
  ckpt.errors = 0;
  ckpt.fresh = true;
  try {
    const w = new Worker(URL.createObjectURL(new Blob([ckpt.code], { type: "application/javascript" })));
    checkpointer = w;
    w.onmessage = (e: MessageEvent<{ ready?: boolean; failed?: string; error?: string; busy?: number; log?: number; copied?: number }>) => {
      if (checkpointer !== w) return;
      ckpt.lastReport = Date.now();
      if (e.data?.ready) db.exec("PRAGMA wal_autocheckpoint = 0;");
      else if (e.data?.log !== undefined) {
        ckpt.errors = 0;
        lastPass = { ...lastPass, passes: lastPass.passes + 1, log: e.data.log, copied: e.data.copied ?? 0 };
        // The first pass of a new worker sees the WAL its dead predecessor left: judge the second.
        const first = ckpt.fresh;
        ckpt.fresh = false;
        if (!first && lastPass.log >= WAL_CAP_FRAMES) return checkpointerFailed(`WAL at ${lastPass.log} frames`);
        if (!e.data.busy) { ckpt.backoff = 0; ckpt.said = false; }
        catchUp();
      } else if (e.data?.error !== undefined) {
        if (++ckpt.errors >= MAX_ERRORS) checkpointerFailed(`${ckpt.errors} errors in a row: ${e.data.error}`);
      } else checkpointerFailed(`could not open: ${e.data?.failed}`);
    };
    w.onerror = (e) => { if (checkpointer === w) checkpointerFailed(`threw: ${(e as ErrorEvent)?.message ?? e}`); };
    w.addEventListener("close", () => { if (checkpointer === w) checkpointerFailed("exited"); });
    w.unref();
    w.postMessage({ path: DB_PATH, every: ckpt.every });
  } catch (e) { checkpointer = null; checkpointerFailed(`could not start: ${(e as Error)?.message ?? e}`); }
}
/** `code` replaces the worker's source: only the test uses it, to fake a broken or hung worker. */
export function startCheckpointer(every = CHECKPOINT_EVERY_MS, code = CHECKPOINT_WORKER): void {
  if (watchdog || DB_PATH === ":memory:") return;
  ckpt = { every, code, lastReport: Date.now(), errors: 0, backoff: 0, said: false, fresh: true };
  // The watchdog: a worker that hangs never posts an error, so silence counts as failure too.
  watchdog = setIntervalAs("checkpoint watchdog", () => {
    if (!checkpointer) return;
    if (Date.now() - ckpt.lastReport > 3 * ckpt.every) return checkpointerFailed(`no report for ${Math.round((Date.now() - ckpt.lastReport) / 1000)} s`);
    catchUp();
  }, every);
  (watchdog as { unref?: () => void }).unref?.();
  spawnCheckpointer();
}
/** Stop the worker and its timers, and give the checkpoint back to SQLite. */
export function stopCheckpointer(): void {
  if (watchdog) clearInterval(watchdog);
  if (restartTimer) clearTimeout(restartTimer);
  watchdog = restartTimer = null;
  const w = checkpointer;
  checkpointer = null;
  w?.terminate();
  autoCheckpointOn();
}

export function reclaimFreePages(): { freed: number; ms: number } | null {
  try {
    const pageCount = Number((db.query("PRAGMA page_count").get() as { page_count?: number } | null)?.page_count ?? 0);
    const freelist = Number((db.query("PRAGMA freelist_count").get() as { freelist_count?: number } | null)?.freelist_count ?? 0);
    const pageSize = Number((db.query("PRAGMA page_size").get() as { page_size?: number } | null)?.page_size ?? 0);
    const mode = Number((db.query("PRAGMA auto_vacuum").get() as { auto_vacuum?: number } | null)?.auto_vacuum ?? 0);
    /* A file that is not yet INCREMENTAL gets its one conversion VACUUM at 10% free instead of 30%: the
       rewrite is paid once, and after it shrinkFreePages keeps the file small in 4 MB steps. Measured on
       a copy of a real 1.13 GB file (13% free, auto_vacuum off): VACUUM 14 s on a loaded machine, 1.13 GB
       -> 0.96 GB, auto_vacuum reads 2 afterwards. This runs once, at boot before the first request (index.ts),
       never during use; the ceiling is that one boot waits that long on a file this size. */
    const floor = mode === 2 ? 0.3 : 0.1;
    if (!pageCount || !pageSize || freelist / pageCount <= floor) return null;
    if (!process.env.SQLITE_TMPDIR) process.env.SQLITE_TMPDIR = dirname(DB_PATH);
    const started = Date.now();
    waitedFor("vacuum", () => db.exec("VACUUM"));
    // VACUUM just wrote the whole database through the WAL; give that back now
    // rather than waiting for the journal_size_limit to bring it down to 64 MB.
    trimWal();
    return { freed: freelist * pageSize, ms: Date.now() - started };
  } catch {
    // A vacuum that cannot run is not a reason to fail a boot: the database is
    // correct either way, and the only thing lost is disk that was already lost.
    return null;
  }
}

/** Pages one incremental step returns to the OS. Measured on a copy: 1000 pages (4 MB) took 42 ms. */
export const SHRINK_STEP_PAGES = 1000;
let shrinkTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Give freed pages back one small step at a time, with the loop free in between.
 *
 * Only on an auto_vacuum = INCREMENTAL file; on any other mode `incremental_vacuum` is a no-op and this
 * returns 0 without scheduling. Returns the pages released by this step. After a step that left more on
 * the freelist it schedules the next one a second later, so a big retention delete (100 MB is 25 steps,
 * about a second of work in total) is handed back without one long block. The timer is unref'd and
 * single: a second call while one is pending does not stack another.
 *
 * Ceiling: it releases the freelist; it does not compact a file whose live pages are scattered (that is
 * VACUUM), and a WAL write per step is left for trimWal's hourly checkpoint.
 */
export function shrinkFreePages(step = SHRINK_STEP_PAGES): number {
  try {
    const mode = Number((db.query("PRAGMA auto_vacuum").get() as { auto_vacuum?: number } | null)?.auto_vacuum ?? 0);
    if (mode !== 2) return 0;
    const before = Number((db.query("PRAGMA freelist_count").get() as { freelist_count?: number } | null)?.freelist_count ?? 0);
    if (before === 0) return 0;
    db.query(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(step))})`).all();
    const after = Number((db.query("PRAGMA freelist_count").get() as { freelist_count?: number } | null)?.freelist_count ?? 0);
    if (after > 0 && !shrinkTimer) {
      shrinkTimer = setTimeoutAs("db shrink free pages", () => { shrinkTimer = null; shrinkFreePages(step); }, 1_000);
      shrinkTimer.unref?.();
    }
    return before - after;
  } catch {
    return 0;
  }
}

/**
 * Forget the history: every event, session, roll-up day and settled gate or reminder, and the
 * settled rows of the orchestrator and the understudy.
 *
 * Settings, credentials and anything live stay where they are: a gate still waiting for an
 * answer and a reminder not yet acknowledged are requests, not history. The same tables
 * pruneOldRows empties past a cutoff, here with no cutoff and the roll-up too, because a
 * roll-up day is a summary of events that no longer exist and answering "what did this
 * cost" from it after an erase would be history that was asked to be forgotten. One
 * transaction, so a crash leaves all of it or none of it.
 */
export function eraseHistory(): { events: number; sessions: number; days: number } {
  rollupPathCache = null;
  changedPathsMemo.drop(); changeListMemo.drop();
  spendWrites++;
  promptNames.clear();
  eventEpoch++;
  sessionGens.clear();
  eventWrites++;
  const out = db.transaction(() => {
    db.run(`DELETE FROM events_fts`);
    const ev = db.run(`DELETE FROM events`);
    recorded.forget();
    facets = { all: newFacet(), byPath: new Map() };
    // A fill already running holds pre-erase values: drop it and start a fresh one.
    if (facetTimer) clearTimeout(facetTimer);
    facetTimer = null; facetsBuilding = null; facetRecountPending = false;
    startFacetFill(FACET_YIELD_MS);
    const se = db.run(`DELETE FROM sessions`);
    const days = db.run(`DELETE FROM daily_rollup`);
    db.run(`DELETE FROM gates WHERE decision IS NOT NULL`);
    db.run(`DELETE FROM reminders WHERE acked_at IS NOT NULL OR cancelled_at IS NOT NULL`);
    /* The orchestrator's and the understudy's history: the settled rows pruneOldRows ages out, with no
       cutoff. What is still waiting or live (a pending proposal, a running shift, an unanswered need, a
       live named agent, an act not undone, a decision or a refusal) is a request or a promise, not history.
       session_role stays: it marks which live session is the chair. */
    db.run(`DELETE FROM understudy_snapshots`);
    db.run(`DELETE FROM understudy_ledger WHERE kind = 'stub'`);
    db.run(`DELETE FROM understudy_proposals WHERE state <> 'pending'`);
    db.run(`DELETE FROM understudy_shifts WHERE state <> 'running'`);
    db.run(`DELETE FROM understudy_acts WHERE undone_at IS NOT NULL`);
    db.run(`DELETE FROM understudy_asked WHERE taken_at IS NOT NULL OR ('asked:' || id) IN (SELECT item_id FROM understudy_work WHERE source = 'asked')`);
    db.run(`DELETE FROM understudy_work WHERE state <> 'running'`);
    db.run(`DELETE FROM understudy_help WHERE answered_at IS NOT NULL`);
    db.run(`DELETE FROM named_agent WHERE ended_at IS NOT NULL`);
    db.run(`DELETE FROM seat_line`);
    db.run(`DELETE FROM seat_report`);
    db.run(`DELETE FROM seat_need WHERE done_at IS NOT NULL`);
    db.run(`DELETE FROM agent_schedule WHERE fired_at IS NOT NULL OR cancelled_at IS NOT NULL`);
    return { events: ev.changes, sessions: se.changes, days: days.changes };
  })();
  riskMemo.clear();
  return out;
}

/** Rows one stub sweep removes before it hands the thread back. */
export const STUB_PRUNE_CHUNK = 20_000;
/**
 * One bounded slice of the stubs older than `cut`; the caller repeats while it returns a full chunk.
 *
 * It used to be a single DELETE. A stub is written for every write request, so the ledger held 1.74M rows
 * (135 MB plus 77 MB of indexes) and the hourly sweep deleted whatever had aged past the window in one
 * statement that no other work can interleave with.
 */
export function pruneStubsChunk(cut: number, limit = STUB_PRUNE_CHUNK): number {
  return db.run(
    `DELETE FROM understudy_ledger WHERE id IN (SELECT id FROM understudy_ledger WHERE kind = 'stub' AND sealed_at < ? LIMIT ?)`,
    [cut, limit],
  ).changes;
}

export function pruneOldRows(): { events: number; sessions: number; rolled: number; snapshots: number; stubs: number } {
  const { more: _more, ...r } = pruneOldRowsNow();
  // What the deletes just freed goes back in small steps (see shrinkFreePages); a no-op unless auto_vacuum is INCREMENTAL.
  shrinkFreePages();
  return r;
}

/** Events one retention slice folds and deletes before it hands the loop back. */
export const RETENTION_CHUNK = 250;

type PruneResult = { events: number; sessions: number; rolled: number; snapshots: number; stubs: number };

/**
 * The same prune, a slice of events at a time with the loop free in between. Each slice folds and
 * deletes its own rows in one transaction, so the fold-then-delete pair stays atomic; the roll-up is
 * additive, so the sums are what one big pass writes. The other tables go on the first slice.
 */
export async function pruneOldRowsYielding(chunk = RETENTION_CHUNK): Promise<PruneResult> {
  let total: PruneResult | undefined;
  for (let first = true; ; first = false) {
    const { more, ...r } = waitedFor("retention prune slice", () => pruneOldRowsNow(chunk, first));
    total = total ? { ...total, events: total.events + r.events, sessions: total.sessions + r.sessions, rolled: total.rolled + r.rolled } : r;
    if (!more) break;
    await new Promise<void>((res) => setImmediate(res));
  }
  await slimColdEventsYielding();
  resumedAs("retention prune end");
  waitedFor("db shrink free pages", () => shrinkFreePages());
  return total!;
}

function pruneOldRowsNow(chunk = 0, first = true): PruneResult & { more: boolean } {
  let snapshots = 0, stubs = 0;
  if (first) {
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
    snapshots = db.run(`DELETE FROM understudy_snapshots WHERE at < ?`, [snapCut]).changes;
    // Stubs only. A `decision` row is the score and a `fence` row is a refusal we
    // promised to be able to show; neither has an expiry, at any age.
    const stubCut = Date.now() - UNDERSTUDY_STUB_DAYS * 86_400_000;
    stubs = pruneStubsChunk(stubCut);

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
    /* The seat's own reports. A line is what it said at the time and the view
       shows the last few; past ninety days it is a log nobody reads. Its task
       rows are NOT swept: an item still waiting is a person's intent, and a
       finished one is the record of what was asked and what came back. */
    db.run(`DELETE FROM seat_line WHERE at < ?`, [Date.now() - UNDERSTUDY_STUB_DAYS * 86_400_000]);
    /* A worker's report, kept the same ninety days as the seat's own lines: it is
       the other half of the same conversation. */
    db.run(`DELETE FROM seat_report WHERE at < ?`, [Date.now() - UNDERSTUDY_STUB_DAYS * 86_400_000]);
    /* A decision the seat asked for, ONCE IT HAS BEEN TAKEN — the same ninety
       days. One still waiting is never swept, whatever its age: an unanswered
       question that quietly disappeared is exactly the failure this table was
       built to end. */
    db.run(`DELETE FROM seat_need WHERE done_at IS NOT NULL AND done_at < ?`, [Date.now() - UNDERSTUDY_STUB_DAYS * 86_400_000]);
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
  }

  if (!RETENTION_DAYS) return { events: 0, sessions: 0, rolled: 0, snapshots, stubs, more: false };
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
    // This slice ends at the chunk-th qualifying row in index order (timestamp, id): no sort, no
    // rescan of what is left. No such row means this is the last slice.
    const hi = chunk
      ? db.query<{ timestamp: number; id: number }, [number, number]>(`SELECT timestamp, id FROM events WHERE timestamp < ? ORDER BY timestamp, id LIMIT 1 OFFSET ?`).get(cutoff, chunk - 1)
      : null;
    const hts = hi?.timestamp ?? Number.MAX_SAFE_INTEGER, hid = hi?.id ?? Number.MAX_SAFE_INTEGER;
    const rolled = foldExpiringEvents(cutoff, hts, hid);
    // The risk roll-up drops only the flags whose own edit is about to go.
    // Clearing all of it on every run, deleted or not, made the next poll
    // re-parse every listed session's whole edit history on the event loop
    // once an hour; forgetting a whole session did the same every hour to one
    // that runs longer than the retention window. Dropping a flag is exact
    // because the memo keeps the newest flag per kind and file: an older one
    // it shadowed is older still, so it is going too. Not quite for a
    // backfilled edit, which is newest by row id and oldest by time; the flag
    // it shadowed stays lost until the session is read again. A session at the
    // cap may have dropped flags this would let back in, so it is re-read.
    const expiring = new Map<string, Set<number>>();
    for (const { session_id, id } of db.query<{ session_id: string; id: number }, [number, number, number]>(
      `SELECT session_id, id FROM events
       WHERE timestamp < ? AND (timestamp, id) <= (?, ?) AND hook_event_type='PostToolUse' AND tool_name IN ('Edit','Write','MultiEdit')`).all(cutoff, hts, hid)) {
      if (!riskMemo.has(session_id)) continue;
      const g = expiring.get(session_id);
      if (g) g.add(id); else expiring.set(session_id, new Set([id]));
    }
    for (const [sid, gone] of expiring) {
      const m = riskMemo.get(sid)!;
      const kept = m.flags.filter((f) => f.change == null || !gone.has(f.change));
      if (kept.length === m.flags.length) continue;
      if (m.flags.length >= SESSION_RISK_CAP) riskMemo.delete(sid);
      else {
        m.flags = kept;
        for (const id of gone) m.where.delete(id);
      }
    }
    db.run(`DELETE FROM events_fts WHERE rowid IN (SELECT id FROM events WHERE timestamp < ? AND (timestamp, id) <= (?, ?))`, [cutoff, hts, hid]);
    const ev = db.run(`DELETE FROM events WHERE timestamp < ? AND (timestamp, id) <= (?, ?)`, [cutoff, hts, hid]);
    eventWrites++;
    changedPathsMemo.drop(); changeListMemo.drop();
    spendWrites++;
    // The slice was full: the rest of the prune, and the cache wipe, wait for the last one.
    if (hi) return { events: ev.changes, sessions: 0, rolled, snapshots, stubs, more: true };
    promptNames.clear();
    eventEpoch++;
    sessionGens.clear();
    recorded.forget();
    recountFacets();
    const se = db.run(`DELETE FROM sessions WHERE last_seen < ?`, [cutoff]);
    // Resolved gates only — a pending one is a live request, never retention's
    // business no matter how old its row looks.
    db.run(`DELETE FROM gates WHERE decision IS NOT NULL AND created < ?`, [cutoff]);
    // Acknowledged reminders age out; a live one is never retention's business
    // however old its row looks — the same ruling the gates line above makes.
    db.run(`DELETE FROM reminders WHERE (acked_at IS NOT NULL OR cancelled_at IS NOT NULL) AND due < ?`, [cutoff]);
    return { events: ev.changes, sessions: se.changes, rolled, snapshots, stubs, more: false };
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
function rollupScopeClause(scope: Scope = workspaceRoots()): { clause: string; args: string[] } {
  const roots = scopeRoots(scope);
  if (!roots.length) return { clause: "", args: [] };
  const inScope = rollupPaths().filter((p) => roots.some((r) => isWithin(p, r)));
  // Same honest answer as scopeClause: nothing folded for this project yet.
  if (!inScope.length) return { clause: " AND 0", args: [] };
  return { clause: ` AND project_path IN (${inScope.map(() => "?").join(",")})`, args: inScope };
}

/** The per-day aggregate shared by rollupDays() and dailyUsage(), so the two
 *  cannot drift into answering the same question differently. */

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
  return dailyUsageRead(db, dailyUsageCtx(), fromDay, toDay);
}
/** What dailyUsage reads from this module's state, so the reader process can be handed it. */
export function dailyUsageCtx(): DailyCtx {
  return { rollup: rollupScopeClause(), events: scopeClause() };
}

/**
 * Counts the writes that can change what `spendBetween` answers: an event
 * that carries a cost, the retention fold with its delete, and an erase. A
 * reader that kept an answer compares this (and SQLite's data_version, for a
 * write from another process) instead of summing again. Events without a
 * cost do not count, on purpose: a tool call's own Pre event lands just
 * before its gate check, and counting it would drop the answer every time.
 */
let spendWrites = 0;
/**
 * Counts every write that can change which events exist (an insert, an erase,
 * the retention delete). Like `spendEpoch` but for any event, so a reader of
 * "when did X last speak" can keep its answer until this moves.
 */
let eventWrites = 0;
export const eventsEpoch = (): string =>
  `${eventWrites}:${(db.query("PRAGMA data_version").get() as { data_version: number } | null)?.data_version ?? 0}`;
export const spendEpoch = (): string =>
  `${spendWrites}:${(db.query("PRAGMA data_version").get() as { data_version: number } | null)?.data_version ?? 0}`;

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
/** What the in-memory derived views get of every event: enough to answer "what
 *  is this session doing now", nothing that would tempt them to keep a copy. */
export type EventHook = (sessionId: string, type: string, ts: number, extra?: {
  isError: boolean; toolUseId: string | null; toolName: string | null;
  /** A Notification's kind (see notificationKind); null for news and for every other type. */
  notice: "permission" | "input" | null;
}) => void;
let eventHook: EventHook | null = null;
export function setEventHook(fn: EventHook): void { eventHook = fn; }

/** A finished Bash call, with its command: the one moment a `git push` is known
 *  to have landed. A second slot because the first takes no payload. */
let bashDoneHook: ((cwd: string, command: string) => void) | null = null;
export function setBashDoneHook(fn: (cwd: string, command: string) => void): void { bashDoneHook = fn; }

export function insertEvent(n: NormalizedEvent): InsertResult {
  const stored = slimForInsert(slimToolResponse(n.payload) ?? n.payload, n.hook_event_type) ?? slimToolResponse(n.payload) ?? n.payload ?? {};
  const model = n.model_name;
  // Every event, before any dedup/rollup below: the derived view keeps by max
  // timestamp, so replaying a duplicate or an out-of-order backfill is harmless.
  eventHook?.(n.session_id, n.hook_event_type, n.timestamp, {
    isError: !!n.is_error, toolUseId: n.tool_use_id, toolName: n.tool_name,
    notice: n.hook_event_type === "Notification" ? notificationKind(String(n.payload?.message ?? "")) : null,
  });
  if (bashDoneHook && n.hook_event_type === "PostToolUse" && n.tool_name === "Bash") {
    const cmd = (n.payload as any)?.tool_input?.command ?? (n.payload as any)?.command;
    const cwd = (n.payload as any)?.cwd ?? (n.payload as any)?.project_path;
    if (typeof cmd === "string" && typeof cwd === "string") { try { bashDoneHook(cwd, cmd); } catch { /* telemetry must not break ingest */ } }
  }

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

  const write = (): InsertResult => {
    // --- latency pairing ---------------------------------------------------
    // Inside the transaction, not before it: the claim below is a write, and
    // it has to commit or roll back with the row it is measuring (see the
    // note on the transaction call). Run here instead of ahead of it, it was
    // its own implicit transaction — a second lock wait stacked onto the
    // insert's, which is what turned one busy_timeout into two on a
    // contended database (measured: an 11.3s loop stall on a single /ingest).
    let duration_ms: number | null = null;
    if (isToolPost(n.hook_event_type)) {
      let pre: PreClaim | null = null;
      if (n.tool_use_id) pre = claimPreById.get(n.tool_use_id) ?? null;
      if (!pre && n.tool_name) {
        // Same ceiling the open-tool card uses to call a call lost.
        pre = claimPreByTool.get(n.session_id, n.tool_name, n.timestamp, n.timestamp - OPEN_TOOL_MAX_MS) ?? null;
      }
      if (pre) duration_ms = Math.max(0, n.timestamp - pre.timestamp);
      if (pre) slimPairedPre(pre, (n.payload as { tool_input?: unknown } | null)?.tool_input);
    }

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
      // Stored with its answer cut to what is read: see slimToolResponse, slimForInsert.
      $payload: JSON.stringify(stored),
      $timestamp: n.timestamp,
    }) as { id: number } | null;

    if (inserted) { eventWrites++; sessionGens.set(n.session_id, (sessionGens.get(n.session_id) ?? 0) + 1); }
    if (inserted && eventCost) spendWrites++;
    if (n.hook_event_type === "UserPromptSubmit") promptNames.delete(n.session_id);
    if (!inserted) {
      const existing = n.event_id
        ? eventByExternalId.get(n.source_app, n.session_id, n.event_id)
        : null;
      if (!existing) throw new Error("event insert returned no row");
      return duplicateResult(existing);
    }

    // Built from the values just bound, not re-read: the SELECT * plus the
    // payload parse cost a row round-trip and a 2-10 KB parse per event. The
    // generated columns (project_path, cwd_path) are what the payload says.
    const sp = stored as Record<string, unknown>;
    const event = withParsedPayload(
      {
        id: inserted.id,
        source_app: n.source_app,
        session_id: n.session_id,
        event_id: n.event_id,
        hook_event_type: n.hook_event_type,
        tool_name: n.tool_name,
        tool_use_id: n.tool_use_id,
        agent_id: n.agent_id,
        agent_type: n.agent_type,
        model_name: model,
        provider: providerOf(model),
        is_error: n.is_error ? 1 : 0,
        error_text: n.error_text,
        duration_ms,
        input_tokens: dIn,
        output_tokens: dOut,
        cache_creation_tokens: dCw,
        cache_read_tokens: dCr,
        cost_usd: eventCost,
        summary: n.summary,
        timestamp: n.timestamp,
        project_path: sp.project_path ?? null,
        cwd_path: sp.cwd ?? null,
        paired: 0,
      },
      sp
    );
    const session = upsertSession(n, dIn, dOut, dCw, dCr, eventCost, estimatedEventCost);
    return { event, session, inserted: true };
  };

  // One transaction on every path, not only the retry-key one.
  //
  // The Pre claim inside `write` is a write, and it has to commit or roll back
  // with the row it is measuring — otherwise two concurrent Posts can each
  // claim a Pre and then one of the inserts fails, leaving a Pre marked
  // answered by an event that does not exist. It also has to be in the *same*
  // transaction as the insert, which is why it is run inside `write` rather
  // than ahead of this call — see the note where it is defined. Named for the
  // loop watchdog: a database locked by the scanner's sweep or the retention
  // prune waits here through busy_timeout, and the stall should say so rather
  // than naming whatever request happened to be last.
  const result = waitedFor(`insertEvent ${n.hook_event_type}`, () => db.transaction(write)());
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
  noteFacets(n.payload?.project_path, (n.payload as { cwd?: unknown } | undefined)?.cwd, n.source_app, n.hook_event_type, n.model_name);
  // A Pre opens a call and a Post closes one, so the open-tool memo the fleet
  // draws from just went stale. Drop it here, the single write chokepoint, so
  // the next read — the push that fires right after this returns — is fresh,
  // while an idle machine with no tool traffic never invalidates and so never
  // re-runs that scoped scan on the tick.
  if (n.hook_event_type === "PreToolUse" || isToolPost(n.hook_event_type)) invalidateOpenTools();
  if (changesAffectedBy(n)) { changedPathsMemo.drop(); changeListMemo.drop(); }
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
 * body of a 30 KB file write; a session view reading a tool's real output wants a
 * preview, not a wall of text — the fold UI already collapses anything this
 * long. Capped, not dropped: unlike
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
let openToolCache: { at: number; scope: string; data: OpenToolCall[] } | null = null;

/** Drop the open-tool memo. insertEvent() calls this on a Pre/PostToolUse write
 *  so a tool that just opened or closed shows on the very next read. */
export function invalidateOpenTools(): void {
  openToolCache = null;
}

/** Currently-running tool calls across the fleet (open Pre, unpaired, session
 *  still alive) — the seed for the client's per-agent "running" state. */
export function openToolCalls(): OpenToolCall[] {
  const scope = scopeKey();
  if (openToolCache && openToolCache.scope === scope) {
    // Empty is valid until a write invalidates it; non-empty honours the TTL so
    // an age-out cannot hide behind a quiet period.
    if (openToolCache.data.length === 0 || Date.now() - openToolCache.at < OPEN_TOOL_TTL_MS) {
      return openToolCache.data;
    }
  }
  // Aliased to `p`, so the shared clause needs qualifying to stay unambiguous
  // against the correlated subqueries above.
  const s = scopeClause();
  const scoped = s.clause.replace(/\b(project_path|cwd_path)\b/g, "p.$1");
  const data = db
    .query<OpenToolCall, any[]>(openToolSql(scoped))
    .all(Date.now() - OPEN_TOOL_MAX_MS, ...s.args);
  openToolCache = { at: Date.now(), scope, data };
  return data;
}

/*
 * The facet values (source_app, hook_event_type, model_name) are a tiny set, kept per recorded path
 * (project_path and cwd_path) and overall, in memory. Nothing is indexed for them: a synchronous
 * CREATE INDEX at boot on the real 785k-row table blocks the only thread for seconds and adds ~120 MB.
 *  - fill: a background walk over id slices after boot, each slice timed and sized to stay near 25 ms,
 *    with a setTimeoutAs yield between slices (facetStats.maxMs is the proof);
 *  - insertEvent adds the row's values (noteFacets), so a new agent or model shows on its FIRST event;
 *  - retention deletes cannot remove a value from a set, so they start a recount into a fresh set
 *    (same slices) that replaces the live one when done; inserts during it go to both;
 *  - the route never scans: before the first fill it answers from what it has with `partial: true`.
 */
type Facet = { apps: Set<string>; types: Set<string>; models: Set<string> };
const newFacet = (): Facet => ({ apps: new Set(), types: new Set(), models: new Set() });
let facets = { all: newFacet(), byPath: new Map<string, Facet>() };
let facetsBuilding: typeof facets | null = null;
let facetRecountPending = false;
let facetsFilled = false;
let facetTimer: ReturnType<typeof setTimeoutAs> | null = null;
const FACET_SLICE_MS = 25, FACET_YIELD_MS = 10;
export const facetStats = { slices: 0, maxMs: 0, maxRows: 0, fills: 0, errors: 0 };
/** Test hook: make the next N slices throw; backoff base in ms. */
export const facetTest = { failSlices: 0, backoffMs: 1000 };
const FACET_MAX_ROWS = 4000; // one slice of json_extract rows must stay under FACET_SLICE_MS even on a cold disk
let facetWaiters: Array<() => void> = [];

function addFacet(t: typeof facets, paths: unknown[], app: unknown, type: unknown, model: unknown): void {
  const into = (f: Facet) => {
    if (typeof app === "string" && app) f.apps.add(app);
    if (typeof type === "string" && type) f.types.add(type);
    if (typeof model === "string" && model) f.models.add(model);
  };
  into(t.all);
  for (const p of paths) {
    if (typeof p !== "string" || !p) continue;
    let f = t.byPath.get(p);
    if (!f) t.byPath.set(p, (f = newFacet()));
    into(f);
  }
}
function noteFacets(project: unknown, cwd: unknown, app: unknown, type: unknown, model: unknown): void {
  addFacet(facets, [project, cwd], app, type, model);
  if (facetsBuilding) addFacet(facetsBuilding, [project, cwd], app, type, model);
}

/** Walk the events in id slices into a fresh set; swap it in at the end. Idempotent while one runs. */
function startFacetFill(delayMs = 0): void {
  if (facetsBuilding) return;
  facetsBuilding = { all: newFacet(), byPath: new Map() };
  let maxId = -1; // read on the first slice, not here: the fill is scheduled at module load
  const q = db.query<{ p: string | null; c: string | null; a: string; t: string; m: string | null }, [number, number]>(
    `SELECT DISTINCT project_path p, cwd_path c, source_app a, hook_event_type t, model_name m FROM events WHERE id > ? AND id <= ?`);
  // The slice's upper id is the id of the size-th row past the cursor, not cursor+size: retention leaves
  // the ids sparse (a day of Stop rows is millions of ids), and stepping ids from 0 walked every empty
  // range at one slice per 4000 ids, 10 ms of CPU each (10,078 slices, ~100 s at full CPU on a 300k-row table).
  const hiQ = db.query<{ h: number | null }, [number, number, number]>(`SELECT MAX(id) h FROM (SELECT id FROM events WHERE id > ? AND id <= ? ORDER BY id LIMIT ?)`);
  let cursor = 0, size = 100; // first slice small: the file is cold at boot and a slice that size is unmeasured
  let failures = 0;
  const step = () => {
    facetTimer = null;
    try { slice(); } catch {
      // A busy/locked DB must not wedge the fill: reset and retry with backoff.
      facetStats.errors++; failures++;
      facetsBuilding = null;
      startFacetFill(Math.min(facetTest.backoffMs * 2 ** (failures - 1), 30_000));
    }
  };
  const slice = () => {
    const t0 = performance.now();
    if (facetTest.failSlices > 0) { facetTest.failSlices--; throw new Error("facet slice test failure"); }
    if (maxId < 0) maxId = db.query<{ m: number | null }, []>("SELECT MAX(id) m FROM events").get()?.m ?? 0;
    const hi = hiQ.get(cursor, maxId, size)?.h ?? maxId; // no row left in range: the rest is empty
    for (const r of q.all(cursor, hi)) addFacet(facetsBuilding!, [r.p, r.c], r.a, r.t, r.m);
    facetStats.maxRows = Math.max(facetStats.maxRows, size);
    cursor = hi;
    const ms = performance.now() - t0;
    facetStats.slices++; facetStats.maxMs = Math.max(facetStats.maxMs, ms);
    size = ms < FACET_SLICE_MS / 2 ? Math.min(size * 2, FACET_MAX_ROWS) : ms > FACET_SLICE_MS ? Math.max(50, size >> 1) : size;
    if (cursor < maxId) { facetTimer = setTimeoutAs("boot:facets:slice", step, FACET_YIELD_MS); (facetTimer as { unref?: () => void }).unref?.(); return; }
    facets = facetsBuilding!; facetsBuilding = null; facetsFilled = true; facetStats.fills++;
    const w = facetWaiters; facetWaiters = []; for (const f of w) f();
    // Retention deleted rows while this fill ran: it had already read them, so count again.
    if (facetRecountPending) { facetRecountPending = false; startFacetFill(FACET_YIELD_MS); }
  };
  facetTimer = setTimeoutAs("boot:facets:slice", step, delayMs);
  (facetTimer as { unref?: () => void }).unref?.();
}
/** Retention deleted rows: a value may be gone, so recount in the background. */
function recountFacets(): void {
  // A fill running now has read rows that are gone: it cannot see the delete, so it recounts when it ends.
  if (facetsBuilding) { facetRecountPending = true; return; }
  startFacetFill(FACET_YIELD_MS);
}
/** Resolves once the next fill (first or recount) has been swapped in. */
export function whenFacetsFilled(): Promise<void> {
  return facetsFilled && !facetsBuilding ? Promise.resolve() : new Promise((r) => facetWaiters.push(r));
}
startFacetFill(250); // after boot, off the module-load path
/** For the tests: forget the facet set as a fresh boot would, and schedule the first fill `delayMs` from now.
 *  `bun test` runs every file in one process, so the set, the timer and the filled flag outlive the file. */
export function __resetFacets(delayMs = 250): void {
  if (facetTimer) clearTimeout(facetTimer);
  facetTimer = null; facetsBuilding = null; facetsFilled = false; facetRecountPending = false;
  facets = { all: newFacet(), byPath: new Map() };
  facetTest.failSlices = 0; facetTest.backoffMs = 1000;
  startFacetFill(delayMs);
}

export function getFilterOptions(): { source_apps: string[]; hook_event_types: string[]; models: string[]; partial?: true } {
  // Scoped too, or the dropdowns keep offering apps and models that the feed behind them can no
  // longer show. scopeClause's args are [...paths, ...paths]; unscoped has no clause.
  const s = scopeClause();
  let apps: Set<string>, types: Set<string>, models: Set<string>;
  if (!s.clause) ({ apps, types, models } = facets.all);
  else {
    apps = new Set(); types = new Set(); models = new Set();
    for (const p of s.args.slice(0, s.args.length / 2)) {
      const f = facets.byPath.get(p);
      if (f) { f.apps.forEach((x) => apps.add(x)); f.types.forEach((x) => types.add(x)); f.models.forEach((x) => models.add(x)); }
    }
  }
  const sorted = (x: Set<string>) => [...x].sort();
  const out = { source_apps: sorted(apps), hook_event_types: sorted(types), models: sorted(models) };
  return facetsFilled ? out : { ...out, partial: true };
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
  // A session's first prompt never changes once it is in, so a found one is
  // kept: the list asks again on every poll, and re-reading the prompt
  // payloads of a hundred sessions each time was cold disk work on the
  // server's only thread after every restart.
  const want: string[] = [];
  for (const id of ids) {
    const p = firstPromptMemo.get(id);
    if (p !== undefined) out.set(id, p); else want.push(id);
  }
  if (!want.length) return out;
  const holes = want.map(() => "?").join(",");
  for (const r of db.query<{ session_id: string; payload: string }, string[]>(
    `SELECT session_id, substr(payload, 1, ${FIRST_PROMPT_CHARS}) AS payload, MIN(timestamp) FROM events
     WHERE hook_event_type = 'UserPromptSubmit' AND session_id IN (${holes})
     GROUP BY session_id`).all(...want)) {
    try {
      const p = promptOfPayloadHead(r.payload);
      if (typeof p === "string" && p.trim()) {
        out.set(r.session_id, p);
        if (firstPromptMemo.size >= FIRST_PROMPT_MEMO_MAX) firstPromptMemo.delete(firstPromptMemo.keys().next().value!);
        firstPromptMemo.set(r.session_id, p);
      }
    } catch { /* a payload we cannot read is not a name */ }
  }
  return out;
}
/* The caller takes the first plain line of the prompt and clips it to 60
   characters (shared/sessionTitle.ts: promptTitle, clipTitle). The hook
   envelope before the prompt is a few hundred characters, so 4096 leaves
   ~3.5 K of prompt to find that line past a short fence or quote. A prompt
   that opens with more than that of fenced text has no title, as before for
   an unreadable payload; the old read pulled the whole payload (hundreds of
   KB, cold disk) on the loop to say the same thing. */
const FIRST_PROMPT_CHARS = 4096;
/** The prompt out of a payload that may have been cut: whole JSON parses as
 *  before; a cut one gives the part of the prompt string that survived. */
function promptOfPayloadHead(head: string): unknown {
  try { return JSON.parse(head)?.prompt; } catch { /* cut: read the string by hand */ }
  const m = /"prompt"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(head);
  if (!m) return undefined;
  // A cut can leave a lone backslash or half a \uXXXX at the end.
  const body = m[1].replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, "");
  return JSON.parse(`"${body}"`);
}
const firstPromptMemo = new Map<string, string>();
const FIRST_PROMPT_MEMO_MAX = 2000;

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
  /*
   * A QUESTION ABOUT A SCREENSHOT IS NOT A NAME.
   *
   * These three were on the Lantern, as the titles of three cards:
   *
   *   a line that is only a question mark and two attachments
   *   a pasted transcript whose first line happens to be a sentence
   *   a request that runs past the width and is cut off mid-word
   *
   * The first is a person pointing at a picture — the picture carried the
   * subject and the words carried none of it. The second is a pasted
   * transcript, whose first line happens to be a sentence. The third is a
   * sentence long enough that the eighty characters it is cut to end
   * mid-clause. All three are what somebody typed; none is what anybody would
   * call the session, and a grid of cards is read by its titles.
   *
   * The pane id is the fallback, and it is the better answer here: "%44" says
   * "this session has not named itself", which is true and short. A bad name
   * says something false at the width of a card.
   */
  if (/\[Image #\d+\]|\bimage-cache\b|<system-reminder|```/i.test(t)) return false;
  /* A paragraph is not a title: a name that has to be cut mid-word is one the
     eye cannot use, and every session has a pane id that fits. */
  if (t.length > 120) return false;
  /* Three words of actual words. "esto?" and "mira esto" name nothing. */
  if (t.split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w)).length < 3) return false;
  return true;
}

/**
 * The name found for a session with no title, kept until its prompts change.
 *
 * The Lantern asks for these on every `GET /agents/board`, which the rail
 * polls every 5 to 20 s for as long as the app is open. For each untitled
 * session the query read EVERY prompt the session ever had, payload and all,
 * to look at the first six: a long-running session holds hundreds, some with
 * pasted text in them. Measured on the installed app: "event loop blocked
 * 4516 ms by GET /agents/board, waiting", 981,584 blocks (about 480 MB) read
 * back from disk and 1,979 ms of CPU, in one request. Two changes: the query
 * stops at six rows per session (idx_events_first_prompt gives them in
 * order), and the answer is kept. It can only change when a prompt of that
 * session is written (dropped in insertEvent) or rows are removed (cleared by
 * the retention pass and by an erase), so what is kept is what a fresh read
 * would say. "" is kept too: no name yet is an answer.
 */
const promptNames = new Map<string, string>();
const PROMPT_NAMES_MAX = 2000;
/** Reads that went to the table, for the test that counts them. */
export let promptNameReads = 0;
const firstSixPrompts = db.query<{ payload: string }, [string]>(
  `SELECT payload FROM events
    WHERE hook_event_type = 'UserPromptSubmit' AND session_id = ?
    ORDER BY timestamp ASC, id ASC LIMIT 6`);

/**
 * The first prompt a person could recognise the session by, per session.
 *
 * `firstPrompts` above takes the earliest prompt and is what the sessions page
 * shows; this walks the first few and skips the ones that are not a name.
 * Trimmed to one line of the width a row has.
 */
function firstDecentPrompts(ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of ids) {
    let name = promptNames.get(id);
    if (name === undefined) {
      name = "";
      promptNameReads++;
      // Six prompts in and still nothing to call it: the pane id will do.
      for (const r of firstSixPrompts.all(id)) {
        let p = "";
        try { p = String(JSON.parse(r.payload)?.prompt ?? ""); } catch { continue; }
        if (!decentPrompt(p)) continue;
        name = p.replace(/\s+/g, " ").trim().slice(0, 80);
        break;
      }
      if (promptNames.size >= PROMPT_NAMES_MAX) promptNames.delete(promptNames.keys().next().value!);
      promptNames.set(id, name);
    }
    if (name) out.set(id, name);
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
/**
 * HOW THE LANTERN'S AND THE SEAT'S CHATS FROM BEFORE THE ROLE EXISTED ARE FOUND.
 *
 * It was `SELECT DISTINCT session_id ... payload LIKE '%mark%'`, run by the first
 * `isLanternSession` call, which is the first POST /ingest after a start: every
 * UserPromptSubmit payload on the file read from disk inside that request
 * (measured on a 785k-row, 1.6 GB copy with the page cache evicted: 2.4 s of the
 * 3.1 s first ingest, ~190 MB read). Now: once per database (`boot_once`), in the
 * background, one session at a time. A session's first prompt is one seek on
 * idx_events_first_prompt and one row, so the work follows the number of sessions
 * and not the size of the table, and each slice yields after ~25 ms.
 *
 * Whatever a hook says about a NEW chat (hookSaysLantern / hookSaysSeat) is
 * unchanged and persists its role at once; only chats that predate roles wait
 * for this walk, a few seconds after a start, one time.
 */
db.exec(`CREATE TABLE IF NOT EXISTS boot_once (name TEXT PRIMARY KEY, at INTEGER NOT NULL)`);
const firstPromptOf = db.query<{ prompt: string | null }, [string]>(
  `SELECT json_extract(payload, '$.prompt') AS prompt FROM events
    WHERE hook_event_type = 'UserPromptSubmit' AND session_id = ? ORDER BY timestamp LIMIT 1`);
const sessionIdsAfter = db.query<{ session_id: string }, [string, number]>(
  `SELECT session_id FROM sessions WHERE session_id > ? ORDER BY session_id LIMIT ?`);
export const legacyScanStats = { slices: 0, maxMs: 0, sessions: 0 };
/** Test hook: how long before the first slice, the slice budget, the wait before a retry. */
export const legacyScanTest = { delayMs: 3000, budgetMs: 25, retryMs: 1000 };
const LEGACY_SCAN_RETRIES = 5;
export function scheduleLegacyPromptScan(name: string, mark: string, found: (sessionId: string) => void): void {
  const done = () => { try { return db.query("SELECT 1 FROM boot_once WHERE name = ?").get(name) !== null; } catch { return true; } };
  let cursor = "";
  let failures = 0;
  const later = (ms: number): void => { const t = setTimeoutAs(`boot:${name}:slice`, step, ms); (t as { unref?: () => void }).unref?.(); };
  function step(): void {
    const t0 = performance.now();
    let delay = 10;
    try {
      if (cursor === "" && done()) return;
      // The budget is checked after EACH session: one first prompt can be hundreds of KB to parse.
      let finished = false;
      while (!finished) { // at least one session per slice, so a tiny budget still makes progress
        const ids = sessionIdsAfter.all(cursor, 20);
        if (ids.length === 0) { db.query("INSERT OR REPLACE INTO boot_once (name, at) VALUES (?, ?)").run(name, Date.now()); return; }
        for (const { session_id } of ids) {
          legacyScanStats.sessions++;
          const prompt = firstPromptOf.get(session_id)?.prompt;
          if (typeof prompt === "string" && prompt.trimStart().startsWith(mark)) found(session_id);
          cursor = session_id;
          if (performance.now() - t0 >= legacyScanTest.budgetMs) { finished = true; break; }
        }
      }
      failures = 0;
    } catch (e) {
      // A transient BUSY must not end the walk: the slice is retried from the same cursor, a few times.
      if (++failures > LEGACY_SCAN_RETRIES) { console.warn(`[boot:${name}] legacy scan gave up after ${LEGACY_SCAN_RETRIES} retries; it runs again at the next start`, e); return; }
      console.warn(`[boot:${name}] legacy scan slice failed (retry ${failures}/${LEGACY_SCAN_RETRIES})`, e);
      delay = legacyScanTest.retryMs;
    }
    legacyScanStats.slices++; legacyScanStats.maxMs = Math.max(legacyScanStats.maxMs, performance.now() - t0);
    later(delay);
  }
  later(legacyScanTest.delayMs);
}

/**
 * Was this text ever typed at the session as a prompt?
 *
 * Asked by the tmux restore about the arguments of a running `claude`: a
 * prompt given on the command line arrives through the same UserPromptSubmit
 * hook as one typed at the box, so the events table can say which of a
 * process's arguments is the prompt and which is a flag's value — exactly,
 * with no list of flags to keep up to date. One indexed lookup per candidate.
 */
const promptSeen = db.query<{ one: number }, [string, number, string]>(
  `SELECT 1 AS one FROM events WHERE session_id = ? AND timestamp >= ? AND hook_event_type = 'UserPromptSubmit' AND json_extract(payload, '$.prompt') = ? LIMIT 1`);
/** `sinceMs`: see `wasPromptAnywhere` — a resumed conversation carries its
 *  whole history, and a flag's value typed there once as an answer is not a
 *  prompt on this process's command line. */
export function wasPromptOf(sessionId: string, text: string, sinceMs = 0): boolean {
  if (!sessionId || !text) return false;
  try { return promptSeen.get(sessionId, Math.max(0, sinceMs), text) !== null; } catch { return false; }
}

/**
 * The same question of every session, for when the pane's conversation is not
 * the one the prompt was given to: `/clear` starts a new session in the same
 * pane, and the argument on the command line was submitted to the old one.
 *
 * SINCE A MOMENT, and the caller gives the moment the process was born. Asked
 * of everything ever, the question matched a flag's VALUE — `--model opus`,
 * with "opus" typed as a prompt in some session weeks ago; prompts of one
 * word are in this table — and the value was dropped from the flags, so the
 * resume line read `claude --model --resume <id>`: the flag eats the id, and
 * the id becomes a positional prompt. A prompt on this process's command line
 * was submitted after this process started, so nothing older can be it. Zero
 * asks of everything, for a machine that cannot say when a process started.
 *
 * Not cheap: with no statistics the planner walks every UserPromptSubmit row
 * (idx_events_type) and extracts each payload's prompt, tens of milliseconds
 * on a large table. The caller asks again only when a prompt has arrived
 * since it last asked (`newestPromptId`).
 */
const promptSeenSince = db.query<{ one: number }, [number, string]>(
  `SELECT 1 AS one FROM events WHERE timestamp >= ? AND hook_event_type = 'UserPromptSubmit' AND json_extract(payload, '$.prompt') = ? LIMIT 1`);
export function wasPromptAnywhere(text: string, sinceMs = 0): boolean {
  if (!text) return false;
  try { return promptSeenSince.get(Math.max(0, sinceMs), text) !== null; } catch { return false; }
}

/** The row id of the newest prompt recorded, or 0: an answer about prompts
 *  can only change when this does. One step down idx_events_type. */
const newestPrompt = db.query<{ id: number | null }, []>(
  `SELECT MAX(id) AS id FROM events WHERE hook_event_type = 'UserPromptSubmit'`);
export function newestPromptId(): number {
  try { return newestPrompt.get()?.id ?? 0; } catch { return 0; }
}

/** The first prompt this conversation was sent since a moment, or "": the
 *  one a command line carries, when it carried one. idx_events_first_prompt
 *  to the row, then its payload. */
const firstPromptSinceQ = db.query<{ prompt: string | null }, [string, number]>(
  `SELECT json_extract(payload, '$.prompt') AS prompt FROM events WHERE hook_event_type = 'UserPromptSubmit' AND session_id = ? AND timestamp >= ? ORDER BY timestamp LIMIT 1`);
export function firstPromptSince(sessionId: string, sinceMs = 0): string {
  if (!sessionId) return "";
  try { return firstPromptSinceQ.get(sessionId, Math.max(0, sinceMs))?.prompt ?? ""; } catch { return ""; }
}

/** Has this conversation been sent any prompt since a moment? A covering
 *  lookup on idx_events_first_prompt. */
const promptedSinceQ = db.query<{ one: number }, [string, number]>(
  `SELECT 1 AS one FROM events WHERE hook_event_type = 'UserPromptSubmit' AND session_id = ? AND timestamp >= ? LIMIT 1`);
export function promptedSince(sessionId: string, sinceMs = 0): boolean {
  if (!sessionId) return false;
  try { return promptedSinceQ.get(sessionId, Math.max(0, sinceMs)) !== null; } catch { return false; }
}

/** Which of the two kinds of stop a Notification's message describes — a
 *  blockage ("needs your permission"), a turn that ended ("waiting for your
 *  input") — or null for news. See noteWaitFromHook. */
export function notificationKind(message: string): "permission" | "input" | null {
  return /needs your (permission|approval)/i.test(message) ? "permission"
    : /waiting for your input/i.test(message) ? "input"
      : null;
}

export function noteWaitFromHook(e: { session_id?: unknown; hook_event_type?: unknown; payload?: unknown; role?: unknown }, at = Date.now()): void {
  /* The Lantern's own chat never waits on anybody in the board's sense: a
     person asked it something and it answered. Its notifications are dropped
     here, and any wait it once recorded is cleared. */
  if (e.role === "lantern") {
    if (typeof e.session_id === "string" && e.session_id) clearWait(e.session_id);
    return;
  }
  const session = typeof e.session_id === "string" ? e.session_id : "";
  if (!session || session === "unknown") return;
  if (e.hook_event_type === "Notification") {
    const msg = String((e.payload as { message?: unknown } | undefined)?.message ?? "");
    const kind = notificationKind(msg);
    if (!kind) return;
    try {
      waitingSessions().add(session);
      db.query("INSERT OR REPLACE INTO session_wait (session_id, kind, why, at) VALUES (?, ?, ?, ?)")
        .run(session, kind, msg.replace(/\s+/g, " ").trim().slice(0, 160), at);
    } catch { /* the board says a little less; the event still lands */ }
    return;
  }
  clearWait(session);
}

/*
 * WHO HAS A ROW IN session_wait, KEPT IN MEMORY SO "NOBODY" COSTS NOTHING.
 *
 * Anything a session does after a wait clears the wait, so every hook event
 * that is not a wait-shaped notification ran a DELETE: a write transaction on
 * the server's only thread, per event, two events per tool call, that removed
 * no row nearly every time (a session waits a few times an hour and works the
 * rest). The set is read from the table once and kept in step by the two
 * writers above, which are the only ones; `waitDeletes` counts the statements
 * that really ran, for the test.
 *
 * The ceiling: a row another process puts in this table is not seen here, so
 * this process would not clear it. Nothing else writes the table today (the
 * hooks of a machine post to one server), so this names a limit, not a known
 * case.
 */
let waiting: Set<string> | null = null;
export let waitDeletes = 0;
function waitingSessions(): Set<string> {
  if (!waiting) {
    waiting = new Set();
    try { for (const r of db.query<{ session_id: string }, []>("SELECT session_id FROM session_wait").all()) waiting.add(r.session_id); } catch { /* an empty set only skips a delete */ }
  }
  return waiting;
}
function clearWait(session: string): void {
  const set = waitingSessions();
  if (!set.has(session)) return;
  set.delete(session);
  waitDeletes++;
  try { db.query("DELETE FROM session_wait WHERE session_id = ?").run(session); } catch { /* the board says a little less; the event still lands */ }
}
/** For the tests: read the table again at the next event. */
export function __forgetWaits(): void { waiting = null; }

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
  const key = `${limit}|${provider ?? ""}|${scopeKey()}`;
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
  // A list that left sessions for the warm turns is not kept: the next poll
  // reads it again and finds their flags.
  if (attachRisks(data, RISK_WARM_BATCH) === 0) sessionsCache.set(key, { at: Date.now(), data });
  // One entry per (limit, provider, scope); the limit set is tiny and scope
  // rarely changes, so prune stale entries anyway so a long-lived server cannot
  // leak.
  if (sessionsCache.size > 64) for (const [k, v] of sessionsCache) if (Date.now() - v.at >= SESSIONS_TTL_MS) sessionsCache.delete(k);
  return data;
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
  const key = `${windowMs}|${provider ?? ""}|${scopeKey()}|${tz ?? ""}`;
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
  return statsSummaryRead(db, statsCtx(provider), windowMs, tz);
}
/** What statsSummary and skillUsageDetail read from this module's state and the clock. */
export function statsCtx(provider?: string | null): StatsCtx {
  return { now: Date.now(), provider: providerScope(provider), events: scopeClause(), zone: serverZone() };
}

/**
 * statsSummary with the computation done somewhere else when `via` answers.
 *
 * Same key, same one-second memo and same result as the sync function; only
 * where the queries run differs. `via` answering null (reader off, down, slow
 * or in error) is today's path on this thread.
 */
export async function statsSummaryAsync(via: ReadVia, windowMs = 24 * 3600 * 1000, provider?: string, tz?: string): Promise<StatsSummary> {
  const key = `${windowMs}|${provider ?? ""}|${scopeKey()}|${tz ?? ""}`;
  const hit = statsCache.get(key);
  if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.data;
  const remote = (await via("statsSummary", statsCtx(provider), [windowMs, tz ?? null])) as StatsSummary | null;
  const data = remote ?? computeStatsSummary(windowMs, provider, tz);
  statsCache.set(key, { at: Date.now(), data });
  if (statsCache.size > 64) for (const [k, v] of statsCache) if (Date.now() - v.at >= STATS_TTL_MS) statsCache.delete(k);
  return data;
}

/** One of READS on this module's own connection: the answer the reader's must equal, to the byte. */
export function readHere(fn: ReadName, ctx: unknown, args: unknown[]): unknown {
  return READS[fn](db, ctx, args);
}

/** dailyUsage, computed somewhere else when `via` answers; null from it is today's path. */
export async function dailyUsageAsync(via: ReadVia, fromDay?: string, toDay?: string): Promise<UsageDay[]> {
  const remote = (await via("dailyUsage", dailyUsageCtx(), [fromDay ?? null, toDay ?? null])) as UsageDay[] | null;
  return remote ?? dailyUsage(fromDay, toDay);
}

/**
 * Per-skill usage detail: run counts, last-used, activity buckets, and an
 * ATTRIBUTED cost — every cost-bearing event in a session is charged to the
 * most recent skill invocation at/before it in that session (until the next
 * skill starts). An approximation, but a useful one: it answers "what does
 * running /code-review actually cost?".
 */
export function skillUsageDetail(since = 0, bucketCount = 12, provider?: string): SkillUsage[] {
  return skillUsageRead(db, statsCtx(provider), since, bucketCount);
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

function parseChange(r: ChangeRow, withRisks = true): import("../../shared/types.ts").FileChange | null {
  let payload: any;
  try { payload = JSON.parse(r.payload); } catch { return null; }
  const tr = payload.tool_response ?? {};
  const ti = payload.tool_input ?? {};
  const file_path = tr.filePath || ti.file_path || ti.filePath || "(unknown)";
  let hunks = Array.isArray(tr.structuredPatch) ? tr.structuredPatch : [];
  // A rebuilt Edit hunk starts at line 1 of its own snippet, not of the file.
  let placed = true;
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
    placed = false;
  }
  if (!hunks.length && r.tool_name === "MultiEdit" && Array.isArray(ti.edits)) {
    hunks = ti.edits
      .filter((e: any) => e && typeof e.old_string === "string")
      .map((e: any) => editHunk(e.old_string, e.new_string));
    placed = false;
  }
  if (!hunks.length) return null;
  let additions = 0, deletions = 0;
  for (const h of hunks) for (const l of h.lines ?? []) {
    if (l[0] === "+") additions++;
    else if (l[0] === "-") deletions++;
  }
  const root = payload.cwd || payload.cwd_path || payload.project_path || null;
  const risks = withRisks ? changeRisks(file_path, hunks, deletions, { root, lines: placed }) : [];
  return { id: r.id, timestamp: r.timestamp, source_app: r.source_app, session_id: r.session_id, tool: r.tool_name, file_path, additions, deletions, hunks, ...(risks.length ? { risks } : {}) };
}

/**
 * Per session: how far into `events` its flags have been read, and the flags.
 *
 * The session list is polled every few seconds and re-parsing every edit of
 * every listed session on each poll would make it the most expensive query on
 * the dashboard, for a fact that only changes when an edit lands. So each read
 * parses only the edits past the watermark. The watermark is a row id, not a
 * timestamp: a backfill inserts old edits late, and those must still count.
 *
 * The card counts only edits inside the open project, like the change list its
 * diff shows, and that is applied when the flags are handed out, not when they
 * are read: the project's checkouts come from `git worktree list`, cached for
 * seconds, and an edit in a worktree added a moment ago was passed over while
 * the list was stale and then never read again, because the watermark had moved
 * past it. So the memo keeps every flag with where its edit ran.
 *
 * Its ceilings: the first poll after the server starts reads at most
 * RISK_WARM_BATCH sessions from 0 and leaves the rest to the warm turns, so
 * those carry no flag for a poll or two. The per-session cap applies before the scope, so a
 * session with more than SESSION_RISK_CAP flagged files outside the project can
 * crowd out one inside it.
 */
type RiskWhere = { project_path: string | null; cwd_path: string | null };
const riskMemo = new Map<string, { through: number; flags: import("../../shared/types.ts").SessionRisk[]; where: Map<number, RiskWhere> }>();
const RISK_MEMO_MAX = 2000;

/** Sessions read per turn of the loop while the flags are warmed after a start.
 *  Measured at boot on a copy of the live DB (173k events): one turn of 20 sessions
 *  blocked the loop 1,103 ms, between the listener binding (~0.8 s) and the first
 *  /health answer (1.9 s). 5 keeps each turn near 275 ms. */
export const RISK_WARM_BATCH = 5;
/** The wait before the first warm turn: past first paint, so boot answers /health
 *  and the first poll before this read starts. A list asked for sooner still reads
 *  what is owed (attachRisks), as before. */
export const RISK_WARM_START_MS = 3000;
const riskWarmQueue = new Set<string>();
let riskWarmTimer: ReturnType<typeof setTimeout> | null = null;
/** Sessions read from nothing so far, for the test that counts them. */
export let riskColdReads = 0;

/**
 * Read the flags of the newest sessions before anybody asks for the list.
 *
 * The first `GET /sessions` after a start found every listed session at
 * watermark 0, and read and JSON-parsed every edit each one ever made in a
 * single call: measured on the installed app two seconds after a boot, "event
 * loop blocked 427 ms by GET /sessions, computing", 411 ms of it CPU. That is
 * the ceiling the comment above names. The work is the same; it is done here
 * instead, RISK_WARM_BATCH sessions per turn with the loop free in between,
 * starting when the server does. `attachRisks` is unchanged: a list asked for
 * before this has finished still reads whatever is left in line, so no
 * answer ever lacks a flag; it is only shorter work the later it comes.
 * Ceiling: a list asked for in the first instant still pays for what is not
 * warm yet, and sessions beyond `limit` are read when first listed, as before.
 */
export function warmSessionRisks(limit = 100, startMs = RISK_WARM_START_MS): void {
  try {
    for (const r of db.query<{ session_id: string }, [number]>(`SELECT session_id FROM sessions ORDER BY last_seen DESC LIMIT ?`).all(limit)) {
      if (!riskMemo.has(r.session_id)) riskWarmQueue.add(r.session_id);
    }
  } catch { return; }
  scheduleRiskWarm(startMs);
}
/** Start the warm turns over whatever is in line, unless they are already running. */
function scheduleRiskWarm(startMs: number): void {
  if (riskWarmTimer || !riskWarmQueue.size) return;
  const step = () => {
    riskWarmTimer = null;
    const batch = [...riskWarmQueue].slice(0, RISK_WARM_BATCH);
    for (const id of batch) riskWarmQueue.delete(id);
    if (batch.length) attachRisks(batch.map((session_id) => ({ session_id }) as import("../../shared/types.ts").SessionRollup), Infinity, RISK_WARM_SPAN);
    if (riskWarmQueue.size) { riskWarmTimer = setTimeoutAs("boot:session-risk-warm:step", step, 20); (riskWarmTimer as { unref?: () => void }).unref?.(); }
  };
  riskWarmTimer = setTimeoutAs("boot:session-risk-warm:step", step, startMs);
  (riskWarmTimer as { unref?: () => void }).unref?.();
}
/**
 * The one-time pass that takes the two repeats out of rows stored before ingest
 * stopped writing them (see payloadslim.ts): a Pre's input already on its Post,
 * and a `usage.iterations` that copies its own usage.
 *
 * Resumable: `events_slim_pass` holds the last id done and the newest id that
 * existed when the pass began (rows after it were written slim). A step reads a
 * window of SLIM_PASS_WINDOW ids, rewrites the rows it changes and moves the mark,
 * in one transaction, so a quit between steps loses nothing and redoes nothing.
 * No table is dropped: the test database is shared and other code counts rows.
 * The space comes back through shrinkFreePages after the last step.
 */
export const SLIM_PASS_WINDOW = 500;
db.exec(`CREATE TABLE IF NOT EXISTS events_slim_pass (
  k INTEGER PRIMARY KEY CHECK (k = 1),
  last_id INTEGER NOT NULL,
  top_id INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
)`);
const slimPassState = db.query<{ last_id: number; top_id: number; done: number }, []>(
  `SELECT last_id, top_id, done FROM events_slim_pass WHERE k = 1`);
const slimPassRows = db.query<{ id: number; hook_event_type: string; session_id: string; tool_use_id: string | null; payload: string }, [number, number]>(
  `SELECT id, hook_event_type, session_id, tool_use_id, payload FROM events
    WHERE id > ? AND id <= ?
      AND (hook_event_type = 'PreToolUse' OR instr(payload, '"iterations":[') > 0)`);
const slimPassPost = db.query<{ ti: string | null }, [string, string]>(
  `SELECT json_extract(payload, '$.tool_input') AS ti FROM events
    WHERE tool_use_id = ? AND session_id = ? AND hook_event_type IN ('PostToolUse','PostToolUseFailure')
    ORDER BY id LIMIT 1`);
const slimPassWrite = db.query<unknown, [string, number]>(`UPDATE events SET payload = ? WHERE id = ?`);

/** One window of the pass. Returns true while more is owed.
 *  The mark is read inside an IMMEDIATE transaction, so a second server on the
 *  same file waits for the write lock and then sees the mark this one moved,
 *  instead of redoing a window from a mark it read before the lock. */
export function slimOldEventsStep(window = SLIM_PASS_WINDOW): boolean {
  const state = db.transaction((): "done" | "last" | "more" => {
    let st = slimPassState.get();
    if (!st) {
      const top = (db.query(`SELECT COALESCE(MAX(id), 0) AS m FROM events`).get() as { m: number }).m;
      db.run(`INSERT OR IGNORE INTO events_slim_pass (k, last_id, top_id, done) VALUES (1, 0, ?, 0)`, [top]);
      st = slimPassState.get()!;
    }
    if (st.done) return "done";
    const from = st.last_id, to = Math.min(st.top_id, st.last_id + Math.max(1, window));
    for (const r of slimPassRows.all(from, to)) {
      let p: Record<string, unknown>;
      try { p = JSON.parse(r.payload); } catch { continue; }
      if (!p || typeof p !== "object") continue;
      let changed = dropRepeatedIterations(p);
      if (r.hook_event_type === "PreToolUse" && r.tool_use_id && p.tool_input_slim !== true) {
        const post = slimPassPost.get(r.tool_use_id, r.session_id);
        let postInput: unknown = null;
        try { postInput = post?.ti ? JSON.parse(post.ti) : null; } catch { /* leave the Pre whole */ }
        const slim = postInput && sameInput(p.tool_input, postInput) ? slimToolInput(p.tool_input) : null;
        if (slim) { p.tool_input = slim; p.tool_input_slim = true; changed = true; }
      }
      if (changed) slimPassWrite.run(JSON.stringify(p), r.id);
    }
    db.run(`UPDATE events_slim_pass SET last_id = ?, done = ? WHERE k = 1`, [to, to >= st.top_id ? 1 : 0]);
    return to >= st.top_id ? "last" : "more";
  }).immediate();
  if (state === "last") shrinkFreePages();
  return state === "more";
}

/** For the tests, on a shared database: aim the pass at their own id range. */
export function __setSlimPass(lastId: number, topId: number): void {
  db.run(`INSERT OR REPLACE INTO events_slim_pass (k, last_id, top_id, done) VALUES (1, ?, ?, 0)`, [lastId, topId]);
}

/**
 * The same cut for rows stored before slimToolResponse ran at insert.
 *
 * Its own resumable mark, `events_resp_pass`, shaped like events_slim_pass: the
 * slim pass may already be done on a database, and this one still owes every
 * row. A window reads only rows whose payload is long enough to hold something
 * to cut and names a tool_response, so a window of short rows costs no parse.
 * It runs once over the table, behind the slim pass on the same timer; rows
 * written after it began were stored cut.
 */
db.exec(`CREATE TABLE IF NOT EXISTS events_resp_pass (
  k INTEGER PRIMARY KEY CHECK (k = 1),
  last_id INTEGER NOT NULL,
  top_id INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
)`);
const respPassState = db.query<{ last_id: number; top_id: number; done: number }, []>(
  `SELECT last_id, top_id, done FROM events_resp_pass WHERE k = 1`);
const respPassRows = db.query<{ id: number; payload: string }, [number, number, number]>(
  `SELECT id, payload FROM events
    WHERE id > ? AND id <= ? AND length(payload) > ? AND instr(payload, '"tool_response"') > 0`);

/** One window of the response pass. Returns true while more is owed. */
export function slimOldResponsesStep(window = SLIM_PASS_WINDOW): boolean {
  const state = db.transaction((): "done" | "last" | "more" => {
    let st = respPassState.get();
    if (!st) {
      const top = (db.query(`SELECT COALESCE(MAX(id), 0) AS m FROM events`).get() as { m: number }).m;
      db.run(`INSERT OR IGNORE INTO events_resp_pass (k, last_id, top_id, done) VALUES (1, 0, ?, 0)`, [top]);
      st = respPassState.get()!;
    }
    if (st.done) return "done";
    const from = st.last_id, to = Math.min(st.top_id, st.last_id + Math.max(1, window));
    for (const r of respPassRows.all(from, to, RESPONSE_CAP)) {
      let p: Record<string, unknown>;
      try { p = JSON.parse(r.payload); } catch { continue; }
      if (!p || typeof p !== "object") continue;
      const slim = slimToolResponse(p);
      if (slim) slimPassWrite.run(JSON.stringify(slim), r.id);
    }
    db.run(`UPDATE events_resp_pass SET last_id = ?, done = ? WHERE k = 1`, [to, to >= st.top_id ? 1 : 0]);
    return to >= st.top_id ? "last" : "more";
  }).immediate();
  if (state === "last") { shrinkFreePages(); changedPathsMemo.drop(); changeListMemo.drop(); }
  return state === "more";
}

/** For the tests, on a shared database: aim the response pass at their own id range. */
export function __setRespPass(lastId: number, topId: number): void {
  db.run(`INSERT OR REPLACE INTO events_resp_pass (k, last_id, top_id, done) VALUES (1, ?, ?, 0)`, [lastId, topId]);
}

/**
 * The cut for events past the hot window (see slimColdEvent), a slice at a time.
 *
 * Unlike the two one-shot passes above, rows go cold as the clock moves, so this
 * one keeps a cursor, `events_cold_pass.last_id`, and walks ids upward until it
 * meets a row still inside the window. Events are written in id order and stamped
 * at write time, so that row is the edge; a row re-inserted out of order behind
 * the cursor keeps its fat payload until retention takes it. One slice is its own
 * short transaction (COLD_SLICE rows read, the changed ones rewritten); the caller
 * hands the loop back between slices. Never a VACUUM: the freed pages go back
 * through shrinkFreePages in small steps.
 */
export const COLD_SLICE = 200;
/** Payload bytes one slice reads before it stops: a row count does not bound the work when rows are 64 KB. */
export const COLD_SLICE_BYTES = 400_000;
db.exec(`CREATE TABLE IF NOT EXISTS events_cold_pass (
  k INTEGER PRIMARY KEY CHECK (k = 1),
  last_id INTEGER NOT NULL
)`);
// Sizes first, payloads one by one: the budget decides how many payloads are read.
const coldRows = db.query<{ id: number; timestamp: number; hook_event_type: string; tool_name: string | null; n: number }, [number, number]>(
  `SELECT id, timestamp, hook_event_type, tool_name, length(payload) AS n FROM events WHERE id > ? ORDER BY id LIMIT ?`);
const coldPayload = db.query<{ payload: string }, [number]>(`SELECT payload FROM events WHERE id = ?`);
/** One slice. Returns true while more cold rows are owed. */
export function slimColdEventsStep(slice = COLD_SLICE, now = Date.now()): boolean {
  const cut = now - COLD_AFTER_MS;
  return db.transaction((): boolean => {
    const last = (db.query(`SELECT last_id FROM events_cold_pass WHERE k = 1`).get() as { last_id: number } | null)?.last_id ?? 0;
    const rows = coldRows.all(last, Math.max(1, slice));
    let mark = last, reachedEdge = false, bytes = 0;
    for (const r of rows) {
      if (r.timestamp >= cut) { reachedEdge = true; break; }
      // Stop before a row that would pass the budget; the first row is always taken.
      if (bytes > 0 && bytes + r.n > COLD_SLICE_BYTES) break;
      mark = r.id;
      bytes += r.n;
      if (r.n < 300) continue;
      let p: Record<string, unknown>;
      try { p = JSON.parse(coldPayload.get(r.id)?.payload ?? ""); } catch { continue; }
      const slim = slimColdEvent(p, r.hook_event_type, r.tool_name);
      if (slim) slimPassWrite.run(JSON.stringify(slim), r.id);
    }
    if (mark !== last) db.run(`INSERT INTO events_cold_pass (k, last_id) VALUES (1, ?) ON CONFLICT(k) DO UPDATE SET last_id = excluded.last_id`, [mark]);
    return !reachedEdge && mark !== last;
  }).immediate();
}

/** Run the cold cut to the edge with the loop free between slices. Returns the slice count. */
export async function slimColdEventsYielding(slice = COLD_SLICE, now = Date.now()): Promise<number> {
  let n = 0;
  for (;;) {
    n++;
    if (!waitedFor("cold events slice", () => slimColdEventsStep(slice, now))) break;
    await new Promise<void>((res) => setImmediate(res));
    resumedAs("cold events pace");
    await paceByWal();
  }
  if (n > 1) { changedPathsMemo.drop(); changeListMemo.drop(); }
  return n;
}

/** Both old-row passes, one window per turn: the slim pass first, then this one. */
export function oldEventsStep(): boolean {
  return slimOldEventsStep() || slimOldResponsesStep();
}

let slimPassTimer: ReturnType<typeof setTimeout> | null = null;
/** Run the pass in the background, one window per turn with the loop free in
 *  between, starting well after boot. Single and unref'd. A step that throws
 *  (another process holding the lock past busy_timeout, a full disk) is said
 *  once and tried again after retryMs, doubling up to retryMaxMs; a good step
 *  resets the wait. */
export function startSlimOldEvents(startMs = 60_000, gapMs = 50, retryMs = 10 * 60_000, retryMaxMs = 6 * 3_600_000, step1: () => boolean = oldEventsStep): void {
  if (slimPassTimer) return;
  let wait = retryMs, said = false;
  const next = (ms: number) => { slimPassTimer = setTimeoutAs("boot:slim-old-events:pass", step, ms); (slimPassTimer as { unref?: () => void }).unref?.(); };
  const step = () => {
    slimPassTimer = null;
    let more = false;
    try { more = step1(); } catch (e) {
      if (!said) { said = true; console.warn(`[db] events slim pass step failed, retrying in ${Math.round(wait / 1000)} s and backing off: ${(e as Error)?.message ?? e}`); }
      next(wait); wait = Math.min(wait * 2, retryMaxMs);
      return;
    }
    wait = retryMs;
    if (more) next(gapMs);
  };
  next(startMs);
}

/** For the tests: whether a background read is still owed. */
export const __risksWarming = (): boolean => riskWarmQueue.size > 0 || riskWarmTimer !== null;

/** The edits of `n` sessions with ids in (mark, top]: see attachRisks. */
export function riskReadSql(n: number): string {
  return `SELECT id, timestamp, source_app, session_id, tool_name, payload, project_path, cwd_path FROM events INDEXED BY idx_events_pre_open
           WHERE session_id IN (${Array(n).fill("?").join(",")}) AND tool_name IN ('Edit','Write','MultiEdit') AND id > ? AND id <= ?
             AND hook_event_type='PostToolUse'
           ORDER BY id DESC`;
}

/**
 * Event ids one warm turn reads. Measured on a copy of the live DB (page cache
 * dropped, 1.66 GB file): the first warm turn, 3 s after a boot, blocked the loop
 * 1,065 ms ("unlabelled ... waiting cpu=365ms diskblk=372376", server-stall.log).
 * The turn was 5 sessions, but two of them hold 3,446 and 1,203 edits and read
 * 496 ms and 327 ms alone, cold: a session count does not bound the work. Nor does
 * a row limit: the filter on hook_event_type sends every candidate to the table, so
 * LIMIT 400 still cost 719 ms. The id range is tested on the index before the table,
 * so a span of ids does bound it: the same first 5 sessions in 20,000-id spans, cold,
 * worst turn 93 ms (63 turns, 1,073 ms in all, loop free between them).
 */
export const RISK_WARM_SPAN = 20_000;

/**
 * Where one read of (mark, top] stops: `span` ids past the first row any of the
 * sessions has (nothing lies below `firstId`, so the empty stretch costs no turn),
 * or `top`. Everything up to it is read; the rest is owed. Pure, for the test.
 */
export function riskChunkTop(mark: number, firstId: number | null, top: number, span: number): number {
  if (!Number.isFinite(span)) return top;
  return Math.min(top, Math.max(mark, (firstId ?? top) - 1) + span);
}

/**
 * Puts each session's flags on its row. Returns how many sessions it left for
 * the warm turns: at most `coldBudget` sessions never read before are read on
 * this call, the rest go in line (see warmSessionRisks) and carry no flag yet.
 *
 * The budget is the request path's. The first `GET /sessions` after a start
 * arrived before the warm turns were done and read every session still owed in
 * one call: "event loop blocked 1468ms by GET /sessions, waiting ... 298416
 * blocks read from disk", four seconds after a boot (server-stall.log,
 * 2026-11-13), and again after each of the next restarts. A flag that shows up
 * one poll later is the price of a list that never freezes the terminal.
 */
function attachRisks(rows: import("../../shared/types.ts").SessionRollup[], coldBudget = Infinity, span = Infinity): number {
  if (!rows.length) return 0;
  let deferred = 0;
  try {
    const top = db.query<{ m: number | null }, []>(`SELECT MAX(id) m FROM events`).get()?.m ?? 0;
    const ids = rows.map((r) => r.session_id);
    // Grouped by watermark rather than read from the lowest one: a session that
    // just appeared starts at 0, and that must not make every other listed
    // session re-read its whole history.
    const byMark = new Map<number, string[]>();
    let cold = 0;
    for (const id of ids) {
      const mark = riskMemo.get(id)?.through ?? 0;
      if (mark >= top) continue;
      if (!riskMemo.has(id) && ++cold > coldBudget) { riskWarmQueue.add(id); deferred++; continue; }
      const g = byMark.get(mark);
      if (g) g.push(id); else byMark.set(mark, [id]);
    }
    if (byMark.size) {
      const fresh = new Map<string, import("../../shared/types.ts").FileChange[]>();
      const throughOf = new Map<number, number>();
      const freshWhere = new Map<number, RiskWhere>();
      for (const [mark, group] of byMark) {
        // INDEXED BY: left to itself SQLite picks idx_events_type, and a new
        // session's first read (mark 0) then walks every PostToolUse row in the
        // table — measured 21 ms on 28k rows, against 1 ms by session.
        // idx_events_pre_open (session_id, tool_name, paired, id), not
        // idx_events_session: by session alone every event row of the session
        // was fetched from the table to test its tool, so a cold read paid for
        // the whole history to find the few edits. "GET /sessions stall 663 ms,
        // 129808 blocks read from disk" (server-stall.log, 2026-11-13). On 5
        // sessions of 20k events, 200 edits each, page cache dropped: 159.5 MB
        // and 1703 ms read by session, 3.2 MB and 41 ms by session and tool.
        // The id range is tested on the index too, so a warm read stays cheap.
        const first = Number.isFinite(span)
          ? db.query<{ m: number | null }, string[]>(`SELECT MIN(id) m FROM events WHERE session_id IN (${group.map(() => "?").join(",")})`).get(...group)?.m ?? null
          : null;
        const upTo = riskChunkTop(mark, first, top, span);
        throughOf.set(mark, upTo);
        const read = db.query<ChangeRow, any[]>(riskReadSql(group.length)).all(...group, mark, upTo) as (ChangeRow & RiskWhere)[];
        for (const r of read) {
          const c = parseChange(r);
          if (!c?.risks) continue;
          freshWhere.set(r.id, { project_path: r.project_path, cwd_path: r.cwd_path });
          const list = fresh.get(r.session_id);
          if (list) list.push(c); else fresh.set(r.session_id, [c]);
        }
      }
      for (const [mark, group] of byMark) for (const id of group) {
        const through = throughOf.get(mark) ?? top;
        // A chunk that stopped short of `top` leaves the rest of this session in line.
        if (through < top) riskWarmQueue.add(id);
        const prev = riskMemo.get(id);
        const old = prev?.flags ?? [];
        const add = fresh.get(id) ?? [];
        // Newer first, so the reason kept for a kind and file is the latest one.
        const flags = add.length
          ? sessionRisks([...add, ...old.map((f) => ({ id: f.change, file_path: f.file, risks: [f] }))])
          : old;
        const where = new Map<number, RiskWhere>();
        for (const f of flags) {
          const w = f.change != null ? freshWhere.get(f.change) ?? prev?.where.get(f.change) : undefined;
          if (w) where.set(f.change!, w);
        }
        if (!prev) riskColdReads++;
        riskMemo.delete(id);
        riskMemo.set(id, { through, flags, where });
      }
      // Insertion order is recency of reading, so the front is the stalest.
      for (const k of riskMemo.keys()) {
        if (riskMemo.size <= RISK_MEMO_MAX) break;
        riskMemo.delete(k);
      }
    }
    const scope = workspaceRoots();
    const inside = new Map<RiskWhere, boolean>();
    for (const r of rows) {
      const m = riskMemo.get(r.session_id);
      if (!m?.flags.length) continue;
      const f = !scope.length ? m.flags : m.flags.filter((x) => {
        const w = x.change != null ? m.where.get(x.change) : undefined;
        if (!w) return true;
        let ok = inside.get(w);
        if (ok === undefined) inside.set(w, ok = sessionInScope(w, scope));
        return ok;
      });
      if (f.length) r.risks = f;
    }
  } catch { /* flags are advisory; a database that cannot answer must not lose the list */ }
  if (deferred) scheduleRiskWarm(20);
  return deferred;
}

/** For the tests: read one session from nothing in spans of `span` ids; the flags and the turns it took. */
export function __riskChunkedFlagsForTest(sessionId: string, span: number): { flags: import("../../shared/types.ts").SessionRisk[]; turns: number } {
  riskMemo.delete(sessionId);
  let turns = 0;
  do {
    riskWarmQueue.delete(sessionId);
    attachRisks([{ session_id: sessionId } as import("../../shared/types.ts").SessionRollup], Infinity, span);
    turns++;
  } while (riskWarmQueue.has(sessionId) && turns < 1000);
  riskWarmQueue.delete(sessionId);
  return { flags: riskMemo.get(sessionId)?.flags ?? [], turns };
}

/**
 * The session's newest changes, plus any flagged one older than those.
 *
 * The card rolls flags up over the whole session and the detail lists only the
 * newest `limit` changes, so a key written early in a long session would be a
 * red chip with no file behind it in the diff the card opens.
 */
function changesWithFlagged(sessionId: string, limit: number): import("../../shared/types.ts").FileChange[] {
  const changes = getChanges(limit, sessionId);
  const stub = { session_id: sessionId } as import("../../shared/types.ts").SessionRollup;
  attachRisks([stub]);
  const have = new Set(changes.map((c) => c.id));
  const missing = [...new Set((stub.risks ?? []).map((r) => r.change).filter((id): id is number => id != null && !have.has(id)))];
  if (!missing.length) return changes;
  const chg = scopeClause();
  const older = db.query<ChangeRow, any[]>(
    `SELECT id, timestamp, source_app, session_id, tool_name, payload FROM events
     WHERE id IN (${missing.map(() => "?").join(",")}) AND session_id = ?${chg.clause}
     ORDER BY timestamp DESC, id DESC`).all(...missing, sessionId, ...chg.args);
  return [...changes, ...older.map((r) => parseChange(r)).filter((c): c is import("../../shared/types.ts").FileChange => c !== null)];
}

/** Recent file changes (Edit/Write/MultiEdit) with their diff hunks, parsed
 *  from the tool_response.structuredPatch Claude Code already provides.
 *  `withRisks: false` for a caller that only wants the paths — the rules read
 *  every added line, and on 500 changes that was half the call. */
export function getChanges(limit = 200, sessionId?: string, withRisks = true): import("../../shared/types.ts").FileChange[] {
  // The unscoped-by-session list (GET /changes) is held until an edit is
  // ingested or rows are deleted, the same drops as the path list: an unchanged
  // call costs no query and no JSON.parse. One slot, keyed by what it was asked.
  if (sessionId) return readChanges(limit, sessionId, withRisks);
  return [...changeListMemo.get(`${scopeKey()}|${limit}|${withRisks}`, () => readChanges(limit, undefined, withRisks))];
}

function readChanges(limit: number, sessionId: string | undefined, withRisks: boolean): import("../../shared/types.ts").FileChange[] {
  const chg = scopeClause();
  const rows = sessionId
    ? db.query<ChangeRow, any[]>(
        `SELECT id, timestamp, source_app, session_id, tool_name, payload FROM events
         WHERE hook_event_type='PostToolUse' AND tool_name IN ('Edit','Write','MultiEdit') AND session_id = ?${chg.clause}
         ORDER BY timestamp DESC, id DESC LIMIT ?`).all(sessionId, ...chg.args, limit)
    // The newest `limit` ids are picked from index leaves alone, and only those rows' payloads are read.
    // Selecting the payload in the same query put it in the sorter for EVERY Edit/Write of the whole
    // history: 156 ms against 3 ms on a 785k-row copy (40k edits), and on a real cold disk the
    // multi-second GET /plugins/session-reads stall (this list feeds openProjectRepos).
    : db.query<ChangeRow, any[]>(
        `SELECT id, timestamp, source_app, session_id, tool_name, payload FROM events
         WHERE id IN (SELECT id FROM events
           WHERE hook_event_type='PostToolUse' AND tool_name IN ('Edit','Write','MultiEdit')${chg.clause}
           ORDER BY timestamp DESC, id DESC LIMIT ?)
         ORDER BY timestamp DESC, id DESC`).all(...chg.args, limit);
  return rows.map((r) => parseChange(r, withRisks)).filter((c): c is import("../../shared/types.ts").FileChange => c !== null);
}

const changedPathsMemo = changesMemo<readonly string[]>();
const changeListMemo = changesMemo<readonly import("../../shared/types.ts").FileChange[]>();

/** File paths of the newest 300 Edit/Write changes, cached until an edit is
 *  ingested (see changesMemo.ts for the measured why). Callers that only need
 *  paths use this instead of getChanges(300, undefined, false). */
export function recentChangedPaths(): string[] {
  // A copy: the callers hand it to functions that take a plain array, and the kept one must not be theirs to change.
  return [...changedPathsMemo.get(scopeKey(), () => getChanges(300, undefined, false).map((c) => c.file_path))];
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
    changes: changesWithFlagged(sessionId, 40),
  };
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

/** The same rows as exportRows, read one page at a time (keyset on id) so an
 *  export never holds the whole table. Same order, same scope, same cap. */
export function* exportPages(pageSize = 2_000, limit = 100_000): Generator<WatchEvent[]> {
  const s = scopeClause();
  const q = db.query<any, any[]>(
    `SELECT * FROM events WHERE id > ?${s.clause} ORDER BY id ASC LIMIT ?`,
  );
  let after = -1;
  let left = limit;
  while (left > 0) {
    const raw = q.all(after, ...s.args, Math.min(pageSize, left));
    if (raw.length === 0) return;
    after = raw[raw.length - 1].id;
    left -= raw.length;
    yield raw.map(parseEventRow);
  }
}

export { db };
