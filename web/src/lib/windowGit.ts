/*
 * The branch a window works on and the pull request out of it, for the two
 * places that name a window beyond the strip: the Go list and the peek card.
 *
 * A window's frame carries its repository and directory, not its branch, and
 * asking git for every window on every frame would be the polling this rebuild
 * took out. So it is asked when somebody looks: the Go list opening reads each
 * repository's worktree list once (one request per repository, not per
 * window), and the peek card reads the one window it is about. Both answers
 * are kept for CACHE_MS, so a second look is free.
 *
 * Ceiling: a window outside every worktree of its repository has no branch
 * here, and a repository without GitHub access has no pull request; the
 * card and the list then say less, never something invented.
 */
import { api } from "./api.ts";

const CACHE_MS = 30_000;

type Cached<T> = { at: number; value: Promise<T> };
const trees = new Map<string, Cached<{ path: string; branch: string }[]>>();
const prs = new Map<string, Cached<{ number: number; state: string; isDraft: boolean; review: string | null } | null>>();

function cached<T>(cache: Map<string, Cached<T>>, key: string, make: () => Promise<T>): Promise<T> {
  const seen = cache.get(key);
  if (seen && Date.now() - seen.at < CACHE_MS) return seen.value;
  const value = make();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

/** The worktree that holds `cwd`: the deepest one, so a nested checkout wins over its parent. */
export function branchAt(list: readonly { path: string; branch: string }[], cwd: string): string | null {
  let best: { path: string; branch: string } | null = null;
  for (const w of list) {
    if (w.branch === "(detached)" || !w.branch) continue;
    if ((cwd === w.path || cwd.startsWith(w.path.replace(/\/+$/, "") + "/")) && (!best || w.path.length > best.path.length)) best = w;
  }
  return best?.branch ?? null;
}

/** Branch per window id, for the windows that sit in a repository. */
export async function windowBranches(windows: readonly { id: string; repo?: string | null; cwd?: string }[]): Promise<Map<string, string>> {
  const repos = [...new Set(windows.map((w) => w.repo).filter((r): r is string => !!r))];
  const lists = new Map<string, { path: string; branch: string }[]>();
  await Promise.all(repos.map(async (r) => {
    lists.set(r, await cached(trees, r, () => api.gitWorktrees(r).then((x) => x.worktrees)).catch(() => []));
  }));
  const out = new Map<string, string>();
  for (const w of windows) {
    const b = w.repo && w.cwd ? branchAt(lists.get(w.repo) ?? [], w.cwd) : null;
    if (b) out.set(w.id, b);
  }
  return out;
}

/** The open pull request out of a branch, if GitHub answers. */
export function branchPr(root: string, branch: string) {
  return cached(prs, `${root}\0${branch}`, () => api.prsForBranch(root, branch).then((r) => {
    const f = r.from;
    return f ? { number: f.number, state: f.state, isDraft: f.isDraft, review: f.reviewDecision ?? null } : null;
  }));
}
