// Repo insights + changelog — read-only analytics over `git log`, served as
// /git/stats and /git/changelog. Both fan out with gitAsync so the terminal's
// loop thread never blocks on the log walks.

import { gitAsync, git, safeAbs } from "./git.ts";

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
  error?: string;
};

export type ChangelogEntry = { kind: string; scope: string; breaking: boolean; subject: string; hash: string };
export type ChangelogSection = { title: string; entries: ChangelogEntry[] };
export type Changelog = { from: string; to: string; sections: ChangelogSection[]; error?: string };

function rootOf(rootIn: unknown): string | null {
  const abs = safeAbs(rootIn);
  if (!abs) return null;
  const r = git(abs, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** Stats over the last `days` days: per-day commit/churn series, contributor
 *  totals, and file hot-spots. Two walks: a commit list (sha, time, author)
 *  and a `--numstat` walk whose per-commit "\x01<sha>" markers attribute every
 *  added/deleted row to its commit — and through it, to a day. */
export async function repoStats(rootIn: unknown, daysIn: unknown): Promise<RepoStats> {
  const root = rootOf(rootIn);
  const days = Math.max(1, Math.min(3650, Number(daysIn) || 30));
  if (!root) return { days, commitsPerDay: 0, contributors: [], filesTouched: 0, linesChanged: 0, topContributors: [], hotspots: [], churn: [] };
  const since = `--since=${days} days ago`;
  const [meta, num] = await Promise.all([
    gitAsync(root, ["log", "--no-merges", since, `--pretty=%H${US}%at${US}%an${US}%ae${RS}`]),
    gitAsync(root, ["log", "--no-merges", "-M", since, "--numstat", `--pretty=:AGX:\x01%H${RS}`]),
  ]);
  if (meta.code !== 0 || num.code !== 0) {
    return { days, commitsPerDay: 0, contributors: [], filesTouched: 0, linesChanged: 0, topContributors: [], hotspots: [], churn: [], error: meta.stderr.trim() || num.stderr.trim() || "git log failed" };
  }
  const byDay = new Map<string, { commits: number; added: number; deleted: number }>();
  const shaDate = new Map<string, string>();
  const contrib = new Map<string, RepoInsightContributor>();
  for (const line of meta.stdout.split("\n")) {
    const [sha, at, name, email] = line.split(US);
    if (!sha || !at) continue;
    const date = new Date(Number(at) * 1000).toISOString().slice(0, 10);
    shaDate.set(sha, date);
    const day = byDay.get(date) ?? { commits: 0, added: 0, deleted: 0 };
    day.commits++;
    byDay.set(date, day);
    const key = `${name}\x00${email}`.replace(TRAIL_RS, "");
    const c = contrib.get(key) ?? { name, email: (email || "").replace(TRAIL_RS, ""), commits: 0, added: 0, deleted: 0 };
    c.commits++;
    contrib.set(key, c);
  }
  const hotspots = new Map<string, { commits: number; added: number; deleted: number }>();
  let curSha = "";
  for (const line of num.stdout.split("\n")) {
    if (line.startsWith(":AGX:\x01")) { curSha = line.slice(7); continue; }
    if (!line.trim()) continue;
    // numstat: <added>\t<deleted>\t<path>; a lone "-" means binary.
    const tab1 = line.indexOf("\t");
    const tab2 = tab1 === -1 ? -1 : line.indexOf("\t", tab1 + 1);
    if (tab1 === -1 || tab2 === -1) continue;
    const addedS = line.slice(0, tab1);
    const deletedS = line.slice(tab1 + 1, tab2);
    const added = addedS === "-" ? 0 : parseInt(addedS, 10);
    const deleted = deletedS === "-" ? 0 : parseInt(deletedS, 10);
    if (Number.isNaN(added) && Number.isNaN(deleted)) continue;
    // Rename detection renders the path as "{old => new}".
    const path = line.slice(tab2 + 1).replace(/^\{.*?\}\s*=>\s*/, "").trim();
    if (!path) continue;
    const h = hotspots.get(path) ?? { commits: 0, added: 0, deleted: 0 };
    h.added += added;
    h.deleted += deleted;
    hotspots.set(path, h);
    const date = shaDate.get(curSha);
    if (date) {
      const day = byDay.get(date);
      if (day) { day.added += added; day.deleted += deleted; }
    }
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
export async function generateChangelog(rootIn: unknown, fromIn: unknown, toIn: unknown): Promise<Changelog> {
  const root = rootOf(rootIn);
  if (!root) return { from: "", to: "", sections: [] };
  const to = String(toIn ?? "HEAD").trim() || "HEAD";
  let from = String(fromIn ?? "").trim();
  if (!from) {
    const tag = await gitAsync(root, ["describe", "--tags", "--abbrev=0"]);
    from = tag.code === 0 ? tag.stdout.trim() : "";
  }
  const range = from ? `${from}..${to}` : to;
  const r = await gitAsync(root, ["log", "--no-merges", `--pretty=%H${US}%s${RS}`, range]);
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
  return { from, to, sections };
}
