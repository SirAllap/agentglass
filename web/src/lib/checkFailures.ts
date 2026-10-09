/*
 * What the Checks tab says about a failed check's failures: the decisions, with
 * no React in them, so they are tested as functions (there is no renderer here).
 */
import type { CheckFailures, CiFailure, PrCheck, PrCheckJob } from "../../../shared/types.ts";

type Read = Extract<CheckFailures, { ok: true }>;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Decimal, as GitHub and a Content-Length speak: 64,000,000 bytes is "64 MB", not "61". */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} KB`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)} MB`;
}

/** The count a row can state: tests when the log named them, errors when GitHub's annotations did, nothing for a step's tail. */
export function failureRowText(s: { source: Read["source"]; framework?: CiFailure["kind"] | null; count: number; more: number }): string | null {
  const n = s.count + s.more;
  if (n === 0) return null;
  if (s.source === "log") return plural(n, "failing test");
  if (s.source === "annotations") return plural(n, "error");
  return null;
}

/**
 * A final "summary" job that fails only because a job it waits on did: its whole log is that sentence and the
 * exit-code line, so its step's tail says nothing a person can use. True only when EVERY line is one of the two;
 * one more line and it is a step with something to show. The ceiling: the two sentences are GitHub's and the
 * common workflow's ("One or more jobs failed or were cancelled"); a gate that words it differently is shown as
 * the step it is, tail and all.
 */
export function isAggregator(f: CiFailure): boolean {
  if (f.kind !== "step") return false;
  const lines = f.excerpt.split("\n").map((l) => l.replace(/^##\[error\]/, "").trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => /^Process completed with exit code \d+\.?$/.test(l) || /^(one|some|a|the) (or more |required )?jobs? (has |have |was |were )?(failed|cancel+ed)/i.test(l));
}

/** The run a check belongs to, from its own link (`…/actions/runs/<run>/job/<job>`). */
const runOf = (k: Pick<PrCheck, "url">): string | null => /\/actions\/runs\/(\d+)/.exec(k.url ?? "")?.[1] ?? null;

/** The other failed checks of the same run as `check`: what an aggregator job is reporting. Never itself, never a cancelled one. */
export function failedInRun(check: Pick<PrCheck, "url">, checks: PrCheck[]): PrCheck[] {
  const run = runOf(check);
  if (!run) return [];
  return checks.filter((k) => k.state === "failure" && !k.cancelled && k.url !== check.url && runOf(k) === run);
}

/**
 * What "Also failed on …" can offer to open. One known pull request and nothing unknown is a chip that opens it; any
 * other count is a list; a verdict kept before the numbers were recorded names none, so it is only words.
 */
export function othersShape(v: { nums?: number[]; unknown?: number }): { kind: "plain" } | { kind: "one"; n: number } | { kind: "list"; nums: number[]; unknown: number } {
  const nums = v.nums ?? [];
  if (!nums.length) return { kind: "plain" };
  if (nums.length === 1 && !v.unknown) return { kind: "one", n: nums[0]! };
  return { kind: "list", nums, unknown: v.unknown ?? 0 };
}

/** The list's last line: runs of this failure whose pull request the app does not know, said rather than dropped. */
export const unknownPrs = (n: number): string => `${n} more, ${n === 1 ? "PR" : "PRs"} unknown`;

/**
 * The test file a named failure was printed against, as the paths the log gives it (pytest's node id, a frame in a
 * `*.test.ts`, a Django dotted module). Django names no file: its module `a.b.c` is `a/b/c.py`, and with the
 * class and the method both unknown to us the module is the dotted name minus one or two parts, so both are offered.
 * Empty when the log does not say, which is most steps, annotations and app-posted checks.
 */
export function testFiles(f: CiFailure): string[] {
  if (f.kind === "pytest") {
    const p = /^(?:FAILED|ERROR) (\S+?\.py)(?:::| |$)/m.exec(f.excerpt)?.[1] ?? /^(\S+\.py):\d+: /m.exec(f.excerpt)?.[1];
    return p ? [p] : [];
  }
  if (f.kind === "bun" || f.kind === "jest") {
    const p = /([^\s()]+\.(?:test|spec)\.[cm]?[jt]sx?)(?::\d+)?/.exec(f.excerpt)?.[1];
    return p ? [p] : [];
  }
  if (f.kind === "django") {
    const parts = /\(([\w.]+)\)\s*$/.exec(f.title)?.[1]?.split(".") ?? [];
    return [2, 1].filter((cut) => parts.length > cut).map((cut) => `${parts.slice(0, -cut).join("/")}.py`);
  }
  return [];
}

/** The two paths name one file when one ends with the other at a folder boundary: a log prints a runner's absolute path, a diff a repository's. */
const samePath = (a: string, b: string): boolean => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

export type FileFact = { kind: "changed" | "untouched"; path: string };

/**
 * Whether this pull request's diff touches the failing test's file: a FACT about the diff, not a verdict about the
 * failure, which can come from code this pull request changed in another file. "Not in the diff" is said only when
 * the whole file list was loaded; "changed" is true whatever the cap. Null when the log names no test file.
 */
export function fileFact(f: CiFailure, changed: { paths: string[]; complete: boolean } | undefined): FileFact | null {
  const files = testFiles(f);
  if (!files.length || !changed) return null;
  const hit = files.find((t) => changed.paths.some((c) => samePath(t, c)));
  if (hit) return { kind: "changed", path: hit };
  return changed.complete ? { kind: "untouched", path: files[0]! } : null;
}

export const fileFactLabel = (x: FileFact): string => (x.kind === "changed" ? "Test file changed in this PR" : "Test file not in this PR’s diff");

/** The first thing a failure says, short enough for a chip beside its title. */
export function failureGist(f: CiFailure, max = 44): string {
  const line = f.excerpt.split("\n").map((l) => l.trim()).find((l) => l && !/^[\^\d|\s]+$/.test(l) && !/^\d+ \|/.test(l)) ?? "";
  const bare = line.replace(/^(error|E|AssertionError):?\s+/i, "");
  return bare.length > max ? `${bare.slice(0, max - 1)}…` : bare;
}

/** What the copy button puts on the clipboard: the name, then exactly what the panel shows. */
export function failureCopyText(f: CiFailure): string {
  return `${f.title}\n\n${f.excerpt}`.trimEnd();
}

/** Footer of the excerpt card: what was read and what was kept of it. */
export function readLine(r: Read): string {
  const kept = r.failures.reduce((n, f) => n + f.excerpt.length, 0);
  if (r.source === "annotations") return "From GitHub's annotations";
  if (r.readBytes > 0) return `Read ${formatBytes(r.readBytes)} of log, kept ${formatBytes(kept)}`;
  return `Kept ${formatBytes(kept)}`;
}

export function logAgeDays(completedAt: string | null | undefined, now = Date.now()): number | null {
  const t = Date.parse(completedAt || "");
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86_400_000)) : null;
}

/** "14:20", in the viewer's own clock: when GitHub's hourly budget comes back. */
export function resetClock(resetAt: number | null): string | null {
  if (!resetAt) return null;
  const d = new Date(resetAt);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The biggest log "Read it anyway" can take: the server's own ceiling. Over it the button is not offered. */
export const FORCE_CAP = 150_000_000;

export type FailureView =
  | { kind: "loading" }
  | { kind: "failures"; read: Read; notice: "expired" | "toolarge" | "unlogged" | null }
  | { kind: "no-test"; read: Read }
  /** A check an app or a script posted: no job log, its own message is the failure. `why`: it never had one, or it expired. */
  | { kind: "output"; read: Read; why: "nolog" | "expired" | "unlogged" }
  | { kind: "nolog"; read: Read }
  /** A job GitHub holds no log for (a runner that stopped mid-job uploads none) and that left no message. */
  | { kind: "unlogged"; read: Read }
  /** The row says nothing about which job ran it: nothing to read, said so. */
  | { kind: "nojob" }
  | { kind: "expired"; read: Read }
  | { kind: "toolarge"; read: Read; size: number; canForce: boolean }
  | { kind: "unparsed"; read: Read }
  | { kind: "budget"; resetAt: number | null }
  | { kind: "error"; error: string };

/** One answer, one screen. The order is the honesty: a failure list always wins over the reason the log could not be read. */
export function failureView(r: CheckFailures | undefined): FailureView {
  if (!r) return { kind: "loading" };
  if (!r.ok) return r.kind === "budget" ? { kind: "budget", resetAt: r.resetAt } : { kind: "error", error: r.error };
  if (r.state === "read" && r.source === "step") return { kind: "no-test", read: r };
  if (r.source === "output" && r.failures.length) return { kind: "output", read: r, why: r.state === "expired" ? "expired" : r.state === "unlogged" ? "unlogged" : "nolog" };
  if (r.state === "nolog" && !r.failures.length) return { kind: "nolog", read: r };
  if (r.state === "unlogged" && !r.failures.length) return { kind: "unlogged", read: r };
  if (r.failures.length) return { kind: "failures", read: r, notice: r.state === "expired" || r.state === "toolarge" || r.state === "unlogged" ? r.state : null };
  if (r.state === "expired") return { kind: "expired", read: r };
  if (r.state === "toolarge") return { kind: "toolarge", read: r, size: r.sizeBytes ?? 0, canForce: (r.sizeBytes ?? 0) <= FORCE_CAP };
  return { kind: "unparsed", read: r };
}

/**
 * The job behind a check row, or what stands in for one.
 *
 * The job id is in the check's own URL (`…/actions/runs/<run>/job/<job>`), which
 * is the one thing that cannot name the wrong job; names can: a reusable
 * workflow's job is "Caller / callee", so the check's name is shorter than the
 * job's and neither containment matches. The list of jobs is capped to a few
 * runs, so the job a red check belongs to may not be in it — on a real pull
 * request with 72 checks it was not, and the panel said nothing at all. So: the
 * listed job with that id; else one made from the URL (the id is all a read
 * needs); else the old name rules; else, for a check run an app posted
 * (`…/runs/<id>`, no job), that id. `undefined` only when the check names nothing.
 */
export function jobFor(check: Pick<PrCheck, "name" | "url" | "startedAt" | "completedAt">, jobs: PrCheckJob[]): PrCheckJob | undefined {
  const url = check.url ?? "";
  const id = /\/job\/(\d+)/.exec(url)?.[1];
  if (id) {
    const listed = jobs.find((j) => j.id === id);
    if (listed) return listed;
    return { id, runId: runOf(check) ?? "", name: check.name, status: "completed", conclusion: "failure", startedAt: check.startedAt ?? null, completedAt: check.completedAt ?? null, url };
  }
  const byName = jobs.find((j) => j.name === check.name) ?? jobs.find((j) => check.name.includes(j.name));
  if (byName) return byName;
  const posted = /\/runs\/(\d+)(?:$|[/?#])/.exec(url)?.[1];
  return posted ? { id: posted, runId: "", name: check.name, status: "completed", conclusion: "failure", startedAt: check.startedAt ?? null, completedAt: check.completedAt ?? null, url } : undefined;
}
