// Repo insights + changelog — read-only analytics over `git log`, served as
// /git/stats and /git/changelog. Both fan out with gitAsync so the terminal's
// loop thread never blocks on the log walks.

import { gitAsync, git, safeAbs } from "./git.ts";
import type { Changelog } from "../../shared/types.ts";

const US = "\x1f";
const RS = "\x1e";
const TRAIL_RS = new RegExp(RS + "$");

export type RepoInsightContributor = { name: string; email: string; commits: number; added: number; deleted: number };
export type RepoInsightHotspot = { path: string; commits: number; added: number; deleted: number };
export type RepoInsightDay = { date: string; commits: number; added: number; deleted: number };
export type RepoStats = {
  days: number;
  commitsPerDay: number;
  contributors: RepoInsightContributor[];
  filesTouched: number;
  linesChanged: number;
  topContributors: RepoInsightContributor[];
  hotspots: RepoInsightHotspot[];
  churn: RepoInsightDay[];
  /** A repository with no commit yet: a clean zero answer, not a git error. */
  empty?: boolean;
  error?: string;
};

export type ChangelogEntry = { kind: string; scope: string; breaking: boolean; subject: string; hash: string };
export type ChangelogSection = { title: string; entries: ChangelogEntry[] };
export type { Changelog };

function rootOf(rootIn: unknown): string | null {
  const abs = safeAbs(rootIn);
  if (!abs) return null;
  const r = git(abs, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** Does `root` have a commit to read? A fresh `git init` fails every log walk
 *  with "your current branch ... does not have any commits yet". */
async function hasCommits(root: string, rev = "HEAD"): Promise<boolean> {
  const r = await gitAsync(root, ["rev-parse", "--verify", "-q", "--end-of-options", `${rev}^{commit}`]);
  return r.code === 0;
}

const NUMSTAT_CHUNK = 400;
const NUMSTAT_ROW = /^(\d+|-)\t(\d+|-)\t(.*)$/s;

/** Parse `log --numstat -z` into rows per commit. With -z a rename row is
 *  "<a>\t<d>\t" and the old and new paths follow as two more NUL fields, so
 *  the new path is read whole instead of un-braced out of "src/{a => b}/x". */
export function parseNumstatZ(out: string): { sha: string; added: number; deleted: number; path: string; renamedFrom?: string }[] {
  const rows: { sha: string; added: number; deleted: number; path: string; renamedFrom?: string }[] = [];
  const f = out.split("\0");
  let sha = "";
  for (let i = 0; i < f.length; i++) {
    const tok = f[i].replace(/^\n+/, "");
    if (tok.startsWith(":AGX:")) { sha = tok.slice(5).trim(); continue; }
    const m = NUMSTAT_ROW.exec(tok);
    if (!m) continue;
    let path = m[3];
    let renamedFrom: string | undefined;
    if (!path) { renamedFrom = f[i + 1] || undefined; path = f[i + 2] ?? ""; i += 2; }
    if (!path) continue;
    rows.push({ sha, added: m[1] === "-" ? 0 : parseInt(m[1], 10), deleted: m[2] === "-" ? 0 : parseInt(m[2], 10), path, ...(renamedFrom ? { renamedFrom } : {}) });
  }
  return rows;
}

/** Stats over the last `days` days: per-day commit/churn series, contributor
 *  totals, and file hot-spots. Two walks: a commit list (sha, time, author)
 *  and a `--numstat -z` walk whose per-commit ":AGX:<sha>" markers attribute
 *  every added/deleted row to its commit — and through it, to a day.
 *
 *  The window is by AUTHOR date over the whole history. Plain `--since` stops
 *  walking at the first commit older than the cutoff, so one old-dated commit
 *  (a rebase, a merged branch, a skewed clock) hid every newer commit behind
 *  it: 2 / 1 / 2 against a truth of 9 / 4 / 29 on 7d / 30d / 90d.
 *  The commit list therefore reads the whole history (no diffs, one short
 *  line per commit) and cuts by author date here; the numstat walk then runs
 *  over only the surviving shas, in chunks that stay under the argv limit.
 *  A committer-date prefilter would drop a commit authored inside the window
 *  but recorded before it (a skewed clock, an imported history). */
export async function repoStats(rootIn: unknown, daysIn: unknown): Promise<RepoStats> {
  const root = rootOf(rootIn);
  const days = Math.max(1, Math.min(3650, Number(daysIn) || 30));
  const zero = { days, commitsPerDay: 0, contributors: [], filesTouched: 0, linesChanged: 0, topContributors: [], hotspots: [], churn: [] };
  if (!root) return zero;
  if (!(await hasCommits(root))) return { ...zero, empty: true };
  // Whole UTC days, today included: `days` bars, and the tiles count the same commits the bars show.
  const cutoff = Math.floor(Date.now() / 86_400_000) * 86_400 - (days - 1) * 86_400;
  const meta = await gitAsync(root, ["log", "--no-merges", `--pretty=%H${US}%at${US}%an${US}%ae${RS}`]);
  if (meta.code !== 0) return { ...zero, error: meta.stderr.trim() || "git log failed" };
  const inWindow: string[] = [];
  for (const line of meta.stdout.split("\n")) {
    const [sha, at] = line.split(US);
    if (sha && Number(at) >= cutoff) inWindow.push(sha.replace(TRAIL_RS, ""));
  }
  let numOut = "";
  for (let i = 0; i < inWindow.length; i += NUMSTAT_CHUNK) {
    const r = await gitAsync(root, ["log", "--no-walk=unsorted", "-M", "--numstat", "-z", "--pretty=:AGX:%H", "--end-of-options", ...inWindow.slice(i, i + NUMSTAT_CHUNK)]);
    if (r.code !== 0) return { ...zero, error: r.stderr.trim() || "git log failed" };
    numOut += r.stdout;
  }
  const num = { stdout: numOut };
  const byDay = new Map<string, { commits: number; added: number; deleted: number }>();
  const shaDate = new Map<string, string>();
  const contrib = new Map<string, RepoInsightContributor>();
  const shaAuthor = new Map<string, string>();
  for (const line of meta.stdout.split("\n")) {
    const [sha, at, name, email] = line.split(US);
    if (!sha || !at || Number(at) < cutoff) continue;
    const date = new Date(Number(at) * 1000).toISOString().slice(0, 10);
    shaDate.set(sha, date);
    const day = byDay.get(date) ?? { commits: 0, added: 0, deleted: 0 };
    day.commits++;
    byDay.set(date, day);
    const key = `${name}\x00${email}`.replace(TRAIL_RS, "");
    const c = contrib.get(key) ?? { name, email: (email || "").replace(TRAIL_RS, ""), commits: 0, added: 0, deleted: 0 };
    c.commits++;
    contrib.set(key, c);
    shaAuthor.set(sha, key);
  }
  const hotspots = new Map<string, { commits: number; added: number; deleted: number; renamedFrom?: string }>();
  let curSha = "";
  const seen = new Set<string>();
  for (const { sha, added, deleted, path, renamedFrom } of parseNumstatZ(num.stdout)) {
    // Only commits that passed the author-date cut above.
    if (!shaDate.has(sha)) continue;
    if (sha !== curSha) { curSha = sha; seen.clear(); }
    const h = hotspots.get(path) ?? { commits: 0, added: 0, deleted: 0 };
    h.added += added;
    h.deleted += deleted;
    if (renamedFrom && !h.renamedFrom) h.renamedFrom = renamedFrom;
    if (!seen.has(path)) { seen.add(path); h.commits++; }
    hotspots.set(path, h);
    const who = contrib.get(shaAuthor.get(sha) ?? "");
    if (who) { who.added += added; who.deleted += deleted; }
    const day = byDay.get(shaDate.get(sha) ?? "");
    if (day) { day.added += added; day.deleted += deleted; }
  }
  const churn: RepoInsightDay[] = [...byDay.entries()].map(([date, d]) => ({ date, ...d })).sort((a, b) => a.date.localeCompare(b.date));
  let linesChanged = 0;
  for (const h of hotspots.values()) linesChanged += h.added + h.deleted;
  const contributors = [...contrib.values()].map((c) => ({ ...c })).sort((a, b) => b.commits - a.commits);
  return {
    days,
    commitsPerDay: churn.length ? Math.round(churn.reduce((s, d) => s + d.commits, 0) / churn.length) : 0,
    contributors,
    filesTouched: hotspots.size,
    linesChanged,
    topContributors: contributors.slice(0, 8),
    hotspots: [...hotspots.entries()].map(([path, h]) => ({ path, ...h })).sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted)).slice(0, 12),
    churn,
  };
}

/** Changelog from the conventional-commits subjects between two refs.
 *  Defaults: latest tag → HEAD (or the whole log when there is no tag). */
export const FIRST_COMMIT = "@first";
export async function generateChangelog(rootIn: unknown, fromIn: unknown, toIn: unknown): Promise<Changelog> {
  const root = rootOf(rootIn);
  if (!root) return { from: "", to: "", sections: [] };
  const to = String(toIn ?? "HEAD").trim() || "HEAD";
  if (!(await hasCommits(root, to))) {
    // A fresh repo has nothing to list; a named ref that does not resolve is a real error.
    return to === "HEAD" ? { from: "", to, sections: [], empty: true } : { from: String(fromIn ?? "").trim(), to, sections: [], error: `unknown revision: ${to}` };
  }
  let from = String(fromIn ?? "").trim();
  // "@first": the whole history up to `to`, not the latest tag the empty default picks.
  if (from === FIRST_COMMIT) from = "";
  else if (!from) {
    const tag = await gitAsync(root, ["describe", "--tags", "--abbrev=0"]);
    from = tag.code === 0 ? tag.stdout.trim() : "";
  }
  const range = from ? `${from}..${to}` : to;
  // `from` and `to` come off the query string; `--end-of-options` makes git
  // read the range as a revision whatever it starts with.
  const r = await gitAsync(root, ["log", "--no-merges", `--pretty=%H${US}%s${RS}`, "--end-of-options", range]);
  if (r.code !== 0) return { from, to, sections: [], error: r.stderr.trim() || "git log failed" };
  const entries: ChangelogEntry[] = [];
  const re = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const [hash, subject] = line.split(US);
    const subj = (subject || "").replace(TRAIL_RS, "");
    const m = re.exec(subj);
    if (!m) {
      entries.push({ kind: "other", scope: "", breaking: false, subject: subj, hash: hash.slice(0, 7) });
      continue;
    }
    entries.push({ kind: m[1].toLowerCase(), scope: m[2] || "", breaking: !!m[3], subject: m[4], hash: hash.slice(0, 7) });
  }
  const groups: ChangelogEntry[][] = [[], [], [], [], []];
  const titles = ["Breaking changes", "Features", "Fixes", "Performance", "Other"];
  for (const e of entries) {
    if (e.breaking) groups[0].push(e);
    else if (e.kind === "feat") groups[1].push(e);
    else if (e.kind === "fix") groups[2].push(e);
    else if (e.kind === "perf") groups[3].push(e);
    else groups[4].push(e);
  }
  const sections: ChangelogSection[] = groups
    .map((list, i) => ({ title: titles[i], entries: list }))
    .filter((s) => s.entries.length);
  // Every commit in the range, merges included: what the picker's count says,
  // so the footer can tell how many of them the sections above do not list.
  const total = await gitAsync(root, ["rev-list", "--count", "--end-of-options", range]);
  const sinceCount = total.code === 0 ? Number(total.stdout.trim()) || 0 : undefined;
  return { from, to, sections, ...(sinceCount === undefined ? {} : { sinceCount, unlisted: Math.max(0, sinceCount - entries.length) }) };
}
