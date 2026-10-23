/*
 * GET /prs/sessions — the agent session(s) that wrote a pull request, as a
 * brief a review plugin may read.
 *
 * The most useful context a reviewer can have is what the author's agent was
 * asked and what it said it did, and it is also the most private thing the app
 * holds: a transcript has pasted keys, internal names and the person's own
 * words in it. So this door is shut three times over, and each lock is
 * checked on its own:
 *
 *   1. the plugin's manifest names `reads: ["sessions"]` (and the person
 *      approved that declaration),
 *   2. the person allowed THIS repository (`plugins.sessionReads.repos`,
 *      empty until they add one),
 *   3. nothing in the brief looks like a secret. One hit refuses the whole
 *      answer with the kinds found and never the text: redacting would send
 *      a brief the person never saw, and a half-redacted prompt still says
 *      what was inside it.
 *
 * What is returned is built here from the event log, locally, and bounded:
 * the first request and the final summary cut short, the files the agent
 * wrote (relative to the repository), a count of tool calls by kind. Never a
 * transcript, a tool's output, the environment, or an absolute home path.
 *
 * Ceiling: the match between a session and a pull request is the one the
 * spend panel makes (the branch a turn recorded, else the branch the
 * checkout it ran in has out NOW), so a session that moved branches after
 * the work, or ran in a checkout since switched, is missed or misattributed
 * the same way. A turn with no cost is not seen by it either.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { secretKinds } from "../../shared/scrub.ts";
import type { Contributes } from "../../shared/pluginUi.ts";
import { branchResolver, type SpendRow } from "./spend.ts";
import { db } from "./db.ts";

export const REQUEST_MAX = 1_500;
export const SUMMARY_MAX = 1_500;
export const FILES_MAX = 60;
export const SESSIONS_MAX = 3;
export const RESPONSE_MAX_BYTES = 24 * 1024;
/** A path longer than this is not a path anybody wrote on purpose. */
const PATH_MAX = 200;
export const RATE_PER_HOUR = 60;

// ── the person's allowlist ──────────────────────────────────────────────────

function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass");
}
export function sessionReadsPath(): string {
  return join(configDir(), "session-reads.json");
}
/** Same rule every other store here follows under test: only the scratch
 *  directory is readable or writable. */
const IS_TEST = process.env.NODE_ENV === "test";
function offLimits(p: string): boolean {
  const scratch = tmpdir();
  return IS_TEST && p !== scratch && !p.startsWith(scratch + "/");
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REPOS_MAX = 200;

/** `owner/name`, lowercased (GitHub ignores case), or null. */
export function normalizeRepo(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/^gh:/, "").replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  return REPO_RE.test(s) ? s.toLowerCase() : null;
}

/** A list the person typed or an agent sent, as the list kept: valid, unique, bounded. */
export function coerceRepos(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const out = new Set<string>();
  for (const r of list) {
    const n = normalizeRepo(r);
    if (n) out.add(n);
    if (out.size >= REPOS_MAX) break;
  }
  return [...out];
}

let cached: string[] | null = null;

export function sessionReadRepos(): string[] {
  if (cached) return cached;
  const p = sessionReadsPath();
  if (offLimits(p) || !existsSync(p)) return (cached = []);
  try {
    cached = coerceRepos((JSON.parse(readFileSync(p, "utf8")) as { repos?: unknown }).repos);
  } catch {
    // A corrupt file closes the door rather than opening it.
    cached = [];
  }
  return cached;
}

export function setSessionReadRepos(raw: unknown): string[] {
  const repos = coerceRepos(raw);
  cached = repos;
  const p = sessionReadsPath();
  if (offLimits(p)) return repos;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ repos }, null, 2) + "\n", { mode: 0o600 });
  } catch { /* best effort, as notifyPrefs.ts */ }
  return repos;
}

/** For tests: drop the remembered read so a file written by hand is seen. */
export function __resetSessionReadsCache(): void { cached = null; }

// ── the two locks that are not about content ────────────────────────────────

export type Gate = { ok: true } | { ok: false; missing: ("manifest" | "repository")[]; error: string };

/** Which of the two permissions is missing, both when both are. */
export function sessionsGate(c: Contributes, repo: string | null, allowed: readonly string[] = sessionReadRepos()): Gate {
  const missing: ("manifest" | "repository")[] = [];
  if (!c.reads?.includes("sessions")) missing.push("manifest");
  if (!repo || !allowed.includes(repo.toLowerCase())) missing.push("repository");
  if (!missing.length) return { ok: true };
  const parts = [
    missing.includes("manifest") ? "the plugin's manifest does not declare contributes.reads: [\"sessions\"]" : "",
    missing.includes("repository")
      ? `${repo ?? "this repository"} is not in the repositories the person allowed (Settings → Review prompts → Let review plugins read the authoring session)`
      : "",
  ].filter(Boolean);
  return { ok: false, missing, error: `sessions are not shared with this plugin: ${parts.join("; and ")}` };
}

/** At most `RATE_PER_HOUR` answered requests per plugin in any hour. */
const asked = new Map<string, number[]>();
export function takeSessionsSlot(plugin: string, now = Date.now(), cap = RATE_PER_HOUR): { ok: true } | { ok: false; retryAfterSec: number } {
  const hour = 3_600_000;
  const recent = (asked.get(plugin) ?? []).filter((t) => now - t < hour);
  if (recent.length >= cap) {
    asked.set(plugin, recent);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0]! + hour - now) / 1000)) };
  }
  recent.push(now);
  asked.set(plugin, recent);
  return { ok: true };
}
export function __resetSessionsRate(): void { asked.clear(); }

// ── what a session did, as the event log keeps it ───────────────────────────

/** Everything the brief is made of, before any rule is applied to it. */
export interface SessionFacts {
  sessionId: string;
  agent: string;
  startedAt: number;
  endedAt: number;
  firstPrompt: string;
  finalMessage: string;
  /** Paths as the tool recorded them: absolute, in first-touch order. */
  files: string[];
  tools: Record<string, number>;
}

export interface SessionBrief {
  /** Opaque: a hash of the session id, so the raw id (and the transcript it
   *  names) is not handed to a plugin. */
  id: string;
  agent: string;
  startedAt: number;
  endedAt: number;
  request: string;
  files: string[];
  tools: Record<string, number>;
  summary: string;
  truncated: { request: boolean; summary: boolean; files: boolean };
}

export const opaqueId = (sessionId: string): string =>
  "s_" + createHash("sha256").update("agentglass-session:" + sessionId).digest("hex").slice(0, 16);

/** Absolute paths into a home directory become `~/…`; the user name goes with them. */
export function tildePaths(s: string, home = homedir()): string {
  let out = s;
  if (home && home !== "/") out = out.split(home).join("~");
  return out.replace(/(?:\/home|\/Users)\/[^/\s"'`)]+/g, "~").replace(/[A-Za-z]:\\Users\\[^\\\s"'`)]+/g, "~");
}

const clip = (s: string, max: number): { text: string; cut: boolean } =>
  s.length <= max ? { text: s, cut: false } : { text: s.slice(0, max).trimEnd() + " …", cut: true };

/** A path inside a checkout of this repository, relative to it; any other, with `~`. */
export function repoPath(p: string, roots: readonly string[], home = homedir()): string {
  if (!isAbsolute(p)) return tildePaths(p, home).slice(0, PATH_MAX);
  const owner = [...roots].sort((a, z) => z.length - a.length).find((r) => p === r || p.startsWith(r.endsWith("/") ? r : r + "/"));
  const rel = owner ? relative(owner, p) : "";
  return (rel && !rel.startsWith("..") ? rel : tildePaths(p, home)).slice(0, PATH_MAX);
}

export type BriefResult = { ok: true; brief: SessionBrief } | { ok: false; kinds: string[] };

/**
 * One session's brief, or the kinds of secret-like text found in what would
 * have been in it. The scan runs over the whole text BEFORE it is cut: a key
 * whose first half survives the cut is still a key.
 */
export function buildBrief(f: SessionFacts, roots: readonly string[], home = homedir()): BriefResult {
  const files = [...new Set(f.files.map((p) => repoPath(p, roots, home)))];
  const toolNames = Object.keys(f.tools);
  const kinds = secretKinds([f.firstPrompt, f.finalMessage, ...files, ...toolNames].join("\n"));
  if (kinds.length) return { ok: false, kinds: [...new Set(kinds)].sort() };
  const request = clip(tildePaths(f.firstPrompt.trim(), home), REQUEST_MAX);
  const summary = clip(tildePaths(f.finalMessage.trim(), home), SUMMARY_MAX);
  return {
    ok: true,
    brief: {
      id: opaqueId(f.sessionId), agent: f.agent, startedAt: f.startedAt, endedAt: f.endedAt,
      request: request.text, files: files.slice(0, FILES_MAX), tools: f.tools, summary: summary.text,
      truncated: { request: request.cut, summary: summary.cut, files: files.length > FILES_MAX },
    },
  };
}

// ── which sessions wrote this branch ────────────────────────────────────────

/** Sessions that worked on `branch`, newest first. */
export function sessionsOnBranch(rows: readonly SpendRow[], checkouts: Map<string, string>, branch: string): { sessionId: string; lastTs: number }[] {
  const branchOf = branchResolver(checkouts);
  const last = new Map<string, number>();
  for (const r of rows) {
    const named = (r.branch || "").trim();
    const dir = (r.dir || "").trim();
    const b = named || (dir ? branchOf(dir) : "");
    if (b !== branch) continue;
    last.set(r.session_id, Math.max(last.get(r.session_id) ?? 0, r.last_ts));
  }
  return [...last].map(([sessionId, lastTs]) => ({ sessionId, lastTs })).sort((a, z) => z.lastTs - a.lastTs);
}

export interface SessionsDeps {
  rows(root: string): SpendRow[];
  checkouts(root: string): Promise<Map<string, string>>;
  facts(sessionId: string): SessionFacts | null;
}

export type SessionsAnswer =
  | { ok: true; sessions: SessionBrief[]; truncated?: true }
  | { ok: false; status: 422; error: string; kinds: string[] };

/** The answer for a branch, after the gates. Never throws on "none". */
export async function answerSessions(root: string, branch: string, deps: SessionsDeps, home = homedir()): Promise<SessionsAnswer> {
  const checkouts = await deps.checkouts(root);
  const matched = sessionsOnBranch(deps.rows(root), checkouts, branch).slice(0, SESSIONS_MAX);
  const roots = [...checkouts.keys(), root];
  const briefs: SessionBrief[] = [];
  const kinds = new Set<string>();
  for (const m of matched) {
    const facts = deps.facts(m.sessionId);
    if (!facts) continue;
    const b = buildBrief(facts, roots, home);
    if (b.ok) briefs.push(b.brief);
    else for (const k of b.kinds) kinds.add(k);
  }
  // One session with a secret refuses the whole answer: a brief that quietly
  // lacks the session that held the key is the same leak, one step later.
  if (kinds.size) return { ok: false, status: 422, error: "secret-like text found in the session brief", kinds: [...kinds].sort() };
  return fit(briefs);
}

/** Under the response cap: shed the file lists, the oldest session's first, then whole sessions. */
export function fit(briefs: SessionBrief[]): { ok: true; sessions: SessionBrief[]; truncated?: true } {
  const size = (b: SessionBrief[]) => new TextEncoder().encode(JSON.stringify({ ok: true, sessions: b, truncated: true })).length;
  let list = briefs.map((b) => ({ ...b, files: [...b.files], truncated: { ...b.truncated } }));
  let shed = false;
  while (size(list) > RESPONSE_MAX_BYTES && list.length) {
    const fat = [...list].reverse().find((b) => b.files.length > 0);
    if (fat) {
      fat.files = fat.files.slice(0, Math.floor(fat.files.length / 2));
      fat.truncated.files = true;
    } else {
      list = list.slice(0, -1);
    }
    shed = true;
  }
  return shed ? { ok: true, sessions: list, truncated: true } : { ok: true, sessions: list };
}

// ── the real event log ──────────────────────────────────────────────────────

const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/** One session's facts, from the event log. Bounded reads; no output of any tool. */
export function sessionFacts(sessionId: string): SessionFacts | null {
  const span = db.query<{ app: string | null; a: number | null; z: number | null }, [string]>(
    `SELECT MAX(source_app) app, MIN(timestamp) a, MAX(timestamp) z FROM events WHERE session_id = ?`).get(sessionId);
  if (!span || span.a == null) return null;
  let firstPrompt = "";
  const first = db.query<{ payload: string }, [string]>(
    `SELECT payload FROM events WHERE session_id = ? AND hook_event_type = 'UserPromptSubmit' ORDER BY timestamp ASC, id ASC LIMIT 1`).get(sessionId);
  try { const p = first ? JSON.parse(first.payload).prompt : ""; firstPrompt = typeof p === "string" ? p : ""; } catch { /* none */ }
  let finalMessage = "";
  for (const r of db.query<{ payload: string }, [string]>(
    `SELECT payload FROM events WHERE session_id = ? AND payload LIKE '%last_assistant_message%' ORDER BY timestamp DESC, id DESC LIMIT 5`).all(sessionId)) {
    try { const m = JSON.parse(r.payload).last_assistant_message; if (typeof m === "string" && m.trim()) { finalMessage = m; break; } } catch { /* next */ }
  }
  const files: string[] = [];
  const q = WRITE_TOOLS.map(() => "?").join(",");
  for (const r of db.query<{ payload: string }, string[]>(
    `SELECT payload FROM events WHERE session_id = ? AND hook_event_type = 'PostToolUse' AND tool_name IN (${q}) ORDER BY timestamp ASC, id ASC LIMIT 2000`).all(sessionId, ...WRITE_TOOLS)) {
    try {
      const ti = JSON.parse(r.payload).tool_input ?? {};
      const p = ti.file_path ?? ti.notebook_path ?? ti.path;
      if (typeof p === "string" && p) files.push(p);
    } catch { /* skip */ }
  }
  const tools: Record<string, number> = {};
  for (const r of db.query<{ t: string; n: number }, [string]>(
    `SELECT tool_name t, COUNT(*) n FROM events WHERE session_id = ? AND hook_event_type = 'PostToolUse' AND tool_name IS NOT NULL GROUP BY tool_name ORDER BY n DESC LIMIT 20`).all(sessionId)) {
    tools[r.t] = r.n;
  }
  return { sessionId, agent: span.app || "unknown", startedAt: span.a, endedAt: span.z ?? span.a, firstPrompt, finalMessage, files, tools };
}
