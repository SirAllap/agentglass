/*
 * THE MANIFEST'S CLOCK AND ITS SUMMARY.
 *
 * The rail dot has to be true with the view closed, so the summary is the one
 * thing here on a timer: read on mount, on focus, after a write, and every
 * minute while the document is visible. The rows themselves are read only by
 * opening the view, pressing Refresh, or focusing the window, one GET per open
 * project; the filter merges those answers here and asks for nothing itself.
 *
 * The words below (an age, a clock, a span) live here rather than in the view so
 * a test can pin them without rendering the screen.
 */
import { api, type ManifestRead } from "./api.ts";
import type {
  ManifestInProgress, ManifestProject, ManifestRow, ManifestStartWrite, ManifestSummaryProject, ManifestWrite,
} from "../../../shared/manifest.ts";

/* ── words ─────────────────────────────────────────────────────────────── */

/** The age of the last answer, in the words the header and the stale pill share. */
export function ageWords(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 60_000) return "less than a minute ago";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}

/** Local wall clock, HH:MM. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "yesterday" or a weekday: what a span's start is called beside its clock. */
export function dayWords(ms: number, now = Date.now()): string {
  const days = Math.round((dayStart(now) - dayStart(ms)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return new Date(ms).toLocaleDateString(undefined, { weekday: "long" });
}

/** The pill on a row: "committed 02:14". */

/** How long an agent has been working: "started 06:48 · 38 min". */
export function startedLine(startedAt: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - startedAt) / 60_000));
  return `started ${clock(startedAt)} · ${mins} min`;
}

/** "1 Nov 2026, 09:00": the date and time a project's count begins. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dateTimeWords(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${clock(ms)}`;
}

/** The header's line about the start line: when counting began, and the older
 *  commits the line leaves out. Null before the first answer names one. */
export function startLineWords(start: { at: number; omitted: number } | null): string | null {
  if (!start) return null;
  const older = start.omitted === 1 ? "1 older commit is" : `${start.omitted} older commits are`;
  return `Counting from ${dateTimeWords(start.at)} · ${older} not listed`;
}

/** The verdict pill on a signed row. */
export function verdictLine(verdict: "tested" | "failed", at: number | null): string {
  return `${verdict === "tested" ? "Tested" : "Failed"} by you${at == null ? "" : ` · ${clock(at)}`}`;
}

/** The sign-off line in a signed row's body. */
export function signoffLine(verdict: "tested" | "failed", at: number | null, kind: "person" | "phone" | null, note: string | null): string {
  const when = at == null ? "" : ` · ${clock(at)}`;
  const from = kind === "phone" ? " · from the phone" : " · from the desktop";
  return `${verdict === "tested" ? "Tested" : "Failed"} by you${when}${from}${note ? ` · “${note}”` : ""}`;
}

/** "1 fix" / "3 fixes": the aggregate row's title counts things, not rows of text. */
export function fixesLanded(n: number): string {
  return `${n} ${n === 1 ? "fix" : "fixes"} landed after the build you are running`;
}

/** The header's line about what waits for the person. */
export function leftLine(project: { left: number; name: string }, summary: ManifestSummaryProject[] | null): string {
  if (project.left > 0) return `${project.left} left for you`;
  const other = (summary ?? []).find((p) => p.left > 0 && p.name !== project.name);
  if (other) return `${other.left} left for you in ${other.name}`;
  return "nothing left for you";
}

/** The since-when strip: one bucket per hour across the span, in the plan's
 *  scale (44 px is the largest bucket, 3 px the smallest non-zero, 2 px empty).
 *  The last bucket is "now". */
export function stripBars(times: number[], start: number, now: number, height = 44): number[] {
  const span = Math.max(1, now - start);
  const buckets = Math.min(48, Math.max(2, Math.round(span / 3_600_000)));
  const counts = new Array<number>(buckets).fill(0);
  for (const t of times) {
    if (t < start || t > now) continue;
    const i = Math.min(buckets - 1, Math.floor(((t - start) / span) * buckets));
    counts[i] = (counts[i] ?? 0) + 1;
  }
  const max = Math.max(1, ...counts);
  return counts.map((c) => (c === 0 ? 2 : Math.max(3, Math.round((c / max) * height))));
}

/* ── the summary the rail dot reads ────────────────────────────────────── */

const SUMMARY_MS = 60_000;
let projects: ManifestSummaryProject[] | null = null;
let reading = false;
let stopped: (() => void) | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const fn of listeners) fn(); };

/** The last summary, or null before the first answer. Stable by identity: the
 *  rail's useSyncExternalStore compares snapshots. */
export function summarySnapshot(): ManifestSummaryProject[] | null {
  return projects;
}

/** Whether any project has something waiting for the person this caller may sign. */
export function summaryHasLeft(list: ManifestSummaryProject[] | null): boolean {
  return (list ?? []).some((p) => p.signOff === "yes" && p.trunk && p.left > 0);
}

export async function refreshSummary(): Promise<void> {
  if (reading) return;
  reading = true;
  try {
    const r = await api.manifestSummary();
    if (r.ok && r.answer) {
      projects = r.answer.projects;
      emit();
    }
  } finally {
    reading = false;
  }
}

function startPolling(): void {
  if (stopped) return;
  const ask = () => { if (!document.hidden) void refreshSummary(); };
  const id = setInterval(ask, SUMMARY_MS);
  window.addEventListener("focus", ask);
  document.addEventListener("visibilitychange", ask);
  stopped = () => {
    clearInterval(id);
    window.removeEventListener("focus", ask);
    document.removeEventListener("visibilitychange", ask);
  };
  void refreshSummary();
}

function stopPolling(): void {
  stopped?.();
  stopped = null;
}

/** The rail subscribes for the life of the workspace. The summary is read once
 *  on the first subscriber and then every minute while the document is visible. */
export function subscribeSummary(fn: () => void): () => void {
  listeners.add(fn);
  startPolling();
  return () => {
    listeners.delete(fn);
    if (!listeners.size) stopPolling();
  };
}

/** After a verdict: the dot cannot stay on for a row already signed. */
export async function signOff(project: string, sha: string, verdict: "tested" | "failed" | "cleared", note?: string): Promise<ManifestWrite> {
  const answer = await api.manifestSign({ project, sha, verdict, ...(note ? { note } : null) });
  if (answer.ok) void refreshSummary();
  return answer;
}

/** Move one project's start line to its trunk's current commit. */
export async function startProject(root: string): Promise<ManifestStartWrite> {
  const answer = await api.manifestStart(root);
  if (answer.ok) void refreshSummary();
  return answer;
}

/** One project's rows. `answer` is null on a refusal, and `error` is the
 *  server's own sentence when it gave one. */
export async function readProject(root: string): Promise<ManifestRead<ManifestProject>> {
  return api.manifestProject(root);
}

/* ── the project filter ────────────────────────────────────────────────── */

/** The filter's value for "every project the Manifest knows". */
export const ALL_PROJECTS = "*";

/** Where this window keeps the project it last chose. */
const SCOPE_KEY = "agx.manifest.scope";

/** A row and the project it came from. A merged list still knows whose verdict
 *  it carries, so the sign-off goes to that project and not to the filter. */
export interface ManifestRowRef extends ManifestRow {
  project: string;
  projectName: string;
}

export interface ManifestInProgressRef extends ManifestInProgress {
  project: string;
  projectName: string;
}

/** One project's answer, or every project's merged, as the view draws it. */
export interface ManifestProjectView extends Omit<ManifestProject, "rows" | "inProgress" | "start"> {
  rows: ManifestRowRef[];
  inProgress: ManifestInProgressRef[];
  /** A merged list counts from the earliest line; the number is every project's. */
  start: { at: number; omitted: number } | null;
}

/** The filter earns its row only when there is a second project to choose. */
export function showsFilter(summary: ManifestSummaryProject[] | null): boolean {
  return (summary?.length ?? 0) > 1;
}

/** The scope this window may draw: the remembered project while it is still
 *  open, and All otherwise (a project can be closed between visits). */
export function readScope(roots: string[]): string {
  let saved: string | null = null;
  try { saved = localStorage.getItem(SCOPE_KEY); } catch { /* a window that refuses storage keeps All */ }
  return saved === ALL_PROJECTS || (saved != null && roots.includes(saved)) ? saved : ALL_PROJECTS;
}

/** Remember the choice for this window. A refusal still filters, it is just not
 *  remembered after a reload. */
export function rememberScope(scope: string): void {
  try { localStorage.setItem(SCOPE_KEY, scope); } catch { /* see above */ }
}

/**
 * The rows and counters the filter shows.
 *
 * The server answers one project at a time, so the merge happens here: every
 * project's rows, newest first, each tagged with its own project. The counters
 * are recomputed from what is drawn, so they follow the filter; for one project
 * they are the numbers the server sent for it.
 */
export function projectView(answers: ManifestProject[], scope: string): ManifestProjectView | null {
  const all = scope === ALL_PROJECTS;
  const picked = all ? answers : answers.filter((a) => a.root === scope);
  if (!picked.length) return null;
  const rows = picked
    .flatMap((a) => a.rows.map((r) => ({ ...r, project: a.root, projectName: a.name })))
    .sort((a, b) => b.time - a.time);
  const inProgress = picked
    .flatMap((a) => a.inProgress.map((r) => ({ ...r, project: a.root, projectName: a.name })))
    .sort((a, b) => b.startedAt - a.startedAt);
  // The earliest line is at or before every selected project's line, and the
  // omitted count is theirs together: one sentence that is true for the merge.
  const starts = picked.flatMap((a) => (a.start ? [a.start] : []));
  const start = starts.length
    ? { at: Math.min(...starts.map((s) => s.at)), omitted: starts.reduce((n, s) => n + s.omitted, 0) }
    : null;
  return {
    root: all ? "" : picked[0]!.root,
    name: all ? "All projects" : picked[0]!.name,
    // A merge of projects keeps the build boundary when any of them has one, so
    // the ready group can still be drawn for the rows that have it.
    boundary: picked.some((a) => a.boundary === "build") ? "build" : "none",
    trunk: picked.some((a) => a.trunk),
    signOff: picked.find((a) => a.signOff !== "yes")?.signOff ?? "yes",
    start,
    rows,
    inProgress,
    counters: {
      merged: rows.length,
      running: inProgress.length,
      builtWaiting: rows.some((r) => r.inBuild !== null) ? rows.filter((r) => r.group === "ready").length : null,
    },
    left: rows.filter((r) => r.group === "toTest" && !r.verdict).length,
  };
}
