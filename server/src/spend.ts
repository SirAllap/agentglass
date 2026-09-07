// What the agents spent, joined to the work object a person actually thinks in:
// a worktree, a branch, a pull request.
//
// The rest of this market infers that mapping from a remote usage feed — the
// records arrive without a checkout attached, so somebody has to guess which
// branch they belonged to. This machine has both halves in one SQLite file
// already. `events` carries the directory the turn ran in (`cwd_path`, a
// generated column, indexed beside the timestamp) and, for the agents that
// record it, the branch that was checked out at the time
// (`payload.git_branch`, written by the transcript scanner). So attribution is
// a GROUP BY and a join against `git worktree list`, not an integration, and it
// is worth keeping it that way: the day this needs a table of its own it has
// stopped being the thing that makes it defensible.
//
// What the join CANNOT know matters as much as what it can, because a figure
// with two decimal places reads as a measurement:
//
//  - Only some agents record a branch. Those turns that do not are attributed
//    through the directory they ran in, which is right up until the day that
//    worktree was on a different branch. An afternoon spent in a worktree
//    before this branch existed lands on whatever is checked out there now.
//  - Retention folds expiring events into `daily_rollup`, and that table is
//    keyed by (day, project, session, model, provider) — no cwd, no branch.
//    Money older than the retention window is real and is simply not splittable
//    any more. Adding the two columns would not recover it either: the fold
//    would have to change its primary key, and every row already written was
//    summed without them.
//
// Both live in their own fields rather than being folded into one total, so the
// panel can say which part of the number it is sure of instead of rounding the
// doubt away. See PrPanel's spend chip for the wording that comes out of it.
import { resolve } from "node:path";
import { failed } from "./refused.ts";
import { db, scopeClause, RETENTION_DAYS, retentionSeamDay, spendBetween } from "./db.ts";
import { isWithin } from "./config.ts";
import { gitAsync } from "./git.ts";

/** One (branch, directory, session) group, exactly as SQLite hands it over.
 *  Grouping down to the session as well as the branch costs nothing — a session
 *  works in one place — and it is what lets the session count be a real
 *  distinct count instead of a sum of per-group counts that double-counts the
 *  one session that moved between two branches. */
export interface SpendRow {
  /** The branch the turn itself recorded, or '' when it recorded none. */
  branch: string;
  /** The directory the turn ran in: `cwd_path`, falling back to the repo root,
   *  because the scanner only writes a cwd when it differs from the root. */
  dir: string;
  session_id: string;
  usd: number;
  last_ts: number;
}

export interface BranchSpend {
  branch: string;
  /** namedUsd + inferredUsd, so a caller that only wants a number has one. */
  usd: number;
  /** The part that turns claimed for this branch themselves. Exact. */
  namedUsd: number;
  /** The part attributed only because it ran in a directory that has this
   *  branch out *now*. Best effort — see the header. */
  inferredUsd: number;
  sessions: number;
  lastTs: number;
  /** The checkouts that contributed, so the panel can name the one it is
   *  guessing from rather than saying "somewhere". */
  dirs: string[];
}

export interface DirSpend {
  dir: string;
  /** The branch that checkout has out now, or null when git does not say
   *  (detached HEAD, or a directory that is no longer a worktree at all). */
  branch: string | null;
  usd: number;
  sessions: number;
  lastTs: number;
}

export interface RepoSpend {
  ok: boolean;
  error?: string;
  /** The oldest instant this answer can see. 0 when retention is off, which is
   *  the only case where it is the whole history. */
  since: number;
  /** The UTC day the retention boundary falls in, or null when nothing is
   *  pruned — the date the panel names when it says how far back it can split. */
  seamDay: string | null;
  /** Spend this project has from before the seam: folded to (day, project) and
   *  no longer attributable to any branch. Reported rather than dropped,
   *  because "we cannot split this" and "this did not happen" are different. */
  beforeSeamUsd: number;
  branches: BranchSpend[];
  worktrees: DirSpend[];
}

/**
 * Every checkout of this repo and the branch it has out right now.
 *
 * One `git worktree list` per request, never per row — the whole point of
 * building the map here is that the join happens in memory afterwards.
 *
 * A detached HEAD produces no `branch` line and is deliberately left out: a
 * checkout sitting on a sha belongs to no branch, and inventing one for it is
 * exactly the kind of guess this file exists to keep out of the total. Paths
 * are resolve()d because that is the shape `cwd_path` was written in
 * (transcripts.ts resolves before recording), and a trailing slash or a symlink
 * spelling would silently match nothing.
 */
export async function checkoutBranches(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const r = await gitAsync(root, ["worktree", "list", "--porcelain"]);
  if (r.code !== 0) return out;
  let dir = "";
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) dir = resolve(line.slice("worktree ".length).trim());
    else if (dir && line.startsWith("branch refs/heads/")) out.set(dir, line.slice("branch refs/heads/".length).trim());
    else if (!line.trim()) dir = "";
  }
  return out;
}

/**
 * The attribution rule itself, kept pure so it can be pinned.
 *
 * Two decisions live here and neither is obvious enough to leave implicit:
 *
 * 1. A turn's OWN branch beats the branch its directory is on now. An agent
 *    that worked on `fix/rounding` in a worktree since moved to `feat/rail`
 *    counts against `fix/rounding` — the turn recorded where it was, and the
 *    checkout only knows where it is. This also means named spend survives the
 *    worktree being deleted after a merge, which is the normal end of a branch.
 * 2. A turn with no branch of its own is attributed through its directory, and
 *    that half of the money is kept apart in `inferredUsd` for the whole
 *    journey. It never merges into `namedUsd`, so a caller cannot lose track of
 *    which part it is allowed to state flatly.
 *
 * A turn with neither — no branch recorded, in a directory git no longer calls
 * a worktree — reaches no branch at all. It still appears under `worktrees`,
 * because "this checkout cost money that no branch claims" is a true and useful
 * sentence, and dropping it would make the branch totals silently fail to add
 * up to the project's.
 */
export function attributeSpend(
  rows: SpendRow[],
  checkouts: Map<string, string>
): { branches: BranchSpend[]; worktrees: DirSpend[] } {
  /*
   * The directory a turn recorded is where the AGENT was standing, which is not
   * always the top of a checkout: an agent that worked inside a package of a
   * monorepo records the package. Matched against the longest containing
   * checkout, which is the same answer `git -C` would give and the reason it has
   * to be the longest — the repo root contains every linked worktree nested
   * under it, so a plain "first ancestor wins" would file half the worktrees'
   * work under whatever the root has out.
   */
  const nested = [...checkouts.keys()].sort((a, z) => z.length - a.length);
  const branchOfDir = (dir: string): string => {
    const exact = checkouts.get(dir);
    if (exact) return exact;
    const owner = nested.find((c) => isWithin(dir, c));
    return owner ? checkouts.get(owner)! : "";
  };

  type BranchAcc = { namedUsd: number; inferredUsd: number; lastTs: number; sessions: Set<string>; dirs: Set<string> };
  type DirAcc = { usd: number; lastTs: number; sessions: Set<string> };
  const byBranch = new Map<string, BranchAcc>();
  const byDir = new Map<string, DirAcc>();

  for (const r of rows) {
    const usd = Number(r.usd) || 0;
    if (usd <= 0) continue;
    const dir = (r.dir || "").trim();
    const named = (r.branch || "").trim();

    if (dir) {
      const d = byDir.get(dir) ?? { usd: 0, lastTs: 0, sessions: new Set<string>() };
      d.usd += usd;
      d.lastTs = Math.max(d.lastTs, r.last_ts);
      d.sessions.add(r.session_id);
      byDir.set(dir, d);
    }

    const branch = named || (dir ? branchOfDir(dir) : "");
    if (!branch) continue;
    const b = byBranch.get(branch) ?? { namedUsd: 0, inferredUsd: 0, lastTs: 0, sessions: new Set<string>(), dirs: new Set<string>() };
    if (named) b.namedUsd += usd; else b.inferredUsd += usd;
    b.lastTs = Math.max(b.lastTs, r.last_ts);
    b.sessions.add(r.session_id);
    if (dir) b.dirs.add(dir);
    byBranch.set(branch, b);
  }

  const branches: BranchSpend[] = [...byBranch].map(([branch, b]) => ({
    branch,
    usd: b.namedUsd + b.inferredUsd,
    namedUsd: b.namedUsd,
    inferredUsd: b.inferredUsd,
    sessions: b.sessions.size,
    lastTs: b.lastTs,
    dirs: [...b.dirs].sort(),
  })).sort((a, z) => z.usd - a.usd);

  const worktrees: DirSpend[] = [...byDir].map(([dir, d]) => ({
    dir,
    branch: branchOfDir(dir) || null,
    usd: d.usd,
    sessions: d.sessions.size,
    lastTs: d.lastTs,
  })).sort((a, z) => z.usd - a.usd);

  return { branches, worktrees };
}

/**
 * The one query. Grouped in SQLite, joined in JS — the same shape scopeClause()
 * itself was rewritten into and for the same reason: the set of paths is tiny
 * and the set of rows is not.
 *
 * `cost_usd > 0` is what keeps this cheap. Only the turns that carried usage
 * have a cost, a small minority of the events in any window, and the rest are
 * rejected before `json_extract` is ever asked to parse a payload.
 *
 * Measured on a real 314 MB cockpit, 81,692 events, one project with four
 * recorded checkouts: 36 ms, of which 14 ms is finding the 9,730 costed rows at
 * all and 10 ms is the json_extract over them. The plan is the MULTI-INDEX OR
 * over idx_events_project_ts and idx_events_cwd_ts that scopeClause was shaped
 * for, so the window is honoured inside the index rather than row by row. That
 * is a synchronous block on the thread the terminal rides, which is why the
 * answer is cached for the whole board rather than asked per pull request.
 */
export function spendRows(root: string, since: number): SpendRow[] {
  const { clause, args } = scopeClause(root);
  return db
    .query<SpendRow, any[]>(
      `SELECT COALESCE(json_extract(payload, '$.git_branch'), '') AS branch,
              COALESCE(cwd_path, project_path, '') AS dir,
              session_id,
              SUM(cost_usd) AS usd,
              MAX(timestamp) AS last_ts
         FROM events
        WHERE timestamp >= ? AND cost_usd > 0${clause}
        GROUP BY 1, 2, 3`
    )
    .all(since, ...args);
}

/** The day before a given YYYY-MM-DD, in UTC. */
function dayBefore(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/**
 * How much of this project's spend is older than anything a branch can claim.
 *
 * Asked of spendBetween() rather than of `daily_rollup` directly, because that
 * table's scope test is not the events one — `project_path` there is often a
 * directory inside a checkout — and there is exactly one correct version of it
 * in db.ts. The range stops the day BEFORE the seam: the seam day itself still
 * has live events in it, and those are attributable, so including it would move
 * money out of the branch totals and into the bucket that says nobody knows.
 *
 * With pruning disabled there is no seam and nothing has been folded, so the
 * honest answer is zero without asking.
 */
function spendBeforeSeam(root: string, seamDay: string | null): number {
  if (!seamDay) return 0;
  try {
    return spendBetween({ fromDay: "0001-01-01", toDay: dayBefore(seamDay), root });
  } catch {
    return 0;
  }
}

// A short TTL, not none and not minutes. This is asked once per board draw, and
// the board is the heaviest panel in the app: the answer must not be recomputed
// for the second and third component that wants it, and it must not be so stale
// that a review session's own spend fails to appear while it is happening.
const TTL_MS = 15_000;
const cache = new Map<string, { at: number; value: RepoSpend }>();

/** Drop what is remembered. Exported for tests, which seed a database and then
 *  ask the same root twice on purpose. */
export function forgetSpend(): void { cache.clear(); }

/**
 * Spend for one repository, broken down by branch and by checkout.
 *
 * One SQL query and one `git worktree list` per call, whatever the size of the
 * board — the caller looks its pull requests up in the returned map. A
 * per-row question here would be a per-row query on the panel that already
 * costs the most, which is the one thing this must not become.
 */
export async function repoSpend(rootIn: unknown): Promise<RepoSpend> {
  const root = typeof rootIn === "string" ? rootIn.trim() : "";
  if (!root) return { ok: false, error: "no project", since: 0, seamDay: null, beforeSeamUsd: 0, branches: [], worktrees: [] };

  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  // The floor is retention's, because that is genuinely as far back as the
  // events table goes. With pruning off nothing has been deleted and the whole
  // history is fair game — the user who turned it off asked for exactly that.
  const since = RETENTION_DAYS ? Date.now() - RETENTION_DAYS * 86_400_000 : 0;
  const seamDay = retentionSeamDay();
  let value: RepoSpend;
  try {
    const checkouts = await checkoutBranches(root);
    const { branches, worktrees } = attributeSpend(spendRows(root, since), checkouts);
    value = { ok: true, since, seamDay, beforeSeamUsd: spendBeforeSeam(root, seamDay), branches, worktrees };
  } catch (e) {
    // A failure here is a missing number on a chip, never a broken board — so
    // it is reported as one rather than thrown at the route.
    return { ok: false, error: failed("spend/repo", e, "the spend for this repository could not be read"), since, seamDay, beforeSeamUsd: 0, branches: [], worktrees: [] };
  }
  if (cache.size > 32) cache.clear();
  cache.set(root, { at: Date.now(), value });
  return value;
}
