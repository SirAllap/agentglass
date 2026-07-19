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

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { IngestBody } from "../../shared/types.ts";
import { normalize } from "./ingest.ts";
import { db, insertEvent, RETENTION_DAYS, type InsertResult } from "./db.ts";
import { projectRootOf, safeAbs } from "./git.ts";
import { workspaceRoot } from "./config.ts";

const PROJECTS_DIR =
  process.env.AGENTGLASS_PROJECTS_DIR || join(homedir(), ".claude", "projects");
const POLL_MS = Math.max(500, Number(process.env.AGENTGLASS_SCAN_INTERVAL_MS || 3000));
export const SCAN_ENABLED = process.env.AGENTGLASS_SCAN_DISABLED !== "1";

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
const putFile = db.query(`
  INSERT INTO transcript_files (path, session_id, source_app, project_path, lines_done, size, mtime)
  VALUES ($path, $sid, $src, $proj, $lines, $size, $mtime)
  ON CONFLICT(path) DO UPDATE SET
    session_id = excluded.session_id,
    source_app = excluded.source_app,
    project_path = excluded.project_path,
    lines_done = excluded.lines_done,
    size = excluded.size,
    mtime = excluded.mtime
`);

/** Session ids that have a transcript on disk — the scanner owns these. */
const owned = new Set<string>();
/** True when this session's data comes from disk, so the hook path can skip it
 *  instead of counting the same work twice. */
export function ownsSession(session_id: string): boolean {
  return SCAN_ENABLED && owned.has(session_id);
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
  ctx: { source_app: string; project_path: string; cwd: string; session_id: string; toolCalls: Map<string, { name: string; input: unknown }>; seenUsage: Set<string> },
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
    const usage = firstOfResponse ? (msg.usage as Record<string, unknown> | undefined) : undefined;

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
 * Ingest a transcript, emitting only lines past `from`.
 *
 * Earlier lines are still parsed (not emitted) because a PostToolUse needs the
 * tool name recorded by its PreToolUse, which may live in a chunk we ingested
 * on a previous tick.
 */
async function ingestFile(
  path: string,
  fallbackSessionId: string,
  from: number,
  onLive: ((r: InsertResult) => void) | null,
  scope: string | null
): Promise<{ lines: number; ingested: number; source_app: string; project_path: string; session_id: string; skipped?: boolean }> {
  const text = await Bun.file(path).text();
  const lines = text.split("\n");
  // JSONL ends with a newline, so split() leaves a phantom empty element. Left
  // in, lines_done ends up one past the real record count and the next sweep
  // skips the first line appended after it — which is *every* live line, since
  // sessions grow one record at a time.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const toolCalls = new Map<string, { name: string; input: unknown }>();
  // Claude Code splits one API response across several transcript lines (one
  // per content block) and repeats the identical `message.usage` on each. Only
  // the first line of a given message.id may carry it, or tokens and cost come
  // out multiplied by the number of blocks in the reply — measured at 2.5x.
  const seenUsage = new Set<string>();

  // First pass: read the project path (cwd) and the session id off the
  // transcript's own lines. Both beat inferring them from the file layout —
  // the directory encoding is lossy (a dash in a folder name is
  // indistinguishable from a separator), and a subagent transcript is named
  // after the agent while reporting the *parent* session it belongs to.
  let project_path = "";
  let session_id = "";
  for (const line of lines) {
    if (!line) continue;
    if (!line.includes('"cwd"') && !line.includes('"sessionId"')) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      project_path ||= str(o.cwd) ?? "";
      session_id ||= str(o.sessionId) ?? "";
    } catch { /* skip malformed line */ }
    if (project_path && session_id) break;
  }
  session_id ||= fallbackSessionId;
  const cwd = project_path;
  // Opened for one project: a transcript from anywhere else isn't this
  // cockpit's business. Bail before naming it, or it would still show up in
  // the project list despite contributing no events. The scope is pinned per
  // sweep (passed in), so a workspace switched mid-sweep can't suddenly widen
  // a *live* sweep into broadcasting months of backfill.
  //
  // Match on the *resolved repo root*, not just the raw cwd: a session running
  // in a project's own linked worktree (e.g. ~/code/app-wt, outside the scope
  // path) belongs to the scoped repo — `--git-common-dir` folds it back — and
  // the git panel already lists such worktrees as part of the project. We still
  // accept a raw-cwd match first, so scoping to a monorepo subdir (whose git
  // root sits *above* the scope) keeps working.
  if (scope && cwd) {
    const inScope = (p: string) => p === scope || p.startsWith(scope + "/");
    if (!inScope(cwd) && !inScope(resolvedRoot(cwd))) {
      return { lines: 0, ingested: 0, source_app: "", project_path: "", session_id, skipped: true };
    }
  }

  let source_app: string;
  if (cwd) {
    ({ source_app, project_path } = projectOf(cwd));
    projectPaths.set(source_app, project_path);
  } else {
    source_app = fallbackSessionId.slice(0, 8);
  }

  const ctx = { source_app, project_path, cwd, session_id, toolCalls, seenUsage };
  let ingested = 0;
  let seen = 0;
  // Collected inside the transaction, delivered after it commits: broadcasting
  // mid-transaction would push events to clients that a later failure rolls
  // back, leaving them showing rows the database never kept.
  const emitted: InsertResult[] = [];
  const fileMtime = statSync(path).mtimeMs;

  const run = db.transaction(() => {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;
      seen = i + 1;
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const bodies = lineToBodies(o, ctx, fileMtime);
      if (i < from) continue; // already ingested — parsed only for tool names
      for (const body of bodies) {
        emitted.push(insertEvent(normalize(body)));
        ingested++;
      }
    }
  });
  run();
  for (const r of emitted) onLive?.(r);

  return { lines: lines.length, ingested, source_app, project_path, session_id };
}

/** Every *.jsonl under a project dir, at any depth.
 *  Claude Code nests a session's subagent transcripts in
 *  `<session-id>/subagents/`, and those are the multi-agent runs the whole
 *  dashboard is about — a flat listing would miss all of them. */
function walkTranscripts(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkTranscripts(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** One sweep over every project directory. */
async function scanOnce(onLive: ((r: InsertResult) => void) | null): Promise<number> {
  // Read the workspace once per sweep so every file in it sees the same scope.
  const scope = workspaceRoot();
  let dirs: string[];
  try {
    dirs = readdirSync(PROJECTS_DIR);
  } catch {
    return 0; // no ~/.claude/projects yet — nothing to do
  }
  // Transcripts older than the retention window would be pruned on the next
  // sweep anyway, so never spend time parsing them.
  const cutoff = RETENTION_DAYS ? Date.now() - RETENTION_DAYS * 86_400_000 : 0;
  let total = 0;

  for (const dir of dirs) {
    const dirPath = join(PROJECTS_DIR, dir);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const path of walkTranscripts(dirPath)) {
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (cutoff && st.mtimeMs < cutoff) continue; // outside retention

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
        const from = rewritten ? 0 : prev?.lines_done ?? 0;
        const r = await ingestFile(path, basename(path, ".jsonl"), from, onLive, scope);
        // Out of scope: claim nothing, so widening the scope later can still
        // pick it up, and the hook path isn't blocked for a session we skipped.
        if (r.skipped) continue;
        owned.add(r.session_id);
        putFile.run({
          $path: path,
          $sid: r.session_id,
          $src: r.source_app,
          $proj: r.project_path,
          $lines: r.lines,
          $size: st.size,
          $mtime: Math.floor(st.mtimeMs),
        });
        total += r.ingested;
      } catch (e) {
        console.error(`[scan] ${path}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  return total;
}

// Shared between the interval watcher and resyncScope, so a manual catch-up
// sweep and a timed one never run over the same files at once.
let sweepBusy = false;

/**
 * Catch the scanner up after the workspace scope changed at runtime.
 *
 * Widening the scope makes previously skipped transcripts eligible — but they
 * are *historical backfill*, not live activity, so this sweep deliberately
 * passes no onLive: broadcasting months of old events would flood every
 * client and fire alerts for things long finished (the same reason the
 * startup backfill is silent). Waits out any in-flight sweep first.
 */
export async function resyncScope(): Promise<void> {
  if (!SCAN_ENABLED) return;
  while (sweepBusy) await new Promise((r) => setTimeout(r, 200));
  sweepBusy = true;
  try {
    await scanOnce(null);
  } catch (e) {
    console.error(`[scan] rescope sweep failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    sweepBusy = false;
  }
}

/**
 * Backfill everything on disk, then keep watching for new lines.
 * The initial sweep doesn't broadcast — it can be tens of thousands of events,
 * and no client is interested in replaying history frame by frame.
 */
export function startScanner(onLive: (r: InsertResult) => void): void {
  if (!SCAN_ENABLED) {
    console.log("📴 transcript scan disabled (AGENTGLASS_SCAN_DISABLED=1)");
    return;
  }
  const t0 = Date.now();
  // The startup backfill holds the same busy flag as every other sweep. It
  // didn't once, and a /workspace switch during a long cold-start backfill
  // kicked off a second concurrent scanOnce over the same files — both saw
  // "no row yet" for a transcript, both inserted its lines, and every count,
  // token and dollar for those sessions was silently doubled in the DB.
  sweepBusy = true;
  scanOnce(null)
    .then((n) => {
      const projects = projectPaths.size;
      console.log(
        `📚 scanned ${PROJECTS_DIR} — ${n} events from ${projects} project${projects === 1 ? "" : "s"} in ${Date.now() - t0}ms`
      );
      setInterval(async () => {
        if (sweepBusy) return; // a slow sweep must not stack up behind the timer
        sweepBusy = true;
        try {
          await scanOnce(onLive);
        } catch (e) {
          console.error(`[scan] sweep failed: ${e instanceof Error ? e.message : e}`);
        } finally {
          sweepBusy = false;
        }
      }, POLL_MS);
    })
    .catch((e) => console.error(`[scan] initial sweep failed: ${e}`))
    .finally(() => { sweepBusy = false; });
}
