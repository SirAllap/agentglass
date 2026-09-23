/*
 * Which repository a tmux window is working in — the key the tab strip groups
 * windows by.
 *
 * The project, not the checkout: a linked worktree beside the main one
 * (`~/code/orbit-fix-login`) is the same project as `~/code/orbit`, and five
 * agents in five worktrees of one repository are one group, not five. That is
 * `projectRootOf`'s answer (`--git-common-dir`), which is why it is used rather
 * than `--show-toplevel`.
 *
 * Resolved off the sweep. The strip is re-read twice a second on the thread the
 * terminal shares, so a directory seen for the first time starts a lookup and
 * answers `undefined` — the window is ungrouped until the next sweep, half a
 * second — and every later
 * sweep reads the cache. A directory moves between repositories about never, so
 * entries do not expire; the cache is bounded instead, oldest out.
 */
import { projectRootOfAsync } from "./git.ts";

/** Resolved root per directory; null is "not in a repository" — or a lookup
 *  that failed, which is why a null is asked again after NULL_TTL_MS: a `git
 *  init` in the pane's directory, or a spawn that timed out at startup, must
 *  not leave a window in "other" until the server restarts. */
const cache = new Map<string, { root: string | null; at: number }>();
const pending = new Set<string>();
const CAP = 512;
const NULL_TTL_MS = 60_000;

/**
 * The project root for a directory, null when it is in none, or undefined while
 * it is being looked up.
 */
export function windowRepo(
  dir: string,
  resolve: (d: string) => Promise<string | null> = projectRootOfAsync,
  now = Date.now(),
): string | null | undefined {
  if (!dir) return null;
  const hit = cache.get(dir);
  const stale = hit && hit.root === null && now - hit.at >= NULL_TTL_MS;
  if (hit) {
    // Refresh its place, so the bound drops directories nobody is in any more.
    cache.delete(dir);
    cache.set(dir, hit);
  }
  if ((!hit || stale) && !pending.has(dir)) {
    pending.add(dir);
    resolve(dir)
      .catch(() => null)
      .then((root) => {
        pending.delete(dir);
        cache.set(dir, { root, at: Date.now() });
        if (cache.size > CAP) cache.delete(cache.keys().next().value!);
      });
  }
  // A stale "no repository" keeps answering while it is asked again: the
  // window stays where it was rather than blinking out of its group.
  return hit ? hit.root : undefined;
}

/** Test seam. */
export function __resetWindowRepo(): void { cache.clear(); pending.clear(); }
