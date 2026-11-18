// Read every Claude Code session on this machine straight from disk.
//
// Claude Code writes one JSONL transcript per session under
//   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
// for *every* project, regardless of which directory it ran in. Scanning that
// tree is what lets the dashboard cover all projects at once instead of only
// the ones where a hook happened to fire — no need to start agentglass from
// inside each repo.
//
// Progress is tracked per file (how many lines we've already turned into
// events), so a restart or a re-scan only ingests lines it hasn't seen. That
// same offset is what makes the poll loop double as the live path: an active
// session's transcript grows on disk, and we pick up the tail every tick.

import { readdir, stat } from "node:fs/promises";
import { watch as fsWatch, closeSync, openSync, readSync, statSync, type Stats } from "node:fs";
import { openWatcher, IN_MODIFY, IN_CREATE, IN_MOVED_TO, IN_DELETE_SELF, IN_MOVE_SELF, IN_Q_OVERFLOW, IN_IGNORED, type Watcher, type WatchEvent } from "./inotify";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import type { IngestBody } from "../../shared/types.ts";
import { normalize } from "./ingest.ts";
import { backoff, entered, resumedAs, setIntervalAs, setTimeoutAs, terminalHot, waitedFor } from "./loopwatch.ts";
import { db, insertEvent, setSessionTitles, RETENTION_DAYS, dbClaimedElsewhere, dbPath, type InsertResult } from "./db.ts";
// safeAbs: translates Windows drive paths, so a WSL-side transcript groups
// under its own folder rather than collapsing onto the server's cwd.
import { claudeAccountDirs } from "./claudeAccount.ts";
import { projectRootOf, safeAbs } from "./git.ts";
import { scopeKey, inScope, envLimit } from "./config.ts";
import { judgeWatchEvent, NON_TRANSCRIPT_DIRS, planTick, takeNewest, DIRTY_CHUNK } from "./transcriptDirty.ts";
import { batchFull, shouldYield } from "./transcriptSlice.ts";

// One root by default; a path.delimiter-separated list (":" on POSIX, ";" on
// Windows) sweeps several at once — e.g. a WSL home next to a Windows one.
// The Set folds a root listed twice, which would otherwise ingest every
// transcript in it twice.
//
// Read per sweep rather than pinned at import: `bun test` runs every file in one
// process, so a module-level constant would be decided by whichever test file
// imported this module first — which for every other file means the developer's
// real ~/.claude/projects, i.e. the scanner tests would sweep the machine
// instead of their fixture. It is one env read every 3s.
function projectsDirs(): string[] {
  return [
    ...new Set(
      (process.env.AGENTGLASS_PROJECTS_DIR
        ? process.env.AGENTGLASS_PROJECTS_DIR.split(delimiter)
        // Default: the CLI's own folder, plus the "projects" folder of each account a project picked.
        : [join(homedir(), ".claude", "projects"), ...claudeAccountDirs().map((d) => join(d, "projects"))]
      )
        .map((d) => d.trim())
        .filter(Boolean)
    ),
  ];
}
const POLL_MS = Math.max(500, Number(process.env.AGENTGLASS_SCAN_INTERVAL_MS || 3000));
export const SCAN_ENABLED = envLimit("AGENTGLASS_SCAN_DISABLED") !== "1";

// --- keeping the sweep off the loop the PTY rides ----------------------------
//
// The scanner runs on the one thread that also pumps the terminal's PTY, so any
// stretch it spends parsing a transcript and inserting its events is a stretch
// the console is frozen. That cost is per line — a JSON.parse, then an
// insertEvent with its FTS write and its pre→post pairing query — so a cold
// backfill of a real machine's ~700MB of transcripts is minutes of it: measured
// at ~2s of dead loop PER 50MB file with the whole file in one transaction.
//
// So the per-file loop below runs in bounded BATCHES, each its own transaction,
// and yields the thread between them: the loop breathes, serves the PTY, and
// comes back for the next batch. Progress commits WITH each batch — lines_done
// advances atomically with that batch's inserts — so a crash or a failing later
// batch resumes exactly where it left off, never re-ingesting a committed batch
// (no double counts) and never dropping an uncommitted one. This replaces the
// old all-or-nothing single transaction, whose atomicity we reproduce across the
// batch boundary by only ever ADVANCING lines_done past what committed.
//
// Bounded by BOTH a line count and a byte budget: 500 ordinary lines measured at
// ~40ms of parse+insert on a real machine, comfortably under both the 80ms the
// PTY echo aims for and the 120ms at which the terminal starts to feel laggy;
// the byte budget makes a batch that lands on a cluster of multi-MB image lines
// yield just as promptly instead of parsing megabytes in one shot.
//
// Read per sweep, not pinned at import, for the same reason projectsDirs() is:
// `bun test` runs every file in one process, so a module-level constant would be
// fixed by whichever test imported this module first, defeating any test that
// overrides them. It is a handful of env reads per file — nothing measurable.
const batchLines = () => Math.max(1, Number(process.env.AGENTGLASS_SCAN_BATCH_LINES || 500));
const batchBytes = () => Math.max(64 * 1024, Number(process.env.AGENTGLASS_SCAN_BATCH_BYTES || 1024 * 1024));
/** Wall-clock cap on one batch (one transaction), on top of the line and byte
 *  caps: 500 ordinary lines measured ~40 ms, and a cluster of heavy ones takes
 *  longer under the same line count. ~15 ms keeps a commit under the 20 ms the
 *  loop budget asks for. */
const batchMs = () => Math.max(1, Number(process.env.AGENTGLASS_SCAN_BATCH_MS || 15));
/** Between files, hand the loop back once the sweep has held it this long. */
const fileSliceMs = () => Math.max(1, Number(process.env.AGENTGLASS_SCAN_SLICE_MS || 8));
/**
 * A single line larger than this is not parsed on the loop.
 *
 * Measured: Bun parses even a multi-MB base64 string fast — it is one big string
 * value, not nested structure — so the several-MB image lines a browser tool or
 * a pasted screenshot writes are NOT the bottleneck, and they are ingested
 * normally (their tool_result carries no displayed text either way). This is a
 * safety valve for the genuinely abnormal line: a whole file written as one
 * record, or a corrupt multi-hundred-MB blob, whose JSON.parse would be a single
 * uninterruptible block no batching can subdivide. Such a line is skipped with a
 * log rather than left to freeze the console. 16MB sits far above any legitimate
 * transcript record, so real data never trips it — it only ever fires on the
 * pathological case, which is exactly the deliberate payload cap the perf work
 * allows. The 64KB floor keeps a misconfigured value from skipping ordinary
 * records.
 */
const maxLineBytes = () => Math.max(64 * 1024, Number(process.env.AGENTGLASS_SCAN_MAX_LINE_BYTES || 16 * 1024 * 1024));
/** When a human is typing, step a few ms further back between batches — clear
 *  air for the PTY on top of the macrotask yield every batch already takes. */
const YIELD_HOT_MS = 4;
/** Hand the loop back so the PTY (and every other socket and timer) runs before
 *  the next batch. setTimeout(0) is a macrotask: pending I/O callbacks fire
 *  first, which is precisely the terminal's bytes getting served. */
function yieldLoop(hot: boolean): Promise<void> {
  // The label set here is gone by the time the awaiting code resumes: set it again from the promise chain.
  return new Promise<void>((r) => setTimeout(r, hot ? YIELD_HOT_MS : 0)).then(() => resumedAs(SCAN_LABEL));
}
/** What a stall in a scan continuation (after an await) is called: the label does not survive an await by itself. */
const SCAN_LABEL = "transcript scan";
let oversizeLogged = 0;
function noteOversize(path: string, bytes: number): void {
  // Log the first few, then stay quiet: a machine full of these would otherwise
  // flood the console on a cold-start backfill.
  if (oversizeLogged++ < 5) {
    const size = bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`;
    console.warn(
      `[scan] skipped a ${size} line in ${basename(path)} — too large to parse on the loop (base64 media, no telemetry to extract)`
    );
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS transcript_files (
  path TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  source_app TEXT NOT NULL DEFAULT '',
  project_path TEXT NOT NULL DEFAULT '',
  lines_done INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER NOT NULL DEFAULT 0
);
`);

// Resume state for a restart: what a warm `Tail` holds, per transcript, so a boot
// reads only the bytes appended since (see `loadResume`). Additive; a missing
// or stale row only costs the old whole-file read.
db.exec(`
CREATE TABLE IF NOT EXISTS transcript_resume (
  path TEXT PRIMARY KEY,
  lines INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  ended_nl INTEGER NOT NULL,
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transcript_refused (
  path TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime REAL NOT NULL
);
`);
// Additive columns on tables an older build already made: the file the resume row
// came from (head hash, its length, mtime) and when a refusal was decided.
for (const alter of [
  "ALTER TABLE transcript_resume ADD COLUMN head TEXT",
  "ALTER TABLE transcript_resume ADD COLUMN head_len INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE transcript_resume ADD COLUMN mtime REAL NOT NULL DEFAULT 0",
  "ALTER TABLE transcript_resume ADD COLUMN tail_hash TEXT",
  "ALTER TABLE transcript_refused ADD COLUMN at REAL",
]) { try { db.exec(alter); } catch { /* column already there */ } }

interface FileRow {
  path: string;
  session_id: string;
  source_app: string;
  project_path: string;
  lines_done: number;
  size: number;
  mtime: number;
}

const getFile = db.query<FileRow, [string]>("SELECT * FROM transcript_files WHERE path = ?");
/** Just the progress marker, for the in-transaction re-read that turns it from a
 *  read into a claim. Its own statement so the claim costs one integer, not a
 *  whole row. */
const linesDoneOf = db.query<{ lines_done: number }, [string]>(
  "SELECT lines_done FROM transcript_files WHERE path = ?"
);
/**
 * Advance a file's progress ONLY if it still stands where the caller last saw it.
 *
 * Compare-and-swap, not a blind write. `lines_done` is read outside any
 * transaction (scanOnce, below) and written many milliseconds later, at the end
 * of a batch; between those two moments a second server process can have
 * ingested the same lines and moved the marker. The old unconditional UPSERT
 * then wrote our stale idea of progress over theirs, and every line between the
 * two positions was ingested twice — invisibly, because scanner events carry
 * `event_id: null` and the idempotency index in db.ts only covers non-null ids.
 *
 * The `WHERE` rides the DO UPDATE, so a moved marker leaves the row untouched
 * rather than erroring. The INSERT half needs no guard: no row means nobody has
 * claimed this transcript yet.
 */
const putFileIfUnmoved = db.query(`
  INSERT INTO transcript_files (path, session_id, source_app, project_path, lines_done, size, mtime)
  VALUES ($path, $sid, $src, $proj, $lines, $size, $mtime)
  ON CONFLICT(path) DO UPDATE SET
    session_id = excluded.session_id,
    source_app = excluded.source_app,
    project_path = excluded.project_path,
    lines_done = excluded.lines_done,
    size = excluded.size,
    mtime = excluded.mtime
  WHERE transcript_files.lines_done = $expect
`);

/**
 * Forget progress rows for transcripts that are no longer on disk.
 *
 * Nothing else deletes from this table, and Claude Code removes old transcripts
 * on its own schedule, so the rows for files that are gone pile up for ever:
 * measured on a real database, 5320 of 8697 rows named a file that no longer
 * existed. A row is dropped only when all of these hold:
 *  - its mtime is older than `cut` (the events it fed are past retention),
 *  - stat says ENOENT (any other error, such as EACCES, keeps the row),
 *  - the file was also missing the last time this row was checked, so a folder
 *    that is away for one pass (an unmounted disk, a moved checkout) and then
 *    back is not read again from line 0. Scanner events have no dedupe key
 *    (`event_id: null`), so a re-read counts every event, token and cost twice,
 *  - another row of the same source_app has a project_path, so knownProjects()
 *    and the project picker seeded from this table at boot still list that
 *    project.
 * With retention 0 (keep forever) nothing is dropped: the scanner has no age
 * limit then, so any old file that comes back is re-read.
 * One slice of `limit` rows per call, keyed on path with a cursor that wraps, so
 * an hourly call stats a bounded number of files however big the table is.
 */
let goneCursor = "";
/** Paths found missing at their last check, waiting for a second miss. */
const missingOnce = new Set<string>();
/** Paths looked at since the cursor last wrapped: a mark not seen in a whole lap is for a row that left the window. */
let lapSeen = new Set<string>();
export function pruneGoneTranscripts(days = RETENTION_DAYS, limit = 2000): number {
  if (days === 0) return 0;
  const cut = Date.now() - days * 86_400_000;
  const rows = db
    .query<{ path: string }, [number, string, number]>(
      "SELECT path FROM transcript_files WHERE mtime < ? AND path > ? ORDER BY path LIMIT ?"
    )
    .all(cut, goneCursor, limit);
  const wrapped = rows.length < limit;
  goneCursor = wrapped ? "" : rows[rows.length - 1]!.path;
  const gone: string[] = [];
  for (const r of rows) {
    lapSeen.add(r.path);
    let missing = false;
    try { statSync(r.path); } catch (e) { missing = (e as NodeJS.ErrnoException).code === "ENOENT"; }
    if (!missing) missingOnce.delete(r.path);
    else if (missingOnce.delete(r.path)) gone.push(r.path);
    else missingOnce.add(r.path);
  }
  if (wrapped) {
    for (const p of missingOnce) if (!lapSeen.has(p)) missingOnce.delete(p);
    lapSeen = new Set();
  }
  if (!gone.length) return 0;
  const del = db.query<never, [string]>(
    `DELETE FROM transcript_files WHERE path = ?
       AND EXISTS (SELECT 1 FROM transcript_files t2 WHERE t2.source_app = transcript_files.source_app
                     AND t2.path != transcript_files.path AND t2.project_path != '')`
  );
  const delResumeRow = db.query<never, [string]>("DELETE FROM transcript_resume WHERE path = ?");
  return db.transaction(() => gone.reduce((n, p) => { delResumeRow.run(p); forgetRefused(p); return n + del.run(p).changes; }, 0))();
}

/**
 * May this process sweep transcripts at all?
 *
 * Two reasons it may not: the operator turned the scanner off, or another live
 * server process holds the database claim (db.ts). The second is checked per
 * call rather than pinned, because the claim is taken at boot — after this
 * module is imported — and because it is the answer `/projects` reports.
 */
export function scanningEnabled(): boolean {
  return SCAN_ENABLED && !dbClaimedElsewhere();
}

/** Session ids that have a transcript on disk — the scanner owns these. */
const owned = new Set<string>();
/**
 * True when this session's data comes from disk, so the hook path can skip it
 * instead of counting the same work twice.
 *
 * Deliberately `SCAN_ENABLED` and not `scanningEnabled()`. "Comes from disk" is
 * a fact about the machine, not about which process did the reading: when this
 * one has stood its scanner down for another (see the claim in db.ts), that
 * other process is still ingesting the same transcript into the same database,
 * so accepting the hooks here as well is exactly the double count. `owned` is
 * seeded at import from `transcript_files`, so a held-off process still knows
 * every session either of them has ever read.
 */
export function ownsSession(session_id: string): boolean {
  return SCAN_ENABLED && owned.has(session_id);
}
/** Where this session's transcript lives on disk, or null if we have never read
 *  one for it (hook-only sessions, or a scan that has not reached it yet).
 *
 *  The file is appended to as a turn streams, so its mtime is the cheapest
 *  honest answer to "is this session still alive" — see evidence.ts. Newest
 *  first, because a session resumed into a second file has two rows and the
 *  older one stopped growing when the first one ended. */
const transcriptForSession = db.query<{ path: string }, [string]>(
  "SELECT path FROM transcript_files WHERE session_id = ? ORDER BY mtime DESC LIMIT 1"
);
export function transcriptPathOf(session_id: string): string | null {
  if (!session_id) return null;
  return transcriptForSession.get(session_id)?.path ?? null;
}

// Seeded at startup: a backfill sweep walks every project on the machine, and
// until it finishes the guard would let hook posts through for sessions the
// scanner is about to read from disk — counting the same turns twice.
for (const r of db.query<{ session_id: string }, []>("SELECT DISTINCT session_id FROM transcript_files").all()) {
  owned.add(r.session_id);
}

/** Every project directory we've seen, as a real filesystem path. Seeded from
 *  the progress table so a restart that re-ingests nothing (because every
 *  transcript is unchanged) still knows the full project list. */
const projectPaths = new Map<string, string>(); // source_app -> project path
for (const r of db
  .query<{ source_app: string; project_path: string }, []>(
    "SELECT DISTINCT source_app, project_path FROM transcript_files WHERE project_path != ''"
  )
  .all()) {
  projectPaths.set(r.source_app, r.project_path);
}
/** The projects the database already knew when this process started — from an
 *  earlier run, so from before any upgrade. Not the live list: on a fresh
 *  install that grows as the scanner ingests, and an upgrade's seed taken from
 *  it would be whatever the scan had reached by the first picker read. */
const atStart = [...projectPaths.values()];
export function projectsKnownAtStart(): string[] {
  return atStart;
}
export function knownProjects(): { source_app: string; path: string }[] {
  return [...projectPaths].map(([source_app, path]) => ({ source_app, path })).sort(
    (a, b) => a.source_app.localeCompare(b.source_app)
  );
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length ? v : null;
}

// Resolving a project root shells out to git, so memoize per cwd — a scan walks
// hundreds of transcripts that share a handful of directories.
const rootCache = new Map<string, string>();
/** The repo a cwd belongs to, folding linked worktrees and nested subdirectories
 *  up to the owning repo (via `git --git-common-dir`). Falls back to the cwd
 *  itself for a non-repo path. Memoized. */
function resolvedRoot(cwd: string): string {
  let root = rootCache.get(cwd);
  if (root === undefined) {
    // safeAbs, not the raw cwd: a Windows-recorded cwd with no resolvable
    // repo should still group under its own translated folder, not raw text.
    root = projectRootOf(cwd) ?? safeAbs(cwd) ?? cwd;
    rootCache.set(cwd, root);
  }
  return root;
}
/** Label a session by the project it belongs to, folding worktrees and nested
 *  subdirectories into the repo that owns them. */
function projectOf(cwd: string): { source_app: string; project_path: string } {
  const root = resolvedRoot(cwd);
  return { source_app: basename(root), project_path: root };
}

/** Flatten a content block's text, for prompt/message indexing. */
function blockText(blocks: unknown): string {
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((b) => (b && typeof b === "object" ? str((b as any).text) ?? "" : ""))
    .filter(Boolean)
    .join("\n");
}

/** A tool_result's content is either a string or a list of text blocks. */
function resultText(content: unknown): string {
  return blockText(content).slice(0, 4000);
}

// Claude Code writes its own plumbing into the user role: slash-command echoes,
// their stdout, image placeholders and injected context. None of it was typed
// by the user, so it would only pollute the prompt stream.
/**
 * A slash command, as the user actually typed it.
 *
 * Claude Code records `/pr-resolve-reviews 16866` as three XML tags, which the
 * meta filter below correctly refuses to show — but dropping the tags dropped
 * the message with them, so a session driven entirely by slash commands had no
 * user side at all: pages of assistant output answering a question that was
 * nowhere on screen. Rebuilding the command line keeps the noise out and the
 * intent in.
 *
 * `/clear` and friends stay filtered: they're session plumbing, not something
 * anyone asked the agent to do.
 */
const NOISE_COMMANDS = new Set(["clear", "compact", "cost", "init", "resume", "exit", "quit"]);

export function slashCommand(text: string): string | null {
  const name = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(text)?.[1];
  if (!name || NOISE_COMMANDS.has(name)) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
  return `/${name}${args ? ` ${args}` : ""}`;
}

const META_PREFIXES = [
  "<local-command-caveat>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<system-reminder>",
  "<task-notification>",
  "[Image:",
];
function isMetaPrompt(o: Record<string, unknown>, text: string): boolean {
  if (o.isMeta === true || o.isCompactSummary === true) return true;
  const t = text.trimStart();
  return META_PREFIXES.some((p) => t.startsWith(p));
}

/** True when the next non-empty line is the same assistant reply (same message.id) carrying a tool_use. */
function repliesWithToolUse(o: Record<string, unknown>, lines: string[], next: number): boolean {
  const id = str((o.message as Record<string, unknown> | undefined)?.id);
  if (!id) return false;
  for (let k = next; k < lines.length; k++) {
    const t = lines[k]!.trim();
    if (!t) continue;
    if (t.length > maxLineBytes()) return false;
    try {
      const m = (JSON.parse(t) as { type?: unknown; message?: { id?: unknown; content?: unknown } });
      if (m.type !== "assistant" || m.message?.id !== id) return false;
      if (Array.isArray(m.message.content) && m.message.content.some((b) => (b as { type?: unknown })?.type === "tool_use")) return true;
    } catch { return false; }
  }
  return false;
}

/**
 * Turn one transcript line into zero or more ingest bodies.
 *
 * The mapping mirrors what the hooks would have emitted for the same turn, so
 * disk-sourced and hook-sourced sessions produce the same shapes:
 *   assistant + tool_use   → PreToolUse  (one per tool call)
 *   assistant, text only   → Stop        (end of an assistant turn)
 *   user + tool_result     → PostToolUse (pairs with the Pre for latency)
 *   user, text             → UserPromptSubmit
 * Per-turn token usage rides on the first event derived from an assistant line
 * so totals stay exact rather than being counted once per tool call.
 */
function lineToBodies(
  o: Record<string, unknown>,
  ctx: { source_app: string; project_path: string; cwd: string; session_id: string; toolCalls: Map<string, { name: string; input: unknown }>; seenUsage: Set<string>; carryUsage?: Map<string, Record<string, unknown>> },
  fallbackTs: number
): IngestBody[] {
  const type = str(o.type);
  if (type !== "assistant" && type !== "user") return [];

  const msg = (o.message ?? {}) as Record<string, unknown>;
  if (!msg || typeof msg !== "object") return [];

  const ts = Date.parse(String(o.timestamp ?? "")) || fallbackTs;
  const model = str(msg.model);
  const base = {
    source_app: ctx.source_app,
    session_id: ctx.session_id,
    model_name: model ?? undefined,
  };
  // Shared payload bits so every event carries where it came from — this is
  // what the folder filter and the project column read.
  const common: Record<string, unknown> = { project_path: ctx.project_path };
  // The exact directory the turn ran in — a worktree rolls up to its repo for
  // labeling, but the branch checkout it actually happened in is worth keeping.
  if (ctx.cwd && ctx.cwd !== ctx.project_path) common.cwd = ctx.cwd;
  // Subagent turns live in their own transcript but report the parent's
  // sessionId, so they land on the parent's timeline tagged by agent.
  if (o.isSidechain === true) common.agent_type = "subagent";
  const agentId = str(o.agentId);
  if (agentId) common.agent_id = agentId;
  if (str(o.gitBranch)) common.git_branch = o.gitBranch;

  const out: IngestBody[] = [];
  const content = msg.content;

  if (type === "assistant") {
    const blocks = Array.isArray(content) ? content : [];
    const toolUses = blocks.filter(
      (b): b is Record<string, unknown> =>
        !!b && typeof b === "object" && (b as any).type === "tool_use"
    );
    // Raw usage object: normalize() understands cache_creation_input_tokens /
    // cache_read_input_tokens directly, and treats a payload usage as a
    // per-turn delta (not a cumulative transcript total).
    const msgId = str(msg.id);
    const firstOfResponse = !msgId || !ctx.seenUsage.has(msgId);
    if (msgId) ctx.seenUsage.add(msgId);
    let usage = firstOfResponse ? (msg.usage as Record<string, unknown> | undefined) : undefined;
    // A dropped narration Stop left its usage here; the reply's tool_use line carries it instead.
    if (toolUses.length && msgId && ctx.carryUsage?.has(msgId)) { usage ??= ctx.carryUsage.get(msgId); ctx.carryUsage.delete(msgId); }

    if (toolUses.length) {
      toolUses.forEach((b, i) => {
        const id = str(b.id);
        const name = str(b.name);
        if (id && name) ctx.toolCalls.set(id, { name, input: b.input ?? {} });
        out.push({
          ...base,
          hook_event_type: "PreToolUse",
          timestamp: ts + i,
          payload: {
            ...common,
            tool_name: name,
            tool_use_id: id,
            tool_input: b.input ?? {},
            ...(i === 0 && usage ? { usage } : {}),
          },
        });
      });
    } else {
      const text = blockText(blocks);
      out.push({
        ...base,
        hook_event_type: "Stop",
        timestamp: ts,
        payload: {
          ...common,
          ...(text ? { last_assistant_message: text.slice(0, 4000) } : {}),
          ...(usage ? { usage } : {}),
        },
      });
    }
    return out;
  }

  // --- user ---------------------------------------------------------------
  if (typeof content === "string") {
    // A slash command is a real instruction wearing markup, so it's read before
    // the meta filter gets to reject it for the tags it's made of.
    const cmd = slashCommand(content);
    if (cmd) return [{ ...base, hook_event_type: "UserPromptSubmit", timestamp: ts, payload: { ...common, prompt: cmd } }];
    return content.trim() && !isMetaPrompt(o, content)
      ? [{ ...base, hook_event_type: "UserPromptSubmit", timestamp: ts, payload: { ...common, prompt: content.slice(0, 4000) } }]
      : [];
  }
  if (!Array.isArray(content)) return [];

  let seq = 0;
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const blk = b as Record<string, unknown>;
    if (blk.type === "tool_result") {
      const id = str(blk.tool_use_id);
      const isErr = blk.is_error === true;
      const text = resultText(blk.content);
      // Carry the call's input onto the result too. Everything downstream that
      // asks "which file did this touch" (the diff list, and through it the
      // repo discovery that fills the git/terminal/chat pickers) reads
      // tool_input off the PostToolUse, not the Pre.
      const call = id ? ctx.toolCalls.get(id) : undefined;
      // A tool_use is matched by exactly one tool_result, so once this result has
      // read the call's input the entry is dead weight. Drop it now instead of
      // waiting for the whole tail to be evicted: a long-lived active session
      // (one that never idles the 10 min TAIL_IDLE_MS wants) would otherwise hold
      // every Read/Write/Edit input — routinely megabytes each — for its entire
      // life. A cold re-read rebuilds and re-drops these deterministically from
      // lines_done, so this only frees memory, never changes output. A call whose
      // result lands in a later chunk is not deleted here (it's not in the map to
      // get), so cross-chunk pairing is unaffected.
      if (id) ctx.toolCalls.delete(id);
      out.push({
        ...base,
        hook_event_type: "PostToolUse",
        timestamp: ts + seq++,
        payload: {
          ...common,
          tool_name: call?.name ?? null,
          tool_use_id: id,
          tool_input: call?.input ?? {},
          tool_response: { content: text, is_error: isErr },
          // detectError() keys off a top-level is_error/error pair.
          ...(isErr ? { is_error: true, error: text || "tool reported a failure" } : {}),
        },
      });
    } else if (blk.type === "text") {
      const text = str(blk.text);
      if (text && text.trim() && !isMetaPrompt(o, text)) {
        out.push({
          ...base,
          hook_event_type: "UserPromptSubmit",
          timestamp: ts + seq++,
          payload: { ...common, prompt: text.slice(0, 4000) },
        });
      }
    }
  }
  return out;
}

/**
 * Everything a from-zero re-parse used to rederive, kept per file so a sweep can
 * read *only* the bytes appended since the last one.
 *
 * The sweep runs every 3s and used to `readFileSync` + split + `JSON.parse` the
 * whole transcript each time, just to rebuild this state before skipping past
 * the lines it had already ingested. On this machine's real transcripts (86 MB,
 * 79 MB, 42 MB) that measured ~4ms/MB, ~9% steady CPU doing nothing — and since
 * this single-threaded process also pumps the built-in terminal's PTY bytes, it
 * is felt as the terminal stuttering, worse the longer a session runs. That is
 * why restarting the app "fixed" it.
 *
 * Each field is load-bearing; dropping any of them changes output:
 *  - toolCalls — a tool_result matches its call by id, and the call is usually
 *    in a chunk ingested on an earlier tick. Without it PostToolUse loses
 *    tool_name/tool_input, which the diff list and repo discovery read.
 *  - seenUsage — Claude Code repeats one message's `usage` on every
 *    content-block line of the same reply; deduping by message.id is what stops
 *    tokens and cost coming out multiplied (measured 2.5x).
 *  - customTitle/aiTitle — the last title line in the file wins, and a rename
 *    can sit far before the offset.
 *  - cwd/source_app/project_path/session_id — sniffed from the first line that
 *    carries them, which a tail chunk usually does *not* contain, so a tail read
 *    that re-sniffed would file the session under its own uuid instead of its
 *    project.
 *
 * Persisted too, in `transcript_resume` (see `saveResume`/`loadResume`). The
 * old note here said the maps "can't be cheaply written to SQLite". True for a
 * write per sweep, not for a throttled one: a matched tool_use input is dropped
 * on sight, so the open calls are few, and `seenUsage` is one short id per
 * reply. Measured on the resume-test fixture (its payload test): 781 bytes
 * for 50 seen ids (short fixture ids) and 3 open calls. Real message ids are
 * ~30 characters, so by arithmetic, not measurement, ~35 bytes per reply and
 * ~350 KB for a 10,000-reply session.
 * That is why the write is throttled
 * (`resumeEveryMs`) and skipped when no line was added, and why a row over
 * MAX_RESUME_STATE_BYTES is not kept. The row may lag `lines_done`; `loadResume`
 * accepts that and the lines in between are parsed for state only.
 * `lines_done` stays the durable marker, and every path below keeps it exact.
 */
interface Tail {
  /** Byte offset just past the last complete line processed. */
  bytes: number;
  /** Complete lines processed — must stay equal to transcript_files.lines_done. */
  lines: number;
  /** Whether `bytes` sits right after a newline. False when the last record was
   *  taken before its terminating newline landed (a live write caught mid-write,
   *  accepted by the restIsWholeRecord branch): the newline is then the head of
   *  the next chunk and must be consumed as that record's terminator, not split
   *  into a phantom empty line that drifts `lines` past the true record count. */
  endedWithNewline: boolean;
  toolCalls: Map<string, { name: string; input: unknown }>;
  seenUsage: Set<string>;
  customTitle: string | null;
  aiTitle: string | null;
  cwd: string;
  source_app: string;
  project_path: string;
  session_id: string;
  touched: number;
}
const tails = new Map<string, Tail>();

/** Lines JSON-parsed by the ingest loop. Test/measure only. */
let linesParsed = 0;
export function __linesParsedCount(): number { return linesParsed; }
export function __resetLinesParsedCount(): void { linesParsed = 0; }

/** Above this the serialized state is not worth a row: that file restarts cold. */
const MAX_RESUME_STATE_BYTES = 4 * 1024 * 1024;
const putResume = db.query(
  "INSERT OR REPLACE INTO transcript_resume (path, lines, bytes, ended_nl, state, head, head_len, mtime, tail_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
);
const getResume = db.query<{ lines: number; bytes: number; ended_nl: number; state: string; head: string | null; head_len: number; mtime: number; tail_hash: string | null }, [string]>(
  "SELECT lines, bytes, ended_nl, state, head, head_len, mtime, tail_hash FROM transcript_resume WHERE path = ?"
);
const RESUME_HEAD_BYTES = 4096;
/** Hash of the file's first `len` bytes (null if unreadable). A transcript only
 *  ever grows at the end, so its head is what says "same file". */
function headHash(path: string, len: number): string | null {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, 0);
      if (n < len) return null;
      return Bun.hash(buf).toString(36);
    } finally { closeSync(fd); }
  } catch { return null; }
}
const RESUME_TAIL_BYTES = 1024;
/** Hash of the (up to) 1 KB just before byte `end`. The head alone cannot tell a
 *  rewrite that kept the first 4 KB; the bytes the offset lands after can. */
function tailHash(path: string, end: number): string | null {
  const len = Math.min(RESUME_TAIL_BYTES, end);
  if (len <= 0) return null;
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(len);
      if (readSync(fd, buf, 0, len, end - len) < len) return null;
      return Bun.hash(buf).toString(36);
    } finally { closeSync(fd); }
  } catch { return null; }
}
const delResume = db.query("DELETE FROM transcript_resume WHERE path = ?");

/** Persist the tail so a restart resumes at its offset. Call only once the
 *  file's own progress row says `t.lines` (scanOnce, after the final write). */
const resumeSaved = new Map<string, { at: number; lines: number }>();
let resumeWrites = 0;
export function __resumeWriteCount(): number { return resumeWrites; }
export function __resetResumeWriteCount(): void { resumeWrites = 0; }
/** At most one resume write per file per this long. 30 s: a live file is swept
 *  every 3 s, so this turns ~10 writes of a state that can reach MBs into 1,
 *  and what a restart gives up is re-parsing the lines appended in the last
 *  30 s (a few dozen) — they are parsed for state only, not re-inserted. */
const resumeEveryMs = () => Number(process.env.AGENTGLASS_RESUME_SAVE_MS ?? 30_000);

function saveResume(path: string): void {
  const t = tails.get(path);
  if (!t) return;
  const last = resumeSaved.get(path);
  // State only moves with new lines: no new lines, nothing to serialise or write.
  if (last && (last.lines === t.lines || Date.now() - last.at < resumeEveryMs())) return;
  const state = JSON.stringify({
    toolCalls: [...t.toolCalls], seenUsage: [...t.seenUsage],
    customTitle: t.customTitle, aiTitle: t.aiTitle, cwd: t.cwd,
    source_app: t.source_app, project_path: t.project_path, session_id: t.session_id,
  });
  resumeSaved.set(path, { at: Date.now(), lines: t.lines });
  if (state.length > MAX_RESUME_STATE_BYTES) { delResume.run(path); return; }
  resumeWrites++;
  const headLen = Math.min(RESUME_HEAD_BYTES, t.bytes);
  const head = headLen > 0 ? headHash(path, headLen) : null;
  let mtime = 0;
  try { mtime = statSync(path).mtimeMs; } catch { /* no mtime: loads as stale */ }
  const tailH = tailHash(path, t.bytes);
  if (head === null || tailH === null || !mtime) { delResume.run(path); return; } // cannot say which file this was: restart cold
  putResume.run(path, t.lines, t.bytes, t.endedWithNewline ? 1 : 0, state, head, headLen, mtime, tailH);
}

/** A persisted tail, only if it does not run AHEAD of `transcript_files`
 *  (`lines <= from`) and still fits inside the file. It may lag (saves are
 *  throttled): the lines between it and `from` are parsed for state only, never
 *  re-inserted. Anything else returns undefined and the caller reads whole. */
function loadResume(path: string, from: number, fileSize: number): Tail | undefined {
  if (from <= 0) return undefined;
  const r = getResume.get(path);
  if (!r || r.lines <= 0 || r.lines > from || r.bytes > fileSize) return undefined;
  // Same file? A path rewritten while the server was down (resume, compaction)
  // can be as long or longer: the offset would land mid-line and the carried
  // state would be another file's. Head hash and mtime must still agree.
  if (!r.head || r.head_len <= 0 || headHash(path, r.head_len) !== r.head) return undefined;
  // The bytes just before the offset must be the ones saved; a row without the hash (older build) reads whole.
  if (!r.tail_hash || tailHash(path, r.bytes) !== r.tail_hash) return undefined;
  try { if (statSync(path).mtimeMs < r.mtime) return undefined; } catch { return undefined; }
  try {
    const o = JSON.parse(r.state) as {
      toolCalls: [string, { name: string; input: unknown }][]; seenUsage: string[];
      customTitle: string | null; aiTitle: string | null; cwd: string;
      source_app: string; project_path: string; session_id: string;
    };
    return {
      bytes: r.bytes, lines: r.lines, endedWithNewline: r.ended_nl === 1,
      toolCalls: new Map(o.toolCalls), seenUsage: new Set(o.seenUsage),
      customTitle: o.customTitle, aiTitle: o.aiTitle, cwd: o.cwd,
      source_app: o.source_app, project_path: o.project_path, session_id: o.session_id,
      touched: Date.now(),
    };
  } catch { return undefined; }
}
/** Cache misses that forced a whole-file re-read of a transcript that already
 *  had progress (`from > 0`) — the cost `MAX_TAILS` exists to bound. Test-only. */
let coldRereads = 0;
export function __coldRereadCount(): number { return coldRereads; }
export function __resetColdRereadCount(): void { coldRereads = 0; }

/**
 * Transcripts this workspace has already decided are somebody else's.
 *
 * MEASURED, on the machine this was written for: a cockpit scoped to one repo,
 * with agent sessions running in ANOTHER repo at the same time, was re-reading
 * those other transcripts WHOLE on every three-second sweep — 6.5 GB a minute,
 * 17% of a core, for files whose every byte it then threw away.
 *
 * The reason is the interaction of two correct decisions. A file that grew is
 * not skipped (it might have new lines); and a file the scope refuses is
 * deliberately NOT stamped into `transcript_files` (so widening the workspace
 * later can still pick it up whole — see the `skipped` branch in the sweep). A
 * live session outside the scope grows every second, so it was re-read every
 * sweep, for ever.
 *
 * The verdict is what gets remembered instead of the progress: which scope
 * refused it, and the cwd it was refused for. Nothing durable is written, so
 * widening the workspace still re-reads the file exactly once — the entry is
 * keyed BY SCOPE, so a different workspace does not match it.
 */
const refused = new Map<string, { scope: string; size: number; mtime: number; at: number }>();
const putRefused = db.query("INSERT OR REPLACE INTO transcript_refused (path, scope, size, mtime, at) VALUES (?, ?, ?, ?, ?)");
const getRefused = db.query<{ scope: string; size: number; mtime: number; at: number | null }, [string]>(
  "SELECT scope, size, mtime, at FROM transcript_refused WHERE path = ?"
);
const delRefused = db.query("DELETE FROM transcript_refused WHERE path = ?");
/** Forget a verdict in memory and on disk. */
let refusedDeletes = 0;
export const __refusedDeleteCount = (): number => refusedDeletes;
function forgetRefused(path: string): void {
  // Memory first: a path that was never refused has no row, so no write.
  const had = refused.delete(path);
  if (had || refusedOnDisk.has(path)) { refusedDeletes++; delRefused.run(path); refusedOnDisk.delete(path); }
}
/** Paths that may have a row because it was loaded from disk (the map is empty
 *  after a restart) or written; lets `forgetRefused` skip the DELETE otherwise. */
const refusedOnDisk = new Set<string>(
  db.query<{ path: string }, []>("SELECT path FROM transcript_refused").all().map((r) => r.path)
);

/** The open projects, out of the one-string scope this file passes around. A
 *  path cannot hold a NUL, so the split cannot cut one in two. */
const rootsOf = (scope: string): string[] => scope.split("\0");

/** The scope refused this file, at this size and this mtime. Kept in memory
 *  only — see `refused`. Size and mtime are what let a REWRITE be noticed: a
 *  file that got shorter, or that changed without growing, is not the file that
 *  was judged. */
function noteRefused(path: string, scope: string, size: number, mtime: number): void {
  // Delete first: `Map.set` on a key that is already there does NOT move it, so
  // without this the eviction below — which reads insertion order — would throw
  // away the entry being refused most often and keep the cold ones.
  refused.delete(path);
  const at = Date.now();
  refused.set(path, { scope, size, mtime, at });
  putRefused.run(path, scope, size, mtime, at);
  refusedOnDisk.add(path);
  // Bounded like the tail cache: a machine with hundreds of old transcripts
  // should not grow a map for ever. Cheap to lose — losing one costs one read.
  if (refused.size > MAX_REFUSED) {
    // The row goes with the entry, or the table grows without bound.
    for (const k of [...refused.keys()].slice(0, refused.size - MAX_REFUSED)) { refused.delete(k); refusedOnDisk.delete(k); delRefused.run(k); }
  }
}

/**
 * Does this file still belong to somebody else?
 *
 * Growing does not change the answer — that is the whole point, since a live
 * session elsewhere grows every second. Getting SHORTER does: the file was
 * rewritten, so the content that was judged is gone, and it is read and judged
 * again. `transcript_files` holds nothing for a refused file (deliberately), so
 * the size to compare against is the one kept with the verdict.
 */
function stillRefused(path: string, scope: string | null, rewritten: boolean, size: number, mtime: number): "yes" | "stale" | "no" {
  if (!scope || rewritten) return "no";
  let seen = refused.get(path);
  // After a restart the memo is empty; the persisted verdict stands in for it.
  // It keeps the time it was decided, so it is trusted for the TTL from THEN.
  if (!seen) {
    const d = getRefused.get(path);
    // A row from an older build has no time: treat it as ancient (re-ask now).
    if (d) { seen = { scope: d.scope, size: d.size, mtime: d.mtime, at: d.at ?? 0 }; refused.set(path, seen); refusedOnDisk.add(path); }
  }
  if (!seen || seen.scope !== scope) return "no";
  // Shorter, or changed without growing: the content that was judged is gone.
  if (size < seen.size || (size === seen.size && mtime !== seen.mtime)) { forgetRefused(path); return "no"; }
  // And it expires, because the verdict is only as good as the answer `inScope`
  // could give at the time. That answer goes through `worktreeFamily`, whose
  // own cache holds for 5 seconds ON PURPOSE — "adding a worktree shows up
  // everywhere at the same time" — and through `listWorktrees`, which returns
  // no family at all for a missing git, a non-repo directory, or a repo caught
  // mid-rebase. Without an expiry, a file judged during one of those moments
  // stays somebody else's until it shrinks or the server restarts, and the five
  // seconds that were promised quietly become for ever. The cost of re-asking
  // is a bounded head read — see `judgeByHead`.
  //
  // "stale" rather than "no": the entry stays, because the caller re-asks the
  // cheap way and usually gets the same answer back.
  if (Date.now() - seen.at > REFUSED_TTL_MS) return "stale";
  return "yes";
}

/**
 * Re-ask the scope question without re-reading the file.
 *
 * What the question needs is the first `cwd` in the transcript, and that is
 * near the top: measured across 90 real transcripts, 84 carry it inside the
 * first 64 KB. So a revalidation reads a bounded head instead of a whole file
 * that can be hundreds of megabytes.
 *
 * Null means "could not tell from the head" — 6 of those 90 carry their first
 * cwd further in (119,103 bytes was the worst) and one has none at all in the
 * first 256 KB. That answer must fall back to the full read, not to a guess:
 * `ingestFile` treats an empty cwd as "no scope test to make" and INGESTS the
 * file, so a head that came up empty and was believed would quietly pull in the
 * sessions this whole mechanism exists to keep out.
 *
 * Only ever used to REFRESH an existing verdict. The first judgement still
 * comes from the full read, which is the same pass that ingests the file when
 * the answer is yes — a head-first cold path would read every in-scope file
 * twice.
 */
async function judgeByHead(path: string, scope: string): Promise<boolean | null> {
  let head: string;
  try { head = await Bun.file(path).slice(0, JUDGE_HEAD_BYTES).text(); } catch { return null; }
  // Drop the trailing partial line: the slice cut wherever it landed.
  const nl = head.lastIndexOf("\n");
  if (nl < 0) return null;
  const MAX_LINE = maxLineBytes();
  for (const line of head.slice(0, nl).split("\n")) {
    if (!line || !line.includes('"cwd"')) continue;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE) continue;
    let cwd = "";
    try { cwd = str((JSON.parse(line) as Record<string, unknown>).cwd) ?? ""; } catch { continue; }
    if (!cwd) continue;
    // The same pair of tests the full path makes, and for the same reasons —
    // see the block in `ingestFile` that first refused this file.
    return !inScope(cwd, rootsOf(scope)) && !inScope(resolvedRoot(cwd), rootsOf(scope));
  }
  return null;
}

/** The file's mtime, or 0 when it cannot be read. Only ever compared against
 *  another reading of the same thing, so 0 simply means "assume it changed". */
async function mtimeOf(path: string): Promise<number> {
  try { return (await stat(path)).mtimeMs; } catch { return 0; }
}

/** Room for a machine that has run a lot of sessions elsewhere. Each entry is
 *  one short string and three numbers. */
let MAX_REFUSED = 4096;
/** Test-only: shrink the refusal cap so eviction is reachable. */
export function __setMaxRefused(n: number): void { MAX_REFUSED = n; }
export const __noteRefused = (p: string, scope: string, size: number, mtime: number): void => noteRefused(p, scope, size, mtime);
export const __stillRefused = (p: string, scope: string | null, size: number, mtime: number) => stillRefused(p, scope, false, size, mtime);
export const __forgetRefused = (p: string): void => forgetRefused(p);
/** How long a refusal is trusted before it is asked again — see `stillRefused`
 *  for why it has to expire at all, and `judgeByHead` for what re-asking costs.
 *  A minute against a 3-second sweep is 1 read in 20 for a file that is still
 *  somebody else's, and it bounds how long a workspace-visible mistake lasts. */
const REFUSED_TTL_MS = 60_000;
/** How much of a transcript a revalidation reads. 256 KB covers 84 of 90 real
 *  transcripts measured; the rest fall back to the full read. */
const JUDGE_HEAD_BYTES = 256 * 1024;
/** A transcript nobody has appended to in this long is finished, or close
 *  enough; its cached tool inputs can be megabytes, so let them go. Dropping an
 *  entry is always safe — the next sweep just re-reads the file whole. */
const TAIL_IDLE_MS = 10 * 60_000;
/** Hard ceiling on cached files, so a machine running dozens of sessions at once
 *  can't grow this without bound between idle sweeps. Oldest-touched go first.
 *
 *  Sized for the real load: one person can have ~10 sessions live at once, and
 *  each spawns its own subagent transcripts, so the count of files *actively
 *  appending* in a single sweep routinely passes two dozen. At the old 24 the
 *  overflow was evicted every sweep and then cold-read *whole* the next time it
 *  grew — a byte-for-byte re-read of a multi-MB file, which is exactly the
 *  transient-memory spike and event-loop stall the tail was built to avoid. 64
 *  keeps a realistic working set warm on the cheap incremental path; each tail is
 *  also far lighter now that a matched tool_use input is dropped on sight (see
 *  the toolCalls.delete above), so the memory this trades for is modest.
 *
 * MEASURED on a machine running an orchestrator plus a fleet of builder,
 * reviewer and flight-plan agents across several worktrees at once: well over
 * 64 transcripts were actively growing in the same minute, so the 64th-oldest
 * got evicted before its next append and was re-read WHOLE on growth — the
 * exact spike this cache exists to avoid, now every full sweep instead of
 * every sweep. RSS sawtoothed 3-4.8 GB roughly every minute with nothing
 * open in the UI. Env-tunable because "realistic" depends on the fleet. */
const MAX_TAILS = Math.max(64, Number(process.env.AGENTGLASS_SCAN_MAX_TAILS || 512));
/** Drop every cached tail. Exported for the tests, which use it to stand in for
 *  a server restart — offsets gone, `lines_done` intact — and so to prove that
 *  eviction can only cost time, never correctness. */
export function __dropTailCache(keepDisk = false): void {
  tails.clear();
  refused.clear();
  resumeSaved.clear();
  // A real restart keeps the persisted resume and refusal rows; the older tests
  // mean "cold, nothing remembered", so the default empties them too.
  if (!keepDisk) { db.exec("DELETE FROM transcript_resume; DELETE FROM transcript_refused;"); refusedOnDisk.clear(); }
}

/** Age every refusal past its TTL, so a test can watch the revalidation without
 *  waiting a minute for it. Test-only, like `__dropTailCache`. */
export function __expireRefusals(): void {
  for (const e of refused.values()) e.at = 0;
}
function evictTails(now: number): void {
  for (const [path, t] of tails) if (now - t.touched > TAIL_IDLE_MS) tails.delete(path);
  if (tails.size <= MAX_TAILS) return;
  const byAge = [...tails].sort((a, b) => a[1].touched - b[1].touched);
  for (const [path] of byAge.slice(0, tails.size - MAX_TAILS)) tails.delete(path);
}

/**
 * Ingest a transcript, emitting only lines past `from`.
 *
 * Two paths, same result. With a warm `Tail` for this file we read only from the
 * cached byte offset to EOF; otherwise (cold cache, or `allowTail` false because
 * the file was rewritten) we read it whole and skip the first `from` lines,
 * still parsing them so a PostToolUse finds the tool name its PreToolUse
 * recorded. Correctness never depends on the cache being warm.
 *
 * `expectLines` is the `transcript_files.lines_done` the caller read to decide
 * `from`, and it is NOT the same number — a rewritten file is deliberately
 * re-read with `from = 0` while the stored marker still says 900. Every write
 * below is conditional on the stored marker still holding that value, so a
 * second process that moved it in the meantime is detected rather than
 * overwritten. `lost` in the result says that happened.
 */
type IngestResult = { lines: number; ingested: number; source_app: string; project_path: string; session_id: string; skipped?: boolean; lost?: boolean; expect: number; more?: boolean };

/**
 * Bytes of one transcript held as a string at a time.
 *
 * MEASURED: an isolated server started over this machine's real
 * `~/.claude/projects` (12 GB, 74 files over 20 MB, the largest 1.75 GB) went
 * from nothing to 6.8 GB RSS in under 10 seconds and back to 0.7 GB once the
 * first sweep ended. A cold start has no tail cache, so each file was read with
 * one `file.text()`, then `split("\n")` again, then per-line copies: several
 * times the file's size live at once, for a file this cockpit often refuses
 * anyway. Reading in windows bounds that to the window, whatever the file.
 *
 * MEASURED 2026-11-12 on a copy of the real database over the same 13 GB of
 * transcripts (no Jira, no network): at 64 MB the first sweep peaked at 2.15 and
 * 2.25 GB RSS (JS heap only ~285 MB: the rest is native memory for the window
 * text, its split lines and their parsed records, which scales with the window,
 * not the file). Same run, same data: 8 MB peaked at 0.73 GB, 2 MB at 0.54 GB.
 * A window is only a read size, so a smaller one costs a few more reads and no
 * correctness; 4 MB keeps most of the saving.
 */
export const SCAN_WINDOW_DEFAULT_BYTES = 4 * 1024 * 1024;
const windowBytes = () => Math.max(4096, Number(process.env.AGENTGLASS_SCAN_WINDOW_BYTES || SCAN_WINDOW_DEFAULT_BYTES));

/** Ingest a transcript a window at a time; the work per window is `ingestWindow`. */
async function ingestFile(
  path: string,
  fallbackSessionId: string,
  from: number,
  expectLines: number,
  onLive: ((r: InsertResult) => void) | null,
  scope: string | null,
  allowTail = true
): Promise<IngestResult> {
  let ingested = 0;
  let r = await ingestWindow(path, fallbackSessionId, from, expectLines, onLive, scope, allowTail, false);
  ingested += r.ingested;
  while (r.more) {
    // A file that shrinks mid-scan drops its tail, so the next window starts at
    // byte 0 and reports `more` forever without moving `expect`. Every real
    // window ends on a newline and so advances it; one that does not is the
    // loop, and the next sweep re-reads whatever is left.
    const before = r.expect;
    r = await ingestWindow(path, fallbackSessionId, from, r.expect, onLive, scope, true, true);
    ingested += r.ingested;
    if (r.expect <= before) break;
  }
  return { ...r, ingested };
}

async function ingestWindow(
  path: string,
  fallbackSessionId: string,
  from: number,
  expectLines: number,
  onLive: ((r: InsertResult) => void) | null,
  scope: string | null,
  allowTail: boolean,
  continuing: boolean
): Promise<IngestResult> {
  // Read the sweep's tuning once for this file: batch shape and the oversize cap.
  const batchLimits = { lines: batchLines(), bytes: batchBytes(), ms: batchMs() };
  const MAX_LINE = maxLineBytes();
  const file = Bun.file(path);
  let resumedLag = false;
  let cached = allowTail ? tails.get(path) : undefined;
  // Cold cache after a restart: the persisted tail stands in for the warm one.
  if (!cached && allowTail && !continuing) {
    cached = loadResume(path, from, file.size);
    if (cached) { tails.set(path, cached); resumedLag = true; }
  }
  // Only tail when the cache still agrees with the durable progress marker. If
  // they ever drift — a DB row rewritten underneath us, a failed sweep, a file
  // replaced at the same size — the offset points into content it wasn't taken
  // from, which silently drops or duplicates records. Re-reading whole is slow,
  // wrong numbers are forever.
  const tail = cached && (continuing || resumedLag || cached.lines === from) && cached.bytes <= file.size ? cached : undefined;
  if (!tail) {
    tails.delete(path);
    delResume.run(path);
    if (from > 0) coldRereads++;
  }

  let baseByte = tail?.bytes ?? 0;
  const baseLine = tail?.lines ?? 0;
  // One window. A window that is not the file's end is cut at its last newline
  // and ends the chunk there; if it holds no newline at all (one line longer
  // than the window) it doubles until it does, or reaches the end.
  let end = Math.min(file.size, baseByte + windowBytes());
  let chunk = !tail && end >= file.size ? await file.text() : await file.slice(baseByte, end).text();
  if (end < file.size) {
    while (!chunk.includes("\n") && end < file.size) {
      end = Math.min(file.size, end + (end - baseByte));
      chunk = await file.slice(baseByte, end).text();
    }
  }
  const windowed = end < file.size;

  // The previous sweep committed a record whose terminating newline hadn't
  // landed yet (a live write caught between the record's bytes and its "\n",
  // taken by the restIsWholeRecord branch below), so it left the byte offset
  // just before that newline. The newline is now the head of this chunk:
  // consume it as the record's terminator here. Splitting it into a line
  // instead would add a phantom empty record, drift lines_done one past the
  // true count, and make a later cold re-read over-skip — dropping the newest
  // records for good.
  let strippedNewline = false;
  if (tail && !tail.endedWithNewline && chunk.startsWith("\n")) {
    chunk = chunk.slice(1);
    baseByte += 1;
    strippedNewline = true;
  }

  // Cut at the last newline. An active session is appended record by record and
  // a sweep lands mid-write often enough to matter: parsing the half-flushed
  // fragment would fail its JSON.parse *and* count it as done, so the record is
  // lost for good once the writer finishes it. Holding it back means the next
  // sweep, which sees the whole line, ingests it exactly once.
  //
  // A trailing fragment that does parse is a finished record whose newline just
  // hasn't landed — a proper prefix of a JSON object never parses on its own —
  // so it's taken now rather than held back forever, which is what a transcript
  // whose final line has no trailing newline would otherwise do.
  let complete = chunk;
  const nl = chunk.lastIndexOf("\n");
  if (windowed && nl >= 0) {
    // Not the file's end: the cut is a window, not a half-written record.
    complete = chunk.slice(0, nl + 1);
  } else if (nl < chunk.length - 1) {
    const rest = chunk.slice(nl + 1).trim();
    let restIsWholeRecord = false;
    if (rest) {
      try { JSON.parse(rest); restIsWholeRecord = true; } catch { /* half-written */ }
    }
    if (!restIsWholeRecord) complete = chunk.slice(0, nl + 1);
  }
  const lines = complete.split("\n");
  // JSONL ends with a newline, so split() leaves a phantom empty element. Left
  // in, lines_done ends up one past the real record count and the next sweep
  // skips the first line appended after it — which is *every* live line, since
  // sessions grow one record at a time.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  // Whether the processed content ends on a newline decides the byte width of
  // the last record: every line here is newline-terminated except, in the
  // no-trailing-newline case, the final one. The batch loop below accounts for
  // this per line so its running byte offset stays exact — byteLength, not
  // string length, because a transcript is full of non-ASCII (paths, prose,
  // emoji) and a character offset would land mid-codepoint, so the next tail
  // read would start on a broken line.
  const endsWithNewline = complete.endsWith("\n");

  const toolCalls = tail?.toolCalls ?? new Map<string, { name: string; input: unknown }>();
  // Claude Code splits one API response across several transcript lines (one
  // per content block) and repeats the identical `message.usage` on each. Only
  // the first line of a given message.id may carry it, or tokens and cost come
  // out multiplied by the number of blocks in the reply — measured at 2.5x.
  const seenUsage = tail?.seenUsage ?? new Set<string>();

  let cwd: string;
  let session_id: string;
  let source_app: string;
  let project_path: string;
  if (tail) {
    ({ cwd, session_id, source_app, project_path } = tail);
  } else {
    // First pass: read the project path (cwd) and the session id off the
    // transcript's own lines. Both beat inferring them from the file layout —
    // the directory encoding is lossy (a dash in a folder name is
    // indistinguishable from a separator), and a subagent transcript is named
    // after the agent while reporting the *parent* session it belongs to.
    let sniffedCwd = "";
    let sniffedSid = "";
    for (const line of lines) {
      if (!line) continue;
      if (!line.includes('"cwd"') && !line.includes('"sessionId"')) continue;
      // A pathological multi-hundred-MB first line must not block the loop here
      // either; cwd/sessionId live on ordinary small lines, so skipping it costs
      // nothing (the next line carries them).
      if (Buffer.byteLength(line, "utf8") > MAX_LINE) continue;
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        sniffedCwd ||= str(o.cwd) ?? "";
        sniffedSid ||= str(o.sessionId) ?? "";
      } catch { /* skip malformed line */ }
      if (sniffedCwd && sniffedSid) break;
    }
    cwd = sniffedCwd;
    session_id = sniffedSid || fallbackSessionId;
    if (cwd) ({ source_app, project_path } = projectOf(cwd));
    else { source_app = fallbackSessionId.slice(0, 8); project_path = ""; }
  }

  // Opened for one project: a transcript from anywhere else isn't this
  // cockpit's business. Bail before naming it, or it would still show up in
  // the project list despite contributing no events. The scope is pinned per
  // sweep (passed in), so a workspace switched mid-sweep can't suddenly widen
  // a *live* sweep into broadcasting months of backfill.
  //
  // Re-tested on the tail path too, not just when the cwd is freshly sniffed:
  // narrowing the workspace at runtime has to stop a file we were already
  // tailing, or the cache would keep ingesting a project the user just left.
  //
  // Match on the *resolved repo root* as well as the raw cwd: a session running
  // in a project's own linked worktree (e.g. ~/code/app-wt, outside the scope
  // path) belongs to the scoped repo — `--git-common-dir` folds it back — and
  // the git panel already lists such worktrees as part of the project. The raw
  // cwd is tried first, so scoping to a monorepo subdir (whose git root sits
  // *above* the scope) keeps working; inScope() also accepts the scope's own
  // linked worktrees directly, which covers a cockpit opened *on* a worktree.
  if (scope && cwd) {
    if (!inScope(cwd, rootsOf(scope)) && !inScope(resolvedRoot(cwd), rootsOf(scope))) {
      /* Remembered, so the next sweep does not read the whole thing again to
         reach this same answer — see `refused`. The verdict is a fact about
         this file's cwd and this scope, and both are in the key. */
      noteRefused(path, scope, file.size, await mtimeOf(path));
      return { lines: 0, ingested: 0, source_app: "", project_path: "", session_id, skipped: true, expect: expectLines };
    }
  }
  // It is ours after all (the workspace widened, or the cwd moved into scope):
  // forget any older refusal so a later narrowing is judged fresh.
  forgetRefused(path);
  if (cwd) projectPaths.set(source_app, project_path);

  const ctx = { source_app, project_path, cwd, session_id, toolCalls, seenUsage, carryUsage: new Map<string, Record<string, unknown>>() };
  let ingested = 0;
  const fileMtime = (await stat(path)).mtimeMs;
  // What the session is called. Both kinds are appended as their own lines and
  // rewritten on every change, so the *last* one in the file is the current
  // one — carried across sweeps so a tail read that sees no title line still
  // reports the rename that happened before its offset.
  let customTitle: string | null = tail?.customTitle ?? null;
  let aiTitle: string | null = tail?.aiTitle ?? null;

  // The tail row we hand the next sweep, updated to match each committed batch.
  const saveTail = (bytes: number, doneLines: number): void => {
    // At a newline boundary unless we stopped on the file's newline-less final
    // line. When no line was processed this sweep, the offset either advanced by
    // exactly the newline we stripped (now at a boundary) or did not move at all
    // (carry the prior tail's answer forward).
    const endedWithNewline = lines.length === 0
      ? (strippedNewline || (tail?.endedWithNewline ?? true))
      : (i >= lines.length ? endsWithNewline : true);
    tails.set(path, {
      bytes,
      lines: doneLines,
      endedWithNewline,
      toolCalls,
      seenUsage,
      customTitle,
      aiTitle,
      cwd,
      source_app,
      project_path,
      session_id,
      touched: Date.now(),
    });
  };

  // Byte offset just past the last processed line, and the count of leading
  // lines processed — both advance one line at a time inside the batch so a
  // commit can persist an exact resume point. Start where the tail (or the
  // from-zero read) began.
  let consumed = baseByte;
  let doneLines = baseLine;
  let i = 0;
  // What we believe transcript_files.lines_done holds right now: the value the
  // caller read, then whatever each committed batch wrote. Every write below is
  // conditional on it.
  let expect = expectLines;
  // Set when the claim below finds the marker somewhere else — another process
  // is ingesting this file, so we give it up rather than ingest its lines again.
  let lost = false;

  // The per-file loop, in bounded batches that each commit and then yield. See
  // the BATCH_LINES/BATCH_BYTES note up top for why this is not one transaction.
  while (i < lines.length) {
    // Collected inside the transaction, delivered after it commits: broadcasting
    // mid-transaction would push events to clients a rollback would take back,
    // leaving them showing rows the database never kept.
    const emitted: InsertResult[] = [];
    // Snapshot the cursor so a thrown batch leaves consumed/doneLines describing
    // only what actually committed (the transaction rolls back, and so must our
    // idea of progress).
    let bi = i;
    let bConsumed = consumed;
    let bDone = doneLines;
    const retentionCut = RETENTION_DAYS ? Date.now() - RETENTION_DAYS * 86_400_000 : 0;
    const run = db.transaction(() => {
      // THE CLAIM. Re-read the progress marker here, inside the write
      // transaction, and abandon the batch if it is no longer where we left it —
      // a second server process has ingested past this point and these lines are
      // already in the database. Nothing has been parsed or inserted yet at this
      // line, so returning now leaves the in-memory toolCalls/seenUsage maps
      // untouched and the transaction empty.
      //
      // Not `run().changes` on a guarded UPDATE, which is the obvious shortcut
      // and lies: measured on 2026-08-07 it reported 7 for a 3-row DELETE where
      // `SELECT changes()` correctly said 3. An explicit SELECT is the only
      // number here worth trusting.
      if ((linesDoneOf.get(path)?.lines_done ?? 0) !== expect) { lost = true; return; }
      let nInBatch = 0;
      let bytesInBatch = 0;
      const batchT0 = performance.now();
      while (bi < lines.length && !batchFull(nInBatch, bytesInBatch, performance.now() - batchT0, batchLimits)) {
        const raw = lines[bi]!;
        const lineBytes = Buffer.byteLength(raw, "utf8");
        // Every line here is newline-terminated except possibly the very last.
        const hasNl = bi < lines.length - 1 || endsWithNewline;
        bConsumed += lineBytes + (hasNl ? 1 : 0);
        bDone = baseLine + bi + 1;
        bytesInBatch += lineBytes;
        nInBatch++;
        const idx = bi;
        bi++;

        const line = raw.trim();
        if (!line) continue;
        // A single abnormally large line is not parsed on the loop — one
        // uninterruptible JSON.parse no batching can subdivide. Its bytes still
        // counted toward the offset above, so the record is stepped over cleanly.
        if (lineBytes > MAX_LINE) { noteOversize(path, lineBytes); continue; }
        let o: Record<string, unknown>;
        try {
          linesParsed++;
          o = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        // Not events, so lineToBodies drops them — but they're the only place the
        // session's human name exists.
        if (o.type === "custom-title") customTitle = str(o.customTitle) ?? customTitle;
        else if (o.type === "ai-title") aiTitle = str(o.aiTitle) ?? aiTitle;
        let bodies = lineToBodies(o, ctx, fileMtime);
        /* Claude Code writes ONE jsonl line per content block, all with the same message.id: a
           reply that narrates and then calls a tool is a text-only line followed by a tool_use
           line. The text line looked like a turn end, so every narrated tool call recorded a
           Stop (one orchestrator session: 42,369 Stop rows over 3 days on a few hundred turns).
           A text line that the next line of the same reply continues with a tool_use is not an
           end of turn. */
        if (bodies.length === 1 && bodies[0]!.hook_event_type === "Stop" && repliesWithToolUse(o, lines, bi)) {
          // The Stop was the row carrying the reply's usage: hand it to the tool_use line.
          const u = (bodies[0]!.payload as { usage?: Record<string, unknown> }).usage;
          const mid = str((o.message as Record<string, unknown> | undefined)?.id);
          if (u && mid && !ctx.carryUsage.has(mid)) ctx.carryUsage.set(mid, u);
          bodies = [];
        }
        // Absolute position in the file: on the tail path the chunk starts at
        // baseLine, so `from` still means "lines already ingested".
        if (baseLine + idx < from) continue; // already ingested — parsed only for tool names/state
        for (const body of bodies) {
          /* Not past the retention window. A rewritten transcript (it got shorter: a resume or a
             compaction) is re-read from line 0, and a long session's file holds every line it ever
             had. Those went back in with their old timestamps, after the prune had already folded
             them into daily_rollup: measured on the live DB, 47,082 events 8-17 days old from ONE
             session, ids spread over 1M inserts, days that daily_rollup already held. They were
             deleted at the next hourly prune and came back at the next rewrite, and every round
             folded them into the roll-up again. The line still counts as read; only the row is not
             kept. Retention 0 keeps everything, so there is no cutoff then. */
          if (retentionCut && Number(body.timestamp) < retentionCut) continue;
          emitted.push(insertEvent(normalize(body)));
          ingested++;
        }
      }
      // Advance the durable progress marker WITH this batch's inserts, in the
      // same transaction, so lines_done can never name a line whose events did
      // not commit. Only ever forward (bDone > from): a from-zero re-read of an
      // already-ingested prefix parses those lines to rebuild toolCalls/seenUsage
      // but must not walk lines_done backwards. A partial `size` marker (bytes
      // consumed, mtime 0) is deliberately unequal to the real file size until
      // scanOnce writes the final row, so an interrupted file is re-examined —
      // never skipped as done — on the next sweep, and resumed from exactly here.
      if (bDone > from) {
        putFileIfUnmoved.run({
          $path: path,
          $sid: session_id,
          $src: source_app,
          $proj: project_path,
          $lines: bDone,
          $size: bConsumed,
          $mtime: 0,
          $expect: expect,
        });
      }
    });
    try {
      // IMMEDIATE, not the default deferred. A deferred transaction takes its
      // read snapshot on the claim above and only asks for the write lock at the
      // first insert — so a second process that commits in between makes that
      // upgrade fail outright with SQLITE_BUSY_SNAPSHOT, which busy_timeout does
      // NOT wait out (measured: "database is locked" aborting a whole file's
      // sweep). Taking the write lock at BEGIN turns that into an ordinary wait
      // and makes claim-then-write one indivisible step across processes.
      // Labelled, because the write lock is the one place a batch can WAIT
      // rather than compute: the server's own stall log shows 92% of its stalls
      // over 1.5 s as "waiting, not computing" (tens of ms of CPU inside
      // seconds), and a lock wait here used to be filed under whatever label
      // happened to be entered last.
      waitedFor("transcript batch commit", () => run.immediate());
    } catch (e) {
      // The rollback undoes this batch's inserts and its progress row, but not
      // the in-memory maps lineToBodies already mutated — seenUsage in
      // particular would suppress the usage of every message in this batch on the
      // retry, losing those tokens for good. Drop the tail so the retry rebuilds
      // it from the file; earlier batches stay committed and their lines_done
      // stands, so the retry resumes past them without re-ingesting them.
      tails.delete(path);
      throw e;
    }
    if (lost) {
      // Someone else owns this file's progress now. Drop the tail: its byte
      // offset describes a position the other process has already moved past, so
      // the next sweep must re-read from whatever marker they leave behind
      // rather than resume from ours. Committed batches stay committed.
      tails.delete(path);
      return { lines: doneLines, ingested, source_app, project_path, session_id, lost: true, expect };
    }
    // Committed: adopt the batch's cursor, refresh the tail to match, and only
    // now push the events — they are durable, so a later batch failing can't
    // un-say them.
    i = bi;
    consumed = bConsumed;
    doneLines = bDone;
    // Only a batch that actually wrote moved the marker; a from-zero re-read of
    // an already-ingested prefix (bDone <= from) leaves it where it was.
    if (bDone > from) expect = bDone;
    saveTail(consumed, doneLines);
    for (const r of emitted) onLive?.(r);
    // Hand the loop back between batches so the PTY runs. Not after the last
    // batch — nothing waits on this file, and the sweep moves to the next one.
    if (i < lines.length) await yieldLoop(terminalHot());
  }

  // The session row exists now (created by the inserts), so a title has
  // something to attach to. A file with no complete new lines skipped the loop
  // entirely; still refresh the tail so its byte/line offset is recorded.
  if (customTitle || aiTitle) setSessionTitles(session_id, customTitle, aiTitle);
  saveTail(consumed, doneLines);
  return { lines: doneLines, ingested, source_app, project_path, session_id, expect, ...(windowed ? { more: true } : {}) };
}

/** Every *.jsonl under a project dir, at any depth.
 *  Claude Code nests a session's subagent transcripts in
 *  `<session-id>/subagents/`, and those are the multi-agent runs the whole
 *  dashboard is about — a flat listing would miss all of them.
 *
 *  Asynchronous: this walk is the sweep's cold cost. Measured over a real
 *  `~/.claude/projects`, the 3s sweep spent thousands of blocking readdir/stat
 *  calls before it opened a single file — 3,678 ms of a frozen terminal in the
 *  log, all of it in the walk. Awaiting each one hands the loop back. */
async function walkTranscripts(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walkTranscripts(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/**
 * Most of the transcripts on disk are finished. Measured on a machine with 3247
 * of them (4.4 GB), the 3s sweep spent ~1100 stat calls a second — plus a
 * database lookup each — confirming that files nobody has touched in days still
 * had not changed. A file untouched for COLD_MS is looked at again only on a
 * full sweep, every FULL_MS; the ticks in between walk the directories (a new
 * file still turns up within one tick) and stat only what is warm or unknown.
 *
 * What that gives up: a cold transcript that gets appended to — an old session
 * resumed — is noticed up to FULL_MS late instead of 3s. Its own hooks still
 * report its events live, so the delay is the backfill's, not the screen's.
 * That is the FALLBACK poll now. With file watching available the sweep reads
 * only what a watch event marked (see watcher below), and this walk happens at
 * startup and on the 5-minute reconcile, not every 3 s.
 */
const COLD_MS = 10 * 60_000;
const FULL_MS = 60_000;
/** Last mtime seen for each transcript, so a light sweep can tell warm from cold. */
const lastMtime = new Map<string, number>();

/** Transcripts the last budgeted sweep left for the next one. */
let backlog = 0;
export const scanBacklog = () => backlog;

/**
 * The cold-start backfill is not one sweep but a run of them, each reading at
 * most this many bytes, newest transcript first, with a pause between: the
 * duty cycle is what bounds the CPU the backfill takes from the loop the PTY
 * rides, and nothing is dropped — every file it did not reach is the next
 * chunk's. Read per call, like the batch limits.
 *
 * Measured on 289 MB of transcripts: total CPU is the same as one big sweep
 * (33 s); what changes is that the newest session is in after 0.6 s instead of
 * after the last file. Not here: a queue kept across chunks. Each chunk walks
 * and stats every file again, which is cheap next to the reads it saves.
 */
const coldBudgetBytes = () => Math.max(1024 * 1024, Number(process.env.AGENTGLASS_SCAN_COLD_BUDGET_BYTES || 128 * 1024 * 1024));
/** What a workspace change reads before answering; see resyncScope(). */
const resyncBudgetBytes = () => Math.max(1024 * 1024, Number(process.env.AGENTGLASS_SCAN_RESYNC_BUDGET_BYTES || 8 * 1024 * 1024));
const coldPauseMs = () => Math.max(0, Number(process.env.AGENTGLASS_SCAN_COLD_PAUSE_MS ?? 200));

/** One sweep over every project directory under every root.
 *  Exported for the scanner tests, which drive sweeps by hand rather than
 *  waiting on the 3s timer. `full` (the default) looks at every file; the
 *  timer passes false between full sweeps. A `budget` (bytes) stops the sweep
 *  once that much has been read, newest first; see scanBacklog(). */
/** How many stat calls one wave of the walk has in flight.
 *  Measured: one `await stat()` after another, 200,000 files took 4 s on an idle
 *  machine and did not finish in 120 s with all 20 cores busy. The time is not
 *  the stat: each await is a round trip to the I/O thread and back, and on a
 *  busy machine each wake-up waits for a free core. A wave of 32 pays that wait
 *  once for 32 files. The loop does the same work either way. */
const STAT_WAVE = 32;

/** `stat` of every path in waves of STAT_WAVE, in order; null where it failed. */
async function statEach(paths: string[]): Promise<(Stats | null)[]> {
  const out: (Stats | null)[] = [];
  for (let i = 0; i < paths.length; i += STAT_WAVE) {
    out.push(...(await Promise.all(paths.slice(i, i + STAT_WAVE).map((p) => stat(p).catch(() => null)))));
  }
  return out;
}

export async function scanOnce(onLive: ((r: InsertResult) => void) | null, full = true, budget = Infinity, only?: Iterable<string>): Promise<number> {
  // Read the workspace once per sweep so every file in it sees the same scope.
  // As one string — every open project, NUL-separated — because it is also the
  // key the refused-file memo compares; see rootsOf().
  const scope = scopeKey() || null;
  // Transcripts older than the retention window would be pruned on the next
  // sweep anyway, so never spend time parsing them.
  const cutoff = RETENTION_DAYS ? Date.now() - RETENTION_DAYS * 86_400_000 : 0;
  let total = 0;

  // Gathered first, so the newest transcript is read first: on a cold database
  // the session somebody is looking at is ingested before the week-old ones
  // behind it, instead of whenever its directory happened to sort.
  const queue: { path: string; st: Stats }[] = [];
  if (only) {
    // Watch-driven: the caller already knows which files moved, so no walk and
    // no stat of anything else. This is what makes an idle machine free.
    for (const path of only) {
      let st: Stats;
      try {
        st = await stat(path);
      } catch {
        lastMtime.delete(path);
        continue;
      }
      lastMtime.set(path, st.mtimeMs);
      if (cutoff && st.mtimeMs < cutoff) continue;
      queue.push({ path, st });
    }
  }
  else for (const root of projectsDirs()) {
    let dirs: string[];
    try {
      dirs = await readdir(root);
    } catch {
      continue; // this root doesn't exist (yet) — the others still count
    }
    for (const dir of dirs) {
      const dirPath = join(root, dir);
      try {
        if (!(await stat(dirPath)).isDirectory()) continue;
      } catch {
        continue;
      }
      const want = (await walkTranscripts(dirPath)).filter((path) => {
        const seen = lastMtime.get(path);
        return full || seen === undefined || Date.now() - seen <= COLD_MS;
      });
      const stats = await statEach(want);
      resumedAs(SCAN_LABEL);
      want.forEach((path, i) => {
        const st = stats[i];
        if (!st) { lastMtime.delete(path); return; }
        lastMtime.set(path, st.mtimeMs);
        if (cutoff && st.mtimeMs < cutoff) return; // outside retention
        queue.push({ path, st });
      });
    }
  }
  queue.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);

  let spent = 0;
  backlog = 0;
  let sliceStart = performance.now();
  for (const { path, st } of queue) {
    // A run of files, each under the batch caps, still adds up: hand the loop
    // back between files once the sweep has held it for its slice.
    if (shouldYield(performance.now() - sliceStart, fileSliceMs())) {
      await yieldLoop(terminalHot());
      sliceStart = performance.now();
    }
    // The budget is spent: leave this file for the next sweep. It must not
    // stay in lastMtime, or a light sweep would take a file nobody has read
    // yet for a cold one and not look at it again until the next full sweep.
    if (spent >= budget) {
      lastMtime.delete(path);
      backlog++;
      continue;
    }
    const prev = getFile.get(path);
    // Unchanged since last sweep → skip without opening it.
    if (prev && prev.size === st.size && prev.mtime === Math.floor(st.mtimeMs)) {
      owned.add(prev.session_id);
      continue;
    }

    try {
      // A transcript that got *shorter* was rewritten, not appended to, so a
      // saved offset now points into different content. Re-read it whole
      // rather than skipping past records that no longer exist.
      const rewritten = !!prev && st.size < prev.size;
      /* Already judged somebody else's, by THIS workspace: skip it without
         opening it. This is the whole fix for the 6.5 GB/min — a live
         session in another repo grows every second, and every one of those
         growths used to buy a full re-read of a file whose bytes we then
         threw away. */
      const verdict = stillRefused(path, scope, rewritten, st.size, st.mtimeMs);
      if (verdict === "yes") continue;
      /* The verdict has aged out, but this file was somebody else's a
         minute ago. Ask the cheap way before falling back to reading a live
         multi-hundred-megabyte transcript whole. */
      if (verdict === "stale" && scope) {
        const again = await judgeByHead(path, scope);
        resumedAs(SCAN_LABEL);
        if (again === true) { noteRefused(path, scope, st.size, st.mtimeMs); continue; }
        // false, or "the head could not say": both go the long way. false
        // because the file has come into scope and now has to be INGESTED,
        // and null because a head that found no cwd must never be believed —
        // `ingestFile` reads an empty cwd as "no scope test to make".
        forgetRefused(path);
      }
      // This read is outside any transaction and is only a *hint* by the time
      // the batch below writes — see putFileIfUnmoved. `from` and the marker
      // are different numbers on the rewrite path, so both travel.
      const marker = prev?.lines_done ?? 0;
      const from = rewritten ? 0 : marker;
      // A rewrite also invalidates the cached tail: its byte offset and its
      // carried tool calls describe content that no longer exists.
      const r = await ingestFile(path, basename(path, ".jsonl"), from, marker, onLive, scope, !rewritten);
      resumedAs(SCAN_LABEL);
      // Out of scope: claim nothing, so widening the scope later can still
      // pick it up, and the hook path isn't blocked for a session we skipped.
      if (r.skipped) continue;
      // Still ours to skip on the hook path: the transcript exists and is
      // being read from disk, whichever process is doing the reading.
      owned.add(r.session_id);
      total += r.ingested;
      spent += st.size - (rewritten ? 0 : prev?.size ?? 0);
      // Another process moved the marker mid-file. Writing the final row now
      // would stamp our stale line count — and a size/mtime saying "fully
      // done" — over their progress, which is the double-ingest this whole
      // path exists to prevent. Leave the file to them; the next sweep picks
      // it up from wherever they left it.
      if (r.lost) continue;
      putFileIfUnmoved.run({
        $path: path,
        $sid: r.session_id,
        $src: r.source_app,
        $proj: r.project_path,
        $lines: r.lines,
        $size: st.size,
        $mtime: Math.floor(st.mtimeMs),
        $expect: r.expect,
      });
      saveResume(path);
    } catch (e) {
      console.error(`[scan] ${path}: ${e instanceof Error ? e.message : e}`);
    }
  }
  // Once per sweep, not per file: the tail cache holds every tool call's input
  // for each transcript it follows, which is the one collection here that can
  // grow with session length rather than with the number of projects.
  evictTails(Date.now());
  return total;
}

// Shared between the interval watcher and resyncScope, so a manual catch-up
// sweep and a timed one never run over the same files at once.
//
// A module-level flag serialises sweeps inside ONE process and says nothing
// about a second process on the same database file — which is a real
// configuration, not a hypothetical one. That half is handled twice over: the
// boot claim in db.ts stops a second scanner from starting, and the
// compare-and-swap on `lines_done` above stops one that somehow does.
let sweepBusy = false;

/**
 * Catch the scanner up after the workspace scope changed at runtime.
 *
 * Widening the scope makes previously skipped transcripts eligible — but they
 * are *historical backfill*, not live activity, so this sweep deliberately
 * passes no onLive: broadcasting months of old events would flood every
 * client and fire alerts for things long finished (the same reason the
 * startup backfill is silent). Waits out a sweep already running first.
 */
export async function resyncScope(): Promise<void> {
  if (!scanningEnabled()) return;
  while (sweepBusy) await new Promise((r) => setTimeout(r, 200));
  sweepBusy = true;
  let handedOn = false;
  try {
    // Only the newest transcripts are read before answering: the picker waits
    // on this call with nothing to show, and reading every newly eligible
    // transcript in one go kept it there for minutes. The rest is backfill
    // nobody is looking at yet; it follows in chunks, newest first, holding
    // the busy flag so no second sweep double-counts a file.
    await scanOnce(null, true, resyncBudgetBytes());
    if (backlog) {
      handedOn = true;
      void (async () => {
        try {
          do {
            await new Promise((r) => setTimeout(r, coldPauseMs()));
            await scanOnce(null, true, coldBudgetBytes());
          } while (backlog);
        } catch (e) {
          console.error(`[scan] rescope backfill failed: ${e instanceof Error ? e.message : e}`);
        } finally {
          sweepBusy = false;
        }
      })();
    }
  } catch (e) {
    console.error(`[scan] rescope sweep failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    if (!handedOn) sweepBusy = false;
  }
}

/** How long the picker may spend waiting for a rescope before it is answered anyway. */
export const RESYNC_ANSWER_MS = 2_000;

/**
 * `resyncScope()`, but the caller does not sit through a whole-machine sweep.
 *
 * A cold server holds one flag while it backfills everything on disk, and
 * `resyncScope` waits on it before it starts: measured 40 s for the first
 * "Open 1" of a fresh instance (32 ms for the same call straight after). The
 * switch is already applied either way; the page that follows reads what is
 * there and this keeps filling it.
 */
export async function resyncScopeBounded(ms = RESYNC_ANSWER_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((r) => { timer = setTimeout(() => r(false), ms); });
  try {
    return await Promise.race([resyncScope().then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Backfill everything on disk, then keep watching for new lines.
 * The initial sweep doesn't broadcast — it can be tens of thousands of events,
 * and no client is interested in replaying history frame by frame.
 */
/**
 * Give already-ingested sessions their names, once.
 *
 * The sweep only re-reads a transcript whose size or mtime moved, which is
 * exactly right for events and exactly wrong for a field that didn't exist when
 * those files were last read. Without this, every session on the machine keeps
 * showing a uuid until it happens to be worked on again — which for a finished
 * session is never.
 *
 * Only touches sessions with no title at all, so it's a no-op on every start
 * after the first, and it reads just the title lines rather than re-ingesting:
 * the events are already in, and re-parsing them would be minutes of work to
 * change one column.
 */
async function backfillTitles(): Promise<number> {
  const rows = db.query<{ path: string; session_id: string }, []>(`
    SELECT f.path, f.session_id FROM transcript_files f
    JOIN sessions s ON s.session_id = f.session_id
    WHERE s.custom_title IS NULL AND s.ai_title IS NULL
  `).all();
  let named = 0;
  for (const { path, session_id } of rows) {
    let text: string;
    try {
      text = await Bun.file(path).text();
    } catch { continue; } // deleted since — nothing to name
    // Cheap reject: the overwhelming majority of transcripts are megabytes with
    // no title line at all, and a substring test beats parsing every line.
    if (!text.includes('"custom-title"') && !text.includes('"ai-title"')) continue;
    let custom: string | null = null, ai: string | null = null;
    for (const line of text.split("\n")) {
      if (!line.includes("-title")) continue;
      // A title line is tiny; a multi-hundred-MB line that happens to contain the
      // substring "-title" in some base64 payload is not one, and must not be
      // parsed on the loop.
      if (line.length > maxLineBytes()) continue;
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        if (o.type === "custom-title") custom = str(o.customTitle) ?? custom;
        else if (o.type === "ai-title") ai = str(o.aiTitle) ?? ai;
      } catch { /* skip malformed line */ }
    }
    if (custom || ai) { setSessionTitles(session_id, custom, ai); named++; }
    // Yield between files: this runs right after the cold-start backfill, over
    // as many files as the machine has titleless sessions, and each one's read
    // and scan is loop time the PTY would otherwise wait on.
    await yieldLoop(terminalHot());
  }
  return named;
}

/** A missed watch event is caught by a full walk at most this often, and only
 *  while the app is in use. */
const RECONCILE_MS = 5 * 60_000;

/**
 * What this file uses of a directory watcher: stop it, and hear that it broke.
 *
 * Written out rather than taken from `FSWatcher`, because the typecheck did not
 * agree with itself about that type: one install's declarations give it the
 * event emitter's `on`, another's do not ("Property 'on' does not exist on type
 * 'FSWatcher'"), and the difference is which @types/node the lockfile of the
 * checkout resolved. At run time it is an event emitter in Bun and in Node, and
 * an 'error' nobody listens for is thrown, so the listener is not optional.
 */
type DirWatch = { close(): void };

/** One non-recursive watcher per directory under every projects root; see
 *  transcriptDirty.ts for why not recursive. Marks transcripts dirty; reads
 *  nothing. */
const watcher = {
  /** One inotify instance for every directory; wd -> directory. */
  ino: null as Watcher | null,
  /** Seam: a test forces this to return null to take the no-inotify path. */
  openWatcher: openWatcher as typeof openWatcher,
  /** inotify is not available here (macOS): watch each directory with fs.watch. */
  noIno: false,
  wds: new Map<number, string>(),
  /** false once any directory could not be watched: the caller then polls. */
  ok: false,
  /** Transcripts to read, oldest mark first: a file marked again moves to the
   *  end, so the end of the set is what changed last (see takeNewest). */
  dirty: new Set<string>(),
  dirDirty: new Set<string>(),
  onDirty: (() => {}) as () => void,
  dirs: new Map<string, DirWatch>(),
  mark(path: string): void {
    this.dirty.delete(path);
    this.dirty.add(path);
  },
  onEvent(e: WatchEvent): void {
    if (e.mask & IN_Q_OVERFLOW) {
      // Events were lost, so any append may have been: every transcript read
      // so far is dirty, and every root is looked at again for new directories.
      for (const f of lastMtime.keys()) this.mark(f);
      for (const r of projectsDirs()) this.dirDirty.add(r);
      this.onDirty();
      return;
    }
    const dir = this.wds.get(e.wd);
    if (dir === undefined) return;
    if (e.mask & (IN_IGNORED | IN_DELETE_SELF | IN_MOVE_SELF)) {
      // The directory went away: forget it; syncDir tells gone from unwatchable.
      this.dirs.delete(dir);
      this.wds.delete(e.wd);
      // A rename leaves the kernel watch behind (a delete does not).
      if (e.mask & IN_MOVE_SELF) { try { this.ino?.rm(e.wd); } catch { /* already gone */ } }
      this.dirDirty.add(dir);
      this.onDirty();
      return;
    }
    this.onName(dir, e.name === "" ? null : e.name);
  },
  /** One entry of `dir` changed (from inotify or fs.watch). */
  onName(dir: string, name: string | null): void {
    const v = judgeWatchEvent(dir, name);
    if (v.kind === "file") this.mark(v.path);
    else if (v.kind === "dir" && !(this.dirs.has(v.path) && v.path !== dir)) this.dirDirty.add(v.path);
    else return;
    this.onDirty();
  },
  /** fs.watch fallback: close and forget the watcher of a folder that no longer exists, and mark it dirty. */
  dropIfGone(dir: string): void {
    const d = this.dirs.get(dir);
    if (!d) return;
    try { statSync(dir); return; } catch { /* gone */ }
    try { d.close(); } catch { /* already closed */ }
    this.dirs.delete(dir);
    this.dirDirty.add(dir);
    this.onDirty();
  },
  /** Watch `dir` if it is not watched yet. false when watching itself failed. */
  watchDir(dir: string): boolean {
    if (this.dirs.has(dir)) return true;
    try {
      if (!this.ino && !this.noIno) {
        this.ino = this.openWatcher((evs) => {
          for (const e of evs) this.onEvent(e);
        }, IN_MODIFY | IN_CREATE | IN_MOVED_TO | IN_DELETE_SELF | IN_MOVE_SELF);
        if (!this.ino) this.noIno = true;
      }
      if (this.noIno) {
        // No inotify (macOS): one fs.watch per directory, never per file.
        const w = fsWatch(dir, { persistent: false }, (ev, name) => {
          if (ev === "rename") {
            // A deleted folder emits no error, and some runtimes send no event for the folder itself:
            // check this folder and the child the event names, and drop the watcher of any that is gone,
            // so a folder recreated under the same name is watched again.
            this.dropIfGone(dir);
            if (name) this.dropIfGone(join(dir, String(name)));
          }
          this.onName(dir, name ? String(name) : null);
        });
        (w as unknown as { on(ev: string, f: () => void): void }).on("error", () => {
          try { w.close(); } catch { /* already closed */ }
          if (this.dirs.get(dir)?.close === close) this.dirs.delete(dir);
          this.dirDirty.add(dir);
          this.onDirty();
        });
        const close = () => w.close();
        this.dirs.set(dir, { close });
        return true;
      }
      if (!this.ino) return false;
      const wd = this.ino.add(dir);
      if (wd < 0) return false;
      const prev = this.wds.get(wd);
      if (prev && prev !== dir) this.dirs.delete(prev);
      this.wds.set(wd, dir);
      this.dirs.set(dir, { close: () => { if (this.wds.get(wd) === dir) this.wds.delete(wd); } });
      return true;
    } catch {
      return false;
    }
  },
  /**
   * Watch `dir` and everything under it; files found in a directory that was
   * not watched before are dirty (they may have been written in the gap).
   *
   * The watch is set BEFORE the directory is listed. The other way round, a
   * file created between the listing and the watch is in neither: not in the
   * list, and no event for it. And a directory that cannot be watched still
   * has its files marked: the first version returned before marking them, so
   * with the watch refused (no inotify room) a new project's transcripts were
   * never read at all while nobody had the app open, since the only other net,
   * the reconcile walk, runs only then.
   */
  async syncDir(dir: string, markNew = true): Promise<void> {
    if (NON_TRANSCRIPT_DIRS.has(basename(dir))) return;
    const fresh = !this.dirs.has(dir);
    const watched = this.watchDir(dir);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Not a directory, or gone since the event: nothing to watch here.
      if (fresh && watched) {
        const w = this.dirs.get(dir);
        this.dirs.delete(dir);
        try { w?.close(); } catch { /* already closed */ }
      }
      return;
    }
    if (!watched) this.ok = false;
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await this.syncDir(p, markNew);
      else if (markNew && (fresh || !watched) && e.isFile() && e.name.endsWith(".jsonl")) this.mark(p);
    }
  },
  /** Every root, every directory. Roots that do not exist yet are skipped;
   *  the reconcile tries again. */
  async attach(): Promise<void> {
    this.ok = true;
    // Not marking anything dirty: the startup backfill and the reconcile walk
    // read every file anyway.
    for (const root of projectsDirs()) await this.syncDir(root, false);
  },
};
export const __watcherForTest = watcher;
export const __lastMtimeForTest = lastMtime;

export function startScanner(onLive: (r: InsertResult) => void, inUse: () => boolean = () => true): void {
  if (!SCAN_ENABLED) {
    console.log("📴 transcript scan disabled (AGENTGLASS_SCAN_DISABLED=1)");
    return;
  }
  // Another server already has this database file. Two scanners over one file
  // silently double events, tokens and cost (see db.ts), so this one serves and
  // ingests hooks but does not sweep. Loud, because the usual cause is a test
  // server started without AGENTGLASS_DB and the symptom is otherwise "the
  // dashboard is fine but the numbers are wrong".
  const holder = dbClaimedElsewhere();
  if (holder) {
    console.warn(
      `📴 transcript scan disabled — ${dbPath()} is already claimed by pid ${holder.pid} (port ${holder.port}). ` +
        `Point this server at its own AGENTGLASS_DB to scan.`
    );
    return;
  }
  const t0 = Date.now();
  // The startup backfill holds the same busy flag as every other sweep. It
  // didn't once, and a /workspace switch during a long cold-start backfill
  // kicked off a second concurrent scanOnce over the same files — both saw
  // "no row yet" for a transcript, both inserted its lines, and every count,
  // token and dollar for those sessions was silently doubled in the DB.
  sweepBusy = true;
  entered("first transcript scan");
  // Watching starts BEFORE the backfill, so a transcript that grows while it
  // runs is marked dirty instead of falling in the gap. The backfill's own
  // files are marked too (a new directory's files count as written), which
  // costs each one a stat and a database lookup when the sweep after it runs.
  const attached = watcher.attach().catch(() => { watcher.ok = false; });
  const coldBackfill = async (): Promise<number> => {
    let n = 0;
    do {
      n += await scanOnce(null, true, coldBudgetBytes());
      resumedAs(SCAN_LABEL);
      if (backlog) await new Promise((r) => setTimeoutAs(SCAN_LABEL, r as () => void, coldPauseMs()));
    } while (backlog);
    return n;
  };
  attached.then(() => coldBackfill())
    .then((n) => {
      const projects = projectPaths.size;
      console.log(
        `📚 scanned ${projectsDirs().join(", ")} — ${n} events from ${projects} project${projects === 1 ? "" : "s"} in ${Date.now() - t0}ms`
      );
      // After the sweep, so freshly-discovered sessions are already rows.
      backfillTitles()
        .then((named) => { if (named) console.log(`🏷  named ${named} session${named === 1 ? "" : "s"} from their transcripts`); })
        .catch((e) => console.error(`[scan] title backfill failed: ${e instanceof Error ? e.message : e}`));
      let skipped = 0;
      let lastFull = Date.now();
      // One sweep, whichever way it was asked for. A slow sweep must not stack
      // up behind the timer, and typing takes priority (never skipped more than
      // three times in a row, or a busy session would stop ingesting).
      const sweep = async (run: () => Promise<unknown>): Promise<boolean> => {
        if (sweepBusy) return false;
        if (backoff() > 1 && skipped < 3) { skipped++; return false; }
        skipped = 0;
        entered("transcript sweep");
        sweepBusy = true;
        try { await run(); } catch (e) {
          console.error(`[scan] sweep failed: ${e instanceof Error ? e.message : e}`);
        } finally { sweepBusy = false; }
        return true;
      };
      // Watching is not available (no inotify room, no such platform), or
      // stopped being available for some directory later: the old poll,
      // unchanged. Costly when idle, and the only honest fallback. Started at
      // most once; the watch events that still arrive only make it sooner.
      let polling = false;
      const poll = () => {
        if (polling) return;
        polling = true;
        console.warn("[scan] file watching unavailable; polling every " + POLL_MS + "ms");
        setIntervalAs("transcript sweep", () => void sweep(async () => {
          const now = Date.now();
          const full = now - lastFull >= FULL_MS;
          if (full) lastFull = now;
          await scanOnce(onLive, full);
        }), POLL_MS);
      };
      if (!watcher.ok) { poll(); return; }
      // Event-driven. No timer wakes while nothing changed: a watch event arms
      // one sweep POLL_MS out (so a burst of appends is one read), and the only
      // standing timer is the reconcile below. Worst-case delay for a MISSED
      // event is one reconcile: RECONCILE_MS (5 min) after the last one while the
      // app is in use, checked every RECONCILE_MS / 2, so at most 7.5 min.
      let armed: ReturnType<typeof setTimeout> | null = null;
      let lastReconcile = Date.now();
      const arm = (ms = POLL_MS) => { if (!armed) armed = setTimeoutAs("transcript tick", tick, ms); };
      const tick = async () => {
        armed = null;
        const plan = planTick({
          dirty: watcher.dirty.size,
          dirDirty: watcher.dirDirty.size,
          now: Date.now(),
          lastReconcile,
          reconcileMs: RECONCILE_MS,
          inUse: inUse(),
        });
        if (plan === "idle") return;
        const ran = await sweep(async () => {
          if (plan === "reconcile") {
            lastReconcile = Date.now();
            watcher.dirty.clear();
            watcher.dirDirty.clear();
            // attach() says whether every directory is watched NOW, so a
            // failure that has healed (room again) is not held against it; the
            // poll, once started, stays.
            await watcher.attach();
            await scanOnce(onLive, true);
            return;
          }
          const dirs = [...watcher.dirDirty];
          watcher.dirDirty.clear();
          for (const d of dirs) await watcher.syncDir(d);
          /* At most DIRTY_CHUNK files a sweep, the last marked first. The
             first version handed the sweep every dirty file at once, and a
             sweep finishes its list before the next one starts: when a tree of
             200,000 transcripts appeared, whatever the first tick had seen of
             it (tens of thousands of files) was read to the end before a
             transcript written afterwards was looked at. The test that drops
             such a tree in and waits for the one in-scope transcript, written
             last, gave up after 120 s without it; this order is the cause as
             read from the code, not one that was timed. The rest stays in the set for the next
             sweep, which follows after the cold pause instead of a whole poll
             interval. */
          const files = takeNewest(watcher.dirty, DIRTY_CHUNK);
          if (files.length) await scanOnce(onLive, false, Infinity, files);
        });
        // A directory could not be watched, now or since: poll as well.
        if (!watcher.ok) poll();
        // Skipped (busy, or typing): the work is still in the sets.
        if (!ran) arm();
        else if (watcher.dirty.size || watcher.dirDirty.size) arm(Math.min(POLL_MS, coldPauseMs()));
      };
      watcher.onDirty = () => arm();
      // The net under a missed event. Not a poll: it asks the clock, and does
      // nothing at all unless somebody is looking at the app.
      setIntervalAs("transcript reconcile", () => { if (inUse()) void tick(); }, RECONCILE_MS / 2).unref?.();
      arm();
    })
    .catch((e) => console.error(`[scan] initial sweep failed: ${e}`))
    .finally(() => { sweepBusy = false; });
}
