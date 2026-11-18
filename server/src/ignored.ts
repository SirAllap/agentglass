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

import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { brokerExec } from "./broker/brokerHost.ts";
import { withSpawnSlot } from "./spawnpool.ts";

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

const CHECK_MS = 5_000;
const CHECK_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" } as Record<string, string>;

/**
 * `git check-ignore --stdin` for one repo; the ignored paths, or null when git
 * did not answer 0 (not a repo, git missing, timed out).
 *
 * This was a spawnSync on the only thread, run for every repo in the polled
 * /changes list each time its 15 s cache lapsed: a slow fork (page tables of a
 * ~1 GB process under memory pressure, measured at 2.4 s) froze the terminal
 * with it. Now the spawn broker forks it, and the wait is an await.
 */
async function checkIgnore(root: string, input: string): Promise<string | null> {
  const argv = ["git", "-C", root, "check-ignore", "--stdin"];
  const via = brokerExec({ argv, env: CHECK_ENV, timeoutMs: CHECK_MS, stdin: input, maxBytes: 8 * 1024 * 1024, read: true });
  if (via) {
    const a = await via.done;
    if (!a.lost && !a.truncated && a.code === 0) return a.stdout;
    if (!a.lost && !a.truncated) return null;
    // lost or cut: a read, so asking again in-process is safe
  }
  return withSpawnSlot(async () => {
    try {
      const proc = Bun.spawn(argv, { stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "ignore", timeout: CHECK_MS, env: CHECK_ENV });
      const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return code === 0 ? text : null;
    } catch { return null; }
  });
}

/**
 * Mark each path as ignored or not.
 *
 * Cached briefly: the changes list is polled, and .gitignore does not move on
 * that timescale. A path we cannot place in a repo is reported as not ignored —
 * "we don't know" must not hide something from you.
 */
export async function markIgnored(paths: string[]): Promise<Map<string, boolean>> {
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
      const hit = await checkIgnore(root, list.join("\n"));
      if (hit) ignored = new Set(hit.split("\n").filter(Boolean));
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
