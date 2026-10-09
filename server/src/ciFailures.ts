/*
 * The failing part of a failed CI check: cut out of the job log, kept, shown.
 *
 * A red check used to send you to GitHub for the one thing you opened it to
 * read, and the app's own log view could not help: bun prints a failure's
 * detail where it happens and only a name list at the end (on a real 1.15 MB
 * run the detail sat near 290 KB), so a capped tail missed it, and a log with
 * escape bytes did not load at all. So this reads the WHOLE log once, cuts the
 * failures out by runner, and keeps what it cut — never the log.
 *
 * Three layers, in this file because they are one decision:
 *   1. extractFailures(): pure, text in, failures out. Redaction runs inside it,
 *      before anything is stored or shown, over excerpt, title AND signature.
 *   2. a table keyed (repo, job_id, attempt). A job's log never changes once it
 *      has finished, so a read is kept for the same 90 days GitHub keeps the log,
 *      and a second look costs no request.
 *   3. readCheckFailures(): annotations, then the log, then the failing step's
 *      name, with the network injected so the order is testable.
 *
 * The ceiling, said once: what is recognised is bun, pytest, django/unittest,
 * jest, tsc-shaped lint and, failing all of those, the end of the failing step.
 * Another runner shows its step, not its tests, until it is added here.
 */
import { db } from "./db.ts";
import type { CiFailure, CheckFailures, CheckFailuresHints, CheckFailureSummary } from "../../shared/types.ts";

export const MAX_FAILURES = 10;
export const MAX_EXCERPT = 4096;
/** The most the panel downloads without being asked. One request either way; this is only about memory. */
export const LOG_READ_CAP = 25_000_000;
/** What "Read it anyway" may take. A log bigger than this is opened on GitHub. */
export const LOG_READ_FORCE_CAP = 150_000_000;
const STEP_TAIL_LINES = 40;
export const FAILURE_RETENTION_DAYS = 90;

type Kind = CiFailure["kind"];
export interface Extracted { failures: CiFailure[]; more: number; framework: Kind | null }

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]?/g;
const STAMP = /^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z /;

/**
 * Secrets and people, before the text is kept. Over-redacting an excerpt costs a
 * word; leaking costs more, and a stored excerpt is read by whoever opens the app.
 */
export function redact(s: string): string {
  return s
    .replace(/\b(?:ghp|gho|ghs|ghu|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, "[token]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "[token]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[token]")
    .replace(/\b(Bearer|token)\s+[A-Za-z0-9._~+/-]{16,}=*/gi, "$1 [token]")
    .replace(/((?:api[_-]?key|secret|password|passwd|token)\s*[=:]\s*)["']?[^\s"']{6,}/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/g, "https://[redacted]@")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]");
}

/** No escape bytes, no timestamps, no CRs, no byte-order mark: one string per line. */
export function clean(log: string): string[] {
  return log.replace(/\r/g, "").split("\n").map((l) => l.replace(ANSI, "").replace(STAMP, ""));
}

function cap(lines: string[]): { text: string; truncated: boolean } {
  const text = lines.join("\n").trim();
  if (text.length <= MAX_EXCERPT) return { text, truncated: false };
  // The assertion is at the top of a block and the frame that matters at the bottom: keep both ends.
  const half = MAX_EXCERPT / 2 - 10;
  return { text: `${text.slice(0, half)}\n[… cut …]\n${text.slice(-half)}`, truncated: true };
}

/**
 * A failure's identity across runs: the title and the first line that says WHAT
 * went wrong, with what varies from run to run (addresses, ids, paths, times,
 * counts) taken out. Two runs with the same signature failed the same way.
 */
export function signature(title: string, firstLine: string): string {
  const norm = firstLine
    .replace(/0x[0-9a-f]+/gi, "0x?")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{12,}/gi, "<uuid>")
    .replace(/(?:\/[\w.@-]+){2,}/g, "<path>")
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s)\b/g, "<t>")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return `${title.trim()} :: ${norm}`;
}

function firstMessage(block: string[]): string {
  const m = block.find((l) => /^(error|E\s|AssertionError|[A-Za-z]*Error:|Error:|\s*●.*›|FAIL:|ERROR:)/.test(l.trim() === l ? l : l.trimStart()));
  return (m ?? block.find((l) => l.trim()) ?? "").trim();
}

function make(kind: Kind, title: string, block: string[], message: string): CiFailure {
  const { text, truncated } = cap(block);
  return { kind, title, excerpt: text, signature: signature(title, message), truncated };
}

// ── bun test ──────────────────────────────────────────────────────────────
// The error block is printed BEFORE its `(fail) name [ms]` line, after the
// previous (pass)/(skip)/(fail) line. The summary at the end lists the names
// again with no detail: everything after "N tests failed:" is ignored.
function bunFailures(lines: string[]): CiFailure[] {
  const end = lines.findIndex((l) => /^\d+ tests? failed:$/.test(l));
  const body = end < 0 ? lines : lines.slice(0, end);
  const out: CiFailure[] = [];
  const seen = new Set<string>();
  let blockStart = 0;
  body.forEach((l, i) => {
    const m = /^\(fail\) (.*?)(?: \[[\d.]+m?s\])?$/.exec(l);
    if (m) {
      const title = m[1]!;
      // `##[error]` repeats the message the block already shows: drop the copy.
      const block = body.slice(blockStart, i);
      const copy = block.findIndex((x) => x.startsWith("##[error]"));
      const own = copy < 0 ? block : block.slice(0, copy);
      if (!seen.has(title)) { seen.add(title); out.push(make("bun", title, own, firstMessage(own))); }
    }
    if (/^\((pass|skip|fail|todo)\) /.test(l)) blockStart = i + 1;
  });
  return out;
}

// ── pytest ────────────────────────────────────────────────────────────────
function pytestFailures(lines: string[]): CiFailure[] {
  const head = lines.findIndex((l) => /^=+ FAILURES =+$/.test(l));
  if (head < 0) return [];
  const stop = lines.findIndex((l, i) => i > head && /^=+ (short test summary info|warnings summary|.* in [\d.]+s.*) =+$/.test(l));
  const body = lines.slice(head + 1, stop < 0 ? undefined : stop);
  const out: CiFailure[] = [];
  let cur: { title: string; lines: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const msg = cur.lines.find((l) => /^E\s/.test(l))?.replace(/^E\s+/, "") ?? firstMessage(cur.lines);
    out.push(make("pytest", cur.title, cur.lines, msg));
  };
  for (const l of body) {
    const t = /^_{3,} (.+?) _{3,}$/.exec(l);
    if (t) { flush(); cur = { title: t[1]!, lines: [] }; } else cur?.lines.push(l);
  }
  flush();
  return out;
}

// ── django / unittest ─────────────────────────────────────────────────────
function djangoFailures(lines: string[]): CiFailure[] {
  const out: CiFailure[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(FAIL|ERROR): (.+)$/.exec(lines[i]!);
    // `ERROR: chunk too large` from a build is not a unittest failure: unittest always draws the rule under the header.
    if (!m || !/^-{20,}$/.test(lines[i + 1] ?? "")) continue;
    const block: string[] = [];
    // A block ends at the next === rule, at the closing ---- before `Ran N tests`, or at the next FAIL/ERROR.
    for (let j = i + 2; j < lines.length; j++) {
      const l = lines[j]!;
      if (/^={20,}$/.test(l) || /^(FAIL|ERROR): /.test(l) || /^Ran \d+ tests?/.test(l)) break;
      block.push(l);
    }
    while (block.length && (!block[block.length - 1]!.trim() || /^-{20,}$/.test(block[block.length - 1]!))) block.pop();
    const last = [...block].reverse().find((l) => /^[\w.]*(Error|Exception|Failure)\b|^AssertionError/.test(l)) ?? firstMessage(block);
    out.push(make("django", m[2]!, block, last));
  }
  return out;
}

// ── jest ──────────────────────────────────────────────────────────────────
function jestFailures(lines: string[]): CiFailure[] {
  const out: CiFailure[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*● (.+)$/.exec(lines[i]!);
    if (!m || m[1] === "Console") continue;
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*● /.test(lines[j]!) || /^(Test Suites|Tests):/.test(lines[j]!)) break;
      block.push(lines[j]!);
    }
    out.push(make("jest", m[1]!, block, firstMessage(block)));
  }
  return out;
}

// ── tsc ───────────────────────────────────────────────────────────────────
function tscFailures(lines: string[]): CiFailure[] {
  const out: CiFailure[] = [];
  for (const l of lines) {
    const m = /^(.+?)\((\d+),\d+\): error (TS\d+): (.+)$|^(.+?):(\d+):\d+ - error (TS\d+): (.+)$/.exec(l);
    if (!m) continue;
    out.push({ kind: "tsc", title: m[1] ?? m[5]!, excerpt: l, signature: signature(m[3] ?? m[7]!, m[4] ?? m[8]!), truncated: false });
  }
  return out;
}

// ── fallback: the failing step, its last lines ─────────────────────────────
/**
 * The step that ended in `##[error]Process completed with exit code N`: from its
 * `##[group]Run` to that line, the last lines of it. `stepName` is the name the
 * jobs API gave the step ("Tests (server)"), a better title than its script.
 */
export function failingStep(lines: string[], stepName?: string): CiFailure | null {
  let err = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^##\[error\]Process completed with exit code \d+/.test(lines[i]!)) { err = i; break; }
  if (err < 0) return null;
  let g = 0;
  for (let i = err; i >= 0; i--) if (/^##\[group\]Run /.test(lines[i]!)) { g = i; break; }
  const title = stepName?.trim() || lines[g]!.replace(/^##\[group\]Run /, "").slice(0, 80);
  // Skip the script echo and `shell:` boilerplate up to ##[endgroup].
  const endg = lines.findIndex((l, i) => i > g && l.startsWith("##[endgroup]"));
  const body = lines.slice((endg < 0 || endg > err ? g : endg) + 1, err + 1).filter((l) => l.trim());
  const tail = body.slice(-STEP_TAIL_LINES);
  return make("step", title, tail, tail[tail.length - 1] ?? "");
}

function redactAll(f: CiFailure): CiFailure {
  return { ...f, excerpt: redact(f.excerpt), title: redact(f.title), signature: redact(f.signature) };
}

/** Names the failures of one job log. Reads the whole text; keeps at most MAX_FAILURES, each at most MAX_EXCERPT. */
export function extractFailures(log: string, opts: { step?: string } = {}): Extracted {
  const lines = clean(log);
  const tries: [Kind, () => CiFailure[]][] = [
    ["bun", () => bunFailures(lines)],
    ["pytest", () => pytestFailures(lines)],
    ["django", () => djangoFailures(lines)],
    ["jest", () => jestFailures(lines)],
    ["tsc", () => tscFailures(lines)],
  ];
  let all: CiFailure[] = [];
  let framework: Kind | null = null;
  for (const [kind, run] of tries) {
    const found = run();
    if (found.length) { all = found; framework = kind; break; }
  }
  if (!all.length) {
    const step = failingStep(lines, opts.step);
    if (step) { all = [step]; framework = "step"; }
  }
  const kept = all.slice(0, MAX_FAILURES).map(redactAll);
  return { failures: kept, more: Math.max(0, all.length - kept.length), framework };
}

// ── annotations ───────────────────────────────────────────────────────────
export interface CheckAnnotation { level: string; path: string; line: number; title?: string; message: string }

/** "Process completed with exit code 1." says a step failed, not what: it is the fallback's job, not an annotation's. */
const GENERIC = /^Process completed with exit code \d+\.?$/;

/**
 * What a check run's own annotations say failed. Only the tools that write
 * `##[error]` have any (bun's assertion, a linter's rule); pytest and a script
 * leave just the exit-code line, which is dropped here.
 */
export function annotationFailures(items: CheckAnnotation[]): { failures: CiFailure[]; more: number } {
  const real = items.filter((a) => a.level === "failure" && !GENERIC.test(a.message.trim()));
  const all = real.map((a) => {
    const first = a.message.split("\n").find((l) => l.trim())?.trim() ?? "";
    const where = a.path && !a.path.startsWith(".github") ? `${a.path}${a.line ? `:${a.line}` : ""}` : "";
    const title = where || a.title || first.slice(0, 120);
    const { text, truncated } = cap(a.message.split("\n"));
    return { kind: "annotation" as const, title, excerpt: text, signature: signature(title, first), truncated };
  });
  const kept = all.slice(0, MAX_FAILURES).map(redactAll);
  return { failures: kept, more: Math.max(0, all.length - kept.length) };
}

// ── the cache ─────────────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS ci_failure_reads (
  repo TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL,
  source TEXT NOT NULL,
  framework TEXT,
  more INTEGER NOT NULL DEFAULT 0,
  read_bytes INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  step TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL,
  PRIMARY KEY (repo, job_id, attempt)
);
CREATE TABLE IF NOT EXISTS ci_failure_items (
  repo TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  signature TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo, job_id, attempt, idx)
);
CREATE INDEX IF NOT EXISTS ci_failure_items_by_signature ON ci_failure_items (repo, signature);
`);

type Ok = Extract<CheckFailures, { ok: true }>;

export function storedFailures(repo: string, jobId: string, attempt: number): Ok | null {
  const r = db.prepare(`SELECT state, source, framework, more, read_bytes, size_bytes, step, at FROM ci_failure_reads WHERE repo = ? AND job_id = ? AND attempt = ?`)
    .get(repo, jobId, attempt) as { state: Ok["state"]; source: Ok["source"]; framework: Kind | null; more: number; read_bytes: number; size_bytes: number; step: string; at: number } | null;
  if (!r) return null;
  const items = db.prepare(`SELECT kind, title, signature, excerpt, truncated FROM ci_failure_items WHERE repo = ? AND job_id = ? AND attempt = ? ORDER BY idx`)
    .all(repo, jobId, attempt) as { kind: Kind; title: string; signature: string; excerpt: string; truncated: number }[];
  return {
    ok: true, state: r.state, source: r.source, framework: r.framework, more: r.more,
    readBytes: r.read_bytes, sizeBytes: r.size_bytes || undefined, step: r.step || undefined, at: r.at, cached: true, requests: 0,
    failures: items.map((i) => ({ kind: i.kind, title: i.title, signature: i.signature, excerpt: i.excerpt, truncated: !!i.truncated })),
  };
}

function storeFailures(repo: string, jobId: string, attempt: number, v: Ok, now: number): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM ci_failure_items WHERE repo = ? AND job_id = ? AND attempt = ?`).run(repo, jobId, attempt);
    db.prepare(`INSERT OR REPLACE INTO ci_failure_reads (repo, job_id, attempt, state, source, framework, more, read_bytes, size_bytes, step, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(repo, jobId, attempt, v.state, v.source, v.framework, v.more, v.readBytes, v.sizeBytes ?? 0, v.step ?? "", now);
    const ins = db.prepare(`INSERT INTO ci_failure_items (repo, job_id, attempt, idx, kind, title, signature, excerpt, truncated) VALUES (?,?,?,?,?,?,?,?,?)`);
    v.failures.forEach((f, i) => ins.run(repo, jobId, attempt, i, f.kind, f.title, f.signature, f.excerpt, f.truncated ? 1 : 0));
    // GitHub keeps a log 90 days; what was read from it is kept as long.
    const old = now - FAILURE_RETENTION_DAYS * 86_400_000;
    db.prepare(`DELETE FROM ci_failure_items WHERE (repo, job_id, attempt) IN (SELECT repo, job_id, attempt FROM ci_failure_reads WHERE at < ?)`).run(old);
    db.prepare(`DELETE FROM ci_failure_reads WHERE at < ?`).run(old);
  })();
}

/**
 * The cache's view of some jobs, newest read per job, in one query. No request:
 * this is what lets a row say "2 failing tests" before anybody opens it again.
 * Only jobs that were already read are in the answer; the rest are simply absent.
 */
export function cachedSummaries(repo: string, jobIds: string[]): Record<string, CheckFailureSummary> {
  const ids = [...new Set(jobIds.filter((j) => /^\d+$/.test(j)))].slice(0, 200);
  const out: Record<string, CheckFailureSummary> = {};
  if (!ids.length) return out;
  const marks = ids.map(() => "?").join(",");
  const reads = db.prepare(`SELECT job_id, attempt, state, source, more FROM ci_failure_reads WHERE repo = ? AND job_id IN (${marks}) ORDER BY at ASC`).all(repo, ...ids) as { job_id: string; attempt: number; state: Ok["state"]; source: Ok["source"]; more: number }[];
  for (const r of reads) out[r.job_id] = { state: r.state, source: r.source, count: 0, more: r.more, titles: [] };
  for (const r of reads) {
    const items = db.prepare(`SELECT title FROM ci_failure_items WHERE repo = ? AND job_id = ? AND attempt = ? ORDER BY idx`).all(repo, r.job_id, r.attempt) as { title: string }[];
    const mine = out[r.job_id]!;
    mine.count = items.length; mine.titles = items.map((i) => i.title);
  }
  return out;
}

// ── reading one check ─────────────────────────────────────────────────────
export type LogRead =
  | { ok: true; text: string; bytes: number }
  | { ok: false; kind: "expired" }
  | { ok: false; kind: "toolarge"; bytes: number }
  | { ok: false; kind: "budget"; resetAt: number | null }
  | { ok: false; kind: "error"; error: string };
export type AnnotationsRead =
  | { ok: true; items: CheckAnnotation[] }
  | { ok: false; kind: "budget"; resetAt: number | null }
  | { ok: false; kind: "error"; error: string };
/** The two GitHub reads, injected: the order they are tried in is what is tested, not the network. */
export interface FailureSources {
  annotations(): Promise<AnnotationsRead>;
  log(maxBytes: number): Promise<LogRead>;
}

const inflight = new Map<string, Promise<CheckFailures>>();

/**
 * What failed in one check, as cheaply as GitHub allows and never twice.
 *
 * Order, and why:
 *   cache  — a finished job's log never changes: a second look costs nothing.
 *   annotations (1 request) — GitHub's own list of what the tool flagged, and
 *     the only place a failure survives the log's 90 days. No test names there.
 *   log (1 request) — always has the failure. Tests it names win over
 *     annotations because only they carry a test's name, which the board and
 *     the lens need; annotations stand in when the log cannot be read; the
 *     failing step's tail is the last resort.
 * Not kept: a budget or network error (it says nothing about the job), so the
 * next open tries again. `force` lifts the size cap and ignores the cache.
 */
export function readCheckFailures(
  repo: string, jobId: string, hints: CheckFailuresHints, src: FailureSources, opts: { force?: boolean; now?: number } = {},
): Promise<CheckFailures> {
  const attempt = hints.attempt && hints.attempt > 0 ? hints.attempt : 1;
  if (!opts.force) {
    const hit = storedFailures(repo, jobId, attempt);
    if (hit) return Promise.resolve(hit);
  }
  const key = `${repo}#${jobId}#${attempt}#${opts.force ? "f" : ""}`;
  const running = inflight.get(key);
  if (running) return running;
  const p = readFresh(repo, jobId, attempt, hints, src, opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function readFresh(
  repo: string, jobId: string, attempt: number, hints: CheckFailuresHints, src: FailureSources, opts: { force?: boolean; now?: number },
): Promise<CheckFailures> {
  const now = opts.now ?? Date.now();
  let requests = 0;
  const ann = await src.annotations(); requests++;
  if (!ann.ok) return ann.kind === "budget" ? { ok: false, kind: "budget", resetAt: ann.resetAt, requests } : { ok: false, kind: "error", error: ann.error, requests };
  const fromAnnotations = annotationFailures(ann.items);

  const log = await src.log(opts.force ? LOG_READ_FORCE_CAP : LOG_READ_CAP); requests++;
  if (!log.ok && (log.kind === "budget" || log.kind === "error")) {
    return log.kind === "budget" ? { ok: false, kind: "budget", resetAt: log.resetAt, requests } : { ok: false, kind: "error", error: log.error, requests };
  }

  let out: Ok;
  if (log.ok) {
    const e = extractFailures(log.text, { step: hints.step });
    const named = e.framework && e.framework !== "step";
    if (named || (!fromAnnotations.failures.length && e.failures.length)) {
      out = { ok: true, state: "read", source: named ? "log" : "step", framework: e.framework, failures: e.failures, more: e.more, readBytes: log.bytes, step: hints.step, at: now, cached: false, requests };
    } else if (fromAnnotations.failures.length) {
      out = { ok: true, state: "read", source: "annotations", framework: null, failures: fromAnnotations.failures, more: fromAnnotations.more, readBytes: log.bytes, step: hints.step, at: now, cached: false, requests };
    } else {
      out = { ok: true, state: "unparsed", source: "none", framework: null, failures: [], more: 0, readBytes: log.bytes, step: hints.step, at: now, cached: false, requests };
    }
  } else {
    // expired or too large: the log is not coming, say so, and show what annotations kept.
    const withAnn = fromAnnotations.failures.length > 0;
    out = {
      ok: true, state: log.kind === "expired" ? "expired" : "toolarge", source: withAnn ? "annotations" : "none", framework: null,
      failures: fromAnnotations.failures, more: fromAnnotations.more, readBytes: 0, sizeBytes: log.kind === "toolarge" ? log.bytes : undefined,
      step: hints.step, at: now, cached: false, requests,
    };
  }
  try { storeFailures(repo, jobId, attempt, out, now); } catch { /* a cache that cannot be written must never break a read */ }
  return out;
}
