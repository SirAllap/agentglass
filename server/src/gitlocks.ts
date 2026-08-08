// "Another git process seems to be running in this repository."
//
// The message everyone has seen, and the one that tells you nothing you can act
// on. Sometimes a git really is running and you should wait. More often nothing
// is: a process was killed mid-write, or an agent's tool call was interrupted,
// and a zero-byte `index.lock` is now the only thing standing between you and a
// commit. The two look identical from the message, and the fix for one is
// "wait" while the fix for the other is `rm`.
//
// WHY NOT `lslocks`. That is what the tool this was modelled on uses, and it
// was the obvious first move here too. Measured before writing any of this: 113
// locks on this machine, none of them git's. Git does not take a kernel lock —
// it creates a file and relies on `O_EXCL`, so the lock is the file's
// *existence*. `lslocks` cannot see it, `lsof` reports nobody holding it open,
// and the file itself is zero bytes with no pid inside. Nothing in the lock
// says who made it.
//
// So the holder has to be inferred from the other end: is there a live `git`
// working in this repository? If yes, the lock is doing its job. If no, the
// lock has outlived whatever made it, and that is the fact worth surfacing —
// it is the actionable half, and it is the half you cannot get from the error
// message.

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { ownedByMe, cwdOf } from "./machine.ts";

/** One lock file, and whether anything is behind it. */
export interface GitLock {
  /** The checkout it belongs to — a linked worktree in its own right, not the
   *  main repo it was made from. */
  repo: string;
  /** Just the file: `index.lock`, `HEAD.lock`, `refs/heads/main.lock`. */
  name: string;
  path: string;
  /** Seconds since it was written. The other half of the verdict: a lock two
   *  seconds old is a git that is mid-write even if the scan missed it. */
  ageSec: number;
  /** A live git working in this repo, if one was found. */
  heldBy: { pid: number; cmd: string } | null;
  /**
   * Nothing is holding it.
   *
   * Deliberately not phrased as "safe to delete", though that is usually what
   * it means. The scan can be wrong in one direction — a git that started
   * between the readdir and the /proc walk — which is why `ageSec` is reported
   * beside it rather than folded in.
   */
  stale: boolean;
}

export interface GitLocksReport {
  locks: GitLock[];
  /** How many checkouts were looked at, so an empty list reads as "nothing is
   *  locked" rather than "nothing was checked". */
  scanned: number;
  error?: string;
}

/**
 * The lock files git actually makes, by name.
 *
 * `index.lock` is the one that blocks people. The rest are here because they
 * block *different* commands and produce the same unhelpful message: a stale
 * `HEAD.lock` fails a checkout, `config.lock` fails `git config`, and a stale
 * ref lock fails exactly one branch update and nothing else.
 */
const FLAT_LOCKS = [
  "index.lock",
  "HEAD.lock",
  "config.lock",
  "shallow.lock",
  "packed-refs.lock",
  "ORIG_HEAD.lock",
  "MERGE_HEAD.lock",
];

/**
 * Where this checkout's git data really lives.
 *
 * `.git` is a directory in a normal clone and a *file* in a linked worktree,
 * holding `gitdir: /path/to/main/.git/worktrees/<name>`. That distinction is
 * the whole correctness of this module: a linked worktree has its own index,
 * and therefore its own `index.lock`, in that directory — looking in the main
 * repo's `.git` would report one worktree's lock against every other one, and
 * miss the one that is actually stuck.
 */
export function gitDirOf(root: string): string | null {
  const dot = join(root, ".git");
  try {
    const st = statSync(dot);
    if (st.isDirectory()) return dot;
    if (!st.isFile()) return null;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"));
    if (!m) return null;
    // Relative gitdir pointers are legal and `git worktree` writes absolute
    // ones, but a repo moved by hand can hold either.
    const target = resolve(root, m[1]!.trim());
    return existsSync(target) ? target : null;
  } catch {
    return null;
  }
}

/**
 * The git directory shared by a repository and all of its linked worktrees.
 *
 * A linked worktree's own git directory holds a `commondir` pointing back at
 * the main one — usually the relative `../..`. The main repo has no `commondir`
 * and is already the common one.
 */
function commonDirOf(gitDir: string): string {
  try {
    const rel = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    return rel ? resolve(gitDir, rel) : gitDir;
  } catch {
    return gitDir;
  }
}

/**
 * Every checkout of every repository we were told about.
 *
 * The reason this exists: the scan was handed `knownProjects()`, which is built
 * from telemetry — the directories agents have actually worked in. On this
 * machine that was two, while the repository had six linked worktrees
 * registered. A panel that finds stuck locks in a third of your checkouts is
 * worse than useless, because an empty list reads as "nothing is stuck".
 *
 * Git keeps the registry on disk, so no `git` is run here either: every
 * worktree has a directory under `<common>/worktrees/<name>/`, and the `gitdir`
 * file in it holds the path to that checkout's own `.git`. One readdir and a
 * read per worktree, which is what keeps this safe to poll.
 *
 * Reached from ANY checkout, not just the main one — an agent may only ever
 * have worked in a worktree, and `commondir` is the way back to its siblings.
 * A registry entry whose checkout has been deleted is dropped: `git worktree
 * prune` has not been run yet, and a lock in a directory that is gone is not a
 * thing anybody can act on.
 */
export function allCheckouts(roots: string[]): string[] {
  const out = new Set<string>();
  for (const rootIn of roots) {
    const root = resolve(rootIn);
    const gitDir = gitDirOf(root);
    if (!gitDir) continue;
    out.add(root);

    const common = commonDirOf(gitDir);
    // `<repo>/.git` → `<repo>`. Guarded, because a bare repo has no checkout
    // above it and would otherwise contribute its parent directory.
    const main = dirname(common);
    if (gitDirOf(main)) out.add(main);

    let names: string[];
    try { names = readdirSync(join(common, "worktrees")); } catch { continue; }
    for (const name of names) {
      try {
        const dotGit = readFileSync(join(common, "worktrees", name, "gitdir"), "utf8").trim();
        if (!dotGit) continue;
        const wt = dirname(dotGit);
        if (existsSync(wt)) out.add(wt);
      } catch { /* half-written or pruned mid-read */ }
    }
  }
  return [...out];
}

/** Ref locks — `refs/heads/main.lock` and friends. Walked with a depth cap
 *  because a repo with ten thousand refs should not turn a 2.5s poll into a
 *  filesystem crawl, and a lock nested five deep is not a real shape. */
function refLocks(gitDir: string, max = 4): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > max || out.length >= 40) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r, depth + 1);
      else if (e.name.endsWith(".lock")) out.push({ name: `refs/${r}`, path: p });
    }
  };
  walk(join(gitDir, "refs"), "", 0);
  return out;
}

/**
 * Is a live `git` working in `root`?
 *
 * Two ways a git names the repo it is in: its working directory, and `-C
 * <path>` on the command line. Both are checked because agents overwhelmingly
 * use the second — a tool call runs `git -C /some/worktree status` from
 * wherever the shell happens to be, so matching on cwd alone would call every
 * agent-held lock stale, which is the one answer that must never be wrong.
 *
 * Only this user's processes: /proc will not describe anybody else's, and a
 * lock held by another account is not one to reason about.
 */
function holderOf(root: string, procs: { pid: number; comm: string; cmd: string; cwd: string | null }[]): { pid: number; cmd: string } | null {
  const inside = (p: string | null) => !!p && (p === root || p.startsWith(root + sep));
  for (const p of procs) {
    // `git-remote-https`, `git-upload-pack` and the rest are all git holding
    // the same locks.
    if (!p.comm.startsWith("git")) continue;
    if (inside(p.cwd) || p.cmd.includes(root)) return { pid: p.pid, cmd: p.cmd };
  }
  return null;
}

/** Every git this user is running right now, read once for the whole sweep
 *  rather than once per repository. */
function liveGits(): { pid: number; comm: string; cmd: string; cwd: string | null }[] {
  const out: { pid: number; comm: string; cmd: string; cwd: string | null }[] = [];
  let entries: string[];
  try { entries = readdirSync("/proc"); } catch { return out; }
  for (const e of entries) {
    const pid = Number(e);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    let comm: string;
    try { comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch { continue; }
    if (!comm.startsWith("git")) continue;
    if (!ownedByMe(pid)) continue;
    let cmd = "";
    try { cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ").slice(0, 200); } catch { /* raced */ }
    out.push({ pid, comm, cmd, cwd: cwdOf(pid) });
  }
  return out;
}

/**
 * Look for lock files across the checkouts we know about.
 *
 * Cheap on purpose: a handful of `stat` calls per repository and one /proc walk
 * for the whole sweep. No `git` is run — this has to be safe to poll, and
 * shelling out to git in a repository that is already locked is how a status
 * panel becomes the thing that hangs.
 */
export function gitLocks(rootsIn: string[]): GitLocksReport {
  // Expanded here rather than by the caller: every caller wants every checkout,
  // and a route that has to remember to widen its own input is a route that
  // will forget. See allCheckouts for what the un-widened list cost.
  const roots = allCheckouts(rootsIn);
  const seen = new Set<string>();
  const locks: GitLock[] = [];
  const now = Date.now();
  // Read once, not per repo: on a machine with a dozen worktrees this is the
  // difference between one /proc walk and twelve.
  const gits = liveGits();
  let scanned = 0;

  for (const rootIn of roots) {
    const root = resolve(rootIn);
    if (seen.has(root)) continue;
    seen.add(root);
    const gitDir = gitDirOf(root);
    if (!gitDir) continue;
    scanned++;

    const candidates = [
      ...FLAT_LOCKS.map((name) => ({ name, path: join(gitDir, name) })),
      ...refLocks(gitDir),
    ];
    for (const c of candidates) {
      let mtimeMs: number;
      try { mtimeMs = statSync(c.path).mtimeMs; } catch { continue; }
      const heldBy = holderOf(root, gits);
      locks.push({
        repo: root,
        name: c.name,
        path: c.path,
        ageSec: Math.max(0, Math.round((now - mtimeMs) / 1000)),
        heldBy,
        stale: heldBy === null,
      });
    }
  }

  // Stale first, then oldest: the list is read looking for something stuck, and
  // a lock a git is legitimately holding is not what anybody came for.
  locks.sort((a, b) => Number(b.stale) - Number(a.stale) || b.ageSec - a.ageSec);
  return { locks, scanned };
}

/**
 * Delete a lock nothing is holding.
 *
 * The whole point of finding these, and the one write this module has. Every
 * check is redone here rather than trusted from the caller: the list the panel
 * is looking at is up to a poll interval old, and in that window a real git can
 * have taken the lock. A stale verdict from two seconds ago is not permission
 * to delete a file another process is depending on right now.
 *
 * Membership is proven by re-running the scan rather than by testing the path
 * against each root, and that is not a shortcut — it is the fix for a bug this
 * had. A linked worktree's git directory lives INSIDE the main repo's:
 * `…/agentglass/.git/worktrees/agentglass-anc`. So a prefix test against the
 * main checkout matches every worktree's lock, the wrong repo wins the search,
 * and the lock is looked for where it is not. Measured on a real worktree: the
 * scan found the lock and attributed it correctly while the delete answered
 * "there is no lock there any more" about a file that was plainly still there.
 *
 * `gitLocks` already resolves each checkout's own git directory and attributes
 * locks to the right one. Asking it is both the containment check and the
 * staleness check, and there is no second copy of the rule to drift.
 *
 * A whole-sweep scan for one delete is more work than a prefix test. It is a
 * button press, not a poll.
 */
export function removeStaleLock(pathIn: unknown, roots: string[]): { ok: boolean; error?: string; detail?: string } {
  if (typeof pathIn !== "string" || !pathIn) return { ok: false, error: "no path" };
  const target = resolve(pathIn);
  if (!target.endsWith(".lock")) return { ok: false, error: "not a lock file" };

  const found = gitLocks(roots).locks.find((l) => l.path === target);
  if (!found) return { ok: false, error: "that is not a lock in a checkout agentglass knows about" };
  if (!found.stale) {
    return { ok: false, error: `git is still working in this repo (pid ${found.heldBy?.pid}) — this lock is doing its job` };
  }

  try {
    rmSync(target);
    return { ok: true, detail: `removed ${found.name}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
