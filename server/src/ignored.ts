/**
 * Which of these paths does git ignore?
 *
 * The file-changes list mixes what an agent actually wrote with everything it
 * touched on the way — build output, caches, `.specs` scratch files, lockfile
 * churn — because the agent's own edits are recorded whether or not the repo
 * tracks the result. On a busy session that buries the handful of edits you
 * came to review under a hundred you don't care about.
 *
 * Git already knows the answer, and it is the only thing that does: .gitignore
 * has nested files, negations and per-repo excludes, so anything we
 * reimplemented here would be a worse guess. `check-ignore --stdin` asks it
 * once per repo instead of once per file — a hundred paths is one spawn.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

/** Repo root for a path, or null. Walks up looking for `.git` (a directory in
 *  a normal checkout, a file in a linked worktree). */
function repoRootOf(p: string): string | null {
  let dir = dirname(resolve(p));
  for (let i = 0; i < 40; i++) {
    if (existsSync(`${dir}/.git`)) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

const TTL_MS = 15_000;
const cache = new Map<string, { at: number; ignored: boolean }>();

/**
 * Mark each path as ignored or not.
 *
 * Cached briefly: the changes list is polled, and .gitignore does not move on
 * that timescale. A path we cannot place in a repo is reported as not ignored —
 * "we don't know" must not hide something from you.
 */
export function markIgnored(paths: string[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const now = Date.now();
  const byRoot = new Map<string, string[]>();

  for (const p of paths) {
    if (out.has(p)) continue;
    const hit = cache.get(p);
    if (hit && now - hit.at < TTL_MS) { out.set(p, hit.ignored); continue; }
    const root = repoRootOf(p);
    if (!root) { out.set(p, false); continue; }
    const list = byRoot.get(root);
    if (list) list.push(p);
    else byRoot.set(root, [p]);
  }

  for (const [root, list] of byRoot) {
    let ignored = new Set<string>();
    try {
      // `--stdin` with one path per line; exit 0 means at least one matched, 1
      // means none did, and both are normal. Anything else (not a repo, git
      // missing) leaves the set empty, i.e. nothing hidden.
      const r = spawnSync("git", ["-C", root, "check-ignore", "--stdin"], {
        input: list.join("\n"),
        encoding: "utf8",
        timeout: 5_000,
      });
      if (r.status === 0 && r.stdout) ignored = new Set(r.stdout.split("\n").filter(Boolean));
    } catch { /* treat as none ignored */ }
    for (const p of list) {
      const isIgnored = ignored.has(p);
      cache.set(p, { at: now, ignored: isIgnored });
      out.set(p, isIgnored);
    }
  }

  if (cache.size > 5_000) cache.clear();
  return out;
}
