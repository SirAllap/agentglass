// Pure decisions behind the redrawn Insights window: the sentence, the day
// bars, the people and file bars, the range picker and the changelog states.
// No renderer in this project, so everything a test must press lives here.
import type { Changelog, GitRangeCounts, RepoInsightContributor, RepoInsightDay, RepoInsightHotspot, RepoStats } from "../../../shared/types.ts";

/** Sent as `from` to mean "the whole history", which an empty `from` cannot:
 *  empty means "the latest tag". The server reads the same string. */
export const FIRST_COMMIT = "@first";
export const FIRST_COMMIT_LABEL = "The first commit";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** "Oct 24" from "2026-10-24", read as the UTC day the server cut it by. */
export const dayLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// ---- the sentence ------------------------------------------------------------

export interface Sentence { days: number; people: string; commits: string; when: string; topFile: string | null }
/** "In the last 30 days 4 people made 48 commits on 19 of the days." as parts,
 *  so the screen can bold the numbers. With one active day the sentence names
 *  it instead of counting it. */
export function sentence(s: RepoStats): Sentence {
  const active = s.churn.filter((d) => d.commits > 0);
  const commits = active.reduce((n, d) => n + d.commits, 0);
  const when = active.length === 1 ? `all on one day (${dayLabel(active[0].date)})` : `on ${active.length} of the days`;
  return { days: s.days, people: plural(s.contributors.length, "person", "people"), commits: plural(commits, "commit"), when, topFile: s.hotspots[0]?.path ?? null };
}

/** The window has fewer than two days with commits: bars draw, a trend does not. */
export const fewDays = (s: RepoStats) => s.churn.filter((d) => d.commits > 0).length < 2;

export interface Tile { k: string; v: string; sub?: string }
export function tiles(s: RepoStats): Tile[] {
  const n = (v: number) => v.toLocaleString("en-US");
  const commits = s.churn.reduce((a, d) => a + d.commits, 0);
  const added = s.churn.reduce((a, d) => a + d.added, 0);
  const deleted = s.churn.reduce((a, d) => a + d.deleted, 0);
  return [
    { k: "Commits", v: n(commits), sub: `${(commits / Math.max(1, s.days)).toFixed(1)} a day` },
    { k: "People", v: String(s.contributors.length) },
    { k: "Files touched", v: n(s.filesTouched) },
    { k: "Lines changed", v: n(s.linesChanged), sub: `+${n(added)} −${n(deleted)}` },
  ];
}

// ---- day bars ----------------------------------------------------------------

export interface DayBar { date: string; commits: number; added: number; deleted: number }
/** One entry per day of the window ending `now`, empty days included: the
 *  server sends only days that had commits, and a chart with the gaps
 *  squeezed out lies about the pace. */
export function windowDays(churn: RepoInsightDay[], days: number, now = Date.now()): DayBar[] {
  const by = new Map(churn.map((d) => [d.date, d]));
  const end = Math.floor(now / DAY) * DAY;
  return Array.from({ length: days }, (_, i) => {
    const date = isoDay(end - (days - 1 - i) * DAY);
    const d = by.get(date);
    return { date, commits: d?.commits ?? 0, added: d?.added ?? 0, deleted: d?.deleted ?? 0 };
  });
}

export interface BarGeom { x: number; w: number; up: number; down: number; commits: number; date: string }
export interface Chart { w: number; h: number; mid: number; bars: BarGeom[]; labels: { x: number; text: string }[] }
/** Added up, removed down, from one axis; the scale is the largest side of any day. */
export function chartGeometry(data: DayBar[], w = 600, h = 120): Chart {
  const n = Math.max(1, data.length);
  const max = Math.max(1, ...data.map((d) => Math.max(d.added, d.deleted)));
  const slot = w / n, gap = n > 40 ? 1 : 2, bw = Math.min(slot - gap, 28), mid = h * 0.58;
  const bars = data.map((d, i) => ({
    x: i * slot + (slot - bw) / 2, w: bw, commits: d.commits, date: d.date,
    up: d.commits ? Math.max((d.added / max) * (mid - 6), d.added ? 1.5 : 0) : 0,
    down: d.commits ? Math.max((d.deleted / max) * (h - mid - 14), d.deleted ? 1.5 : 0) : 0,
  }));
  const step = n <= 7 ? 3 : n <= 31 ? 7 : 30;
  const idx = data.map((_, i) => i).filter((i) => i % step === 0);
  if (n - 1 - idx[idx.length - 1] >= step / 2) idx.push(n - 1);
  return { w, h, mid, bars, labels: idx.map((i) => ({ x: i * slot, text: dayLabel(data[i].date) })) };
}

// ---- people and file bars ----------------------------------------------------

export interface Split { addPct: number; delPct: number }
/** Each row's bar against the largest row: added green, removed red, same scale. */
export function splits(rows: { added: number; deleted: number }[]): Split[] {
  const max = Math.max(1, ...rows.map((r) => r.added + r.deleted));
  return rows.map((r) => ({ addPct: (r.added / max) * 100, delPct: (r.deleted / max) * 100 }));
}
export const initials = (c: Pick<RepoInsightContributor, "name" | "email">) => (c.name || c.email).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
export const splitPath = (p: string) => { const i = p.lastIndexOf("/"); return { dir: p.slice(0, i + 1), file: p.slice(i + 1) }; };
/** The subline under a file that moved inside the window, or null. */
export const renameNote = (h: RepoInsightHotspot) => (h.renamedFrom && h.renamedFrom !== h.path ? `renamed from ${h.renamedFrom}` : null);

// ---- range picker ------------------------------------------------------------

export interface RangeRow { value: string; label: string; age: string | null; count: number | null; kind: "tag" | "first" | "ref" | "branch" }
/** "2 d", "5 w", "2 mo", "1 y": how long ago a tag was made, one unit. */
export function ago(at: number | null, now = Date.now()): string | null {
  if (at == null) return null;
  const d = Math.max(0, Math.floor((now - at) / DAY));
  if (d < 14) return `${d} d`;
  if (d < 60) return `${Math.floor(d / 7)} w`;
  if (d < 365) return `${Math.floor(d / 30)} mo`;
  return `${Math.floor(d / 365)} y`;
}

/** The "From" list. Counts are "commits from this tag to HEAD", so they are
 *  only shown when the range ends at HEAD (`withCounts`); against another end
 *  they would be someone else's numbers. A typed ref that is none of the rows
 *  is offered as itself: the server says if it does not exist. */
export function fromRows(counts: GitRangeCounts | null, query: string, withCounts: boolean, now = Date.now()): { tags: RangeRow[]; other: RangeRow[] } {
  const q = query.trim().toLowerCase();
  const tags = (counts?.tags ?? []).filter((t) => !q || t.name.toLowerCase().includes(q))
    .map((t): RangeRow => ({ value: t.name, label: t.name, age: ago(t.at, now), count: withCounts ? t.count : null, kind: "tag" }));
  const other: RangeRow[] = [];
  if (!q || FIRST_COMMIT_LABEL.toLowerCase().includes(q)) other.push({ value: FIRST_COMMIT, label: FIRST_COMMIT_LABEL, age: null, count: withCounts && counts ? counts.root : null, kind: "first" });
  if (q && !tags.some((t) => t.label.toLowerCase() === q)) other.push({ value: query.trim(), label: `Use “${query.trim()}”`, age: null, count: null, kind: "ref" });
  return { tags, other };
}

/** The "To" list: HEAD, then branches, then tags, filtered by what was typed. */
export function toRows(branches: string[], tags: string[], query: string): { head: RangeRow[]; branches: RangeRow[]; tags: RangeRow[] } {
  const q = query.trim().toLowerCase();
  const row = (value: string, kind: RangeRow["kind"]): RangeRow => ({ value, label: value, age: null, count: null, kind });
  const keep = (names: string[], kind: RangeRow["kind"]) => names.filter((n) => !q || n.toLowerCase().includes(q)).map((n) => row(n, kind));
  const head = !q || "head".includes(q) ? [row("HEAD", "branch")] : [];
  const typed = q && !head.length && ![...branches, ...tags].some((n) => n.toLowerCase() === q) ? [row(query.trim(), "ref")] : [];
  return { head: [...head, ...typed], branches: keep(branches, "branch"), tags: keep(tags, "tag") };
}

/** What the From button shows: the picked ref, else the one the server chose, else the start of history. */
export const fromShown = (from: string, c: Changelog | null) => (from === FIRST_COMMIT ? FIRST_COMMIT_LABEL : from || c?.from || (c ? FIRST_COMMIT_LABEL : "latest tag"));

// ---- changelog states --------------------------------------------------------

/** "12 changes" for the range line; the commits in the range, merges and all. */
export function changesText(c: Changelog | null): string {
  if (!c || c.error) return "";
  const n = c.sinceCount ?? c.sections.reduce((a, s) => a + s.entries.length, 0);
  return plural(n, "change");
}

/** "9 other commits are not listed." or null when every commit is. */
export function unlistedText(c: Changelog | null): string | null {
  const n = c?.unlisted ?? 0;
  return n > 0 ? `${n} other commit${n === 1 ? " is" : "s are"} not listed.` : null;
}

export interface NothingNew { tag: string; older: { value: string; label: string; count: number } | null }
/** The range from a tag to HEAD holds no commit: HEAD is the tag. Offers the
 *  next older start (one press) and what it would show. Not for a picked
 *  `to`, and not for an error or an empty repository. */
export function nothingNew(c: Changelog | null, counts: GitRangeCounts | null): NothingNew | null {
  if (!c || c.error || c.empty || c.to !== "HEAD" || !c.from || c.sinceCount !== 0) return null;
  const tags = counts?.tags ?? [];
  const at = tags.findIndex((t) => t.name === c.from);
  const older = tags.slice(at + 1).find((t) => t.count > 0);
  if (older) return { tag: c.from, older: { value: older.name, label: older.name, count: older.count } };
  return { tag: c.from, older: counts && counts.root > 0 ? { value: FIRST_COMMIT, label: FIRST_COMMIT_LABEL.toLowerCase(), count: counts.root } : null };
}

/** The right column, one state at a time. */
export type ChangelogState = "loading" | "error" | "empty-repo" | "nothing-new" | "no-commits" | "list";
export function changelogState(c: Changelog | null, counts: GitRangeCounts | null): ChangelogState {
  if (!c) return "loading";
  if (c.error) return "error";
  if (c.empty) return "empty-repo";
  if (nothingNew(c, counts)) return "nothing-new";
  return c.sections.length ? "list" : "no-commits";
}

// ---- copy as markdown --------------------------------------------------------

export type CopyState = "idle" | "copied" | "failed";
export const COPY_RESET_MS = 2000;
export const COPY_FAILED_TIP = "The system did not let agentglass write to the clipboard. Select the list and copy it by hand.";
export function copyView(s: CopyState): { label: string; tip?: string; live: string; resetsAfter: number | null; selectable: boolean } {
  if (s === "copied") return { label: "Copied", live: "Changelog copied as Markdown", resetsAfter: COPY_RESET_MS, selectable: false };
  if (s === "failed") return { label: "Could not copy", tip: COPY_FAILED_TIP, live: "Could not copy the changelog. Select the list and copy it by hand.", resetsAfter: null, selectable: true };
  return { label: "Copy as Markdown", live: "", resetsAfter: null, selectable: false };
}
