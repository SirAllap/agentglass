// The one door by which a sandboxed worker moves a branch.
//
// The worker's sandbox shuts the common git dir's `refs`, `logs` and
// `packed-refs` (a bind cannot open one ref file plus its `.lock` without
// opening `refs/heads`, which would let a worker move `main` or delete another
// branch). It can still stage (its own gitdir holds the index) and write
// objects. This runs OUTSIDE the sandbox, on the server, and does the one ref
// move a commit needs: the branch this worktree has checked out, nothing the
// caller names. No hook runs: `commit-tree` and `update-ref` are plumbing.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { runChild, type ChildOut } from "./broker/brokerRun.ts";

export type OwnCommit = { ok: true; branch: string; sha: string } | { ok: false; error: string };

const RULE = "A worker may move only the branch its own worktree has checked out";
// Through the spawn broker and awaited: these ran as ~10 sync git calls per
// commit and ~5 per worker start on the server's one thread, unlabelled, and
// each fork of the ~1 GB server froze every terminal (kernel_clone, do_wait).
const git = (cwd: string, args: string[]): Promise<ChildOut> => runChild(["git", ...args], { cwd, timeoutMs: 30_000 });
const out = (r: ChildOut) => (r.code === 0 ? r.stdout.trim() : null);

/** What the server wrote down when it first started a worker in a folder: the folder and the branch it was on. */
export type WorkerRecord = { cwd: string; branch: string };
/** Keyed by worktree path, written once (first start wins): a worker can rewrite its own HEAD, so a later start must never re-read it. */
const byPath = new Map<string, WorkerRecord>();
/** The one key for a worktree: its real path, so a symlinked path and the real one are the same record. A gone folder keeps its resolved path. */
const keyOf = (cwd: string): string => { try { return realpathSync(resolve(cwd)); } catch { return resolve(cwd); } };
const pathOf = new Map<string, string>();

/**
 * Called by the server when it STARTS a worker, before the worker runs. The
 * first start in a worktree reads HEAD and keeps the branch in the server's
 * memory; a later start (a reused name or folder) never overwrites it, so
 * nothing the worker can write is ever read as the target afterwards. The
 * record goes only when the worktree is removed (`forgetWorktreeBranch`) or
 * its branch no longer exists. A detached HEAD, main/master, or a branch
 * checked out in another worktree records nothing: that worker's commit is refused.
 */
export async function recordWorkerBranch(name: string, cwd: string): Promise<WorkerRecord | null> {
  const root = keyOf(cwd);
  const had = byPath.get(root);
  if (had && out(await git(root, ["rev-parse", "-q", "--verify", `refs/heads/${had.branch}`]))) { pathOf.set(name, root); return had; }
  byPath.delete(root);
  pathOf.delete(name);
  const branch = out(await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]));
  if (!branch) return null;
  const main = out(await git(root, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]))?.replace(/^origin\//, "");
  if (branch === "main" || branch === "master" || branch === main) return null;
  const others = (out(await git(root, ["worktree", "list", "--porcelain"])) ?? "").split("\n\n")
    .filter((blk) => blk.includes(`branch refs/heads/${branch}`) && !blk.startsWith(`worktree ${root}\n`));
  if (others.length) return null;
  const rec = { cwd: root, branch };
  byPath.set(root, rec);
  pathOf.set(name, root);
  return rec;
}
export const recordedWorker = (name: string): WorkerRecord | undefined => { const p = pathOf.get(name); return p ? byPath.get(p) : undefined; };
/** Drop the record of a worktree that is being removed (not on a stop: a resumed worker keeps committing). */
export const forgetWorktreeBranch = (cwd: string): void => { byPath.delete(keyOf(cwd)); };

/** Test seam: runs after the tree is written and committed, before the index is checked again and the ref moves. */
export const __between: { run: (() => void | Promise<void>) | null } = { run: null };

/** The tail of each worktree's commit queue: one commit at a time per worktree, so two calls never read the same old tip. */
const committing = new Map<string, Promise<unknown>>();

/** Commits the index of the linked worktree at `cwd` onto `recorded.branch`, the branch the server recorded at start. */
export function commitOwnBranch(cwd: string, message: string, recorded: string): Promise<OwnCommit> {
  const root = keyOf(cwd);
  const run = (committing.get(root) ?? Promise.resolve()).then(() => commitOnce(root, message, recorded));
  const tail = run.catch(() => undefined).finally(() => { if (committing.get(root) === tail) committing.delete(root); });
  committing.set(root, tail);
  return run;
}

async function commitOnce(root: string, message: string, recorded: string): Promise<OwnCommit> {
  const msg = message.trim();
  if (!msg) return { ok: false, error: "refused: a commit needs a message" };
  const gitdir = out(await git(root, ["rev-parse", "--absolute-git-dir"]));
  const common = out(await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  if (!gitdir || !common) return { ok: false, error: "refused: not a git worktree" };
  if (gitdir === common) return { ok: false, error: `refused: ${RULE}, and this is the main checkout, not a linked worktree` };
  const branch = out(await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]));
  if (!branch) return { ok: false, error: `refused: ${RULE}, and HEAD here is detached; this worker was started on ${recorded}` };
  // HEAD is in the worker's own gitdir, which it can write: it is only checked
  // against the server's record, never trusted as the target.
  if (branch !== recorded) return { ok: false, error: `refused: ${RULE}; this worker was started on ${recorded}, and HEAD here names ${branch}` };
  const main = out(await git(root, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]))?.replace(/^origin\//, "");
  if (branch === "main" || branch === "master" || branch === main) {
    return { ok: false, error: `refused: ${RULE}, and ${branch} is the main branch` };
  }
  // Another worktree on this branch would make it that worker's, not this one's.
  const others = (out(await git(root, ["worktree", "list", "--porcelain"])) ?? "").split("\n\n")
    .filter((b) => b.includes(`branch refs/heads/${branch}`) && !b.startsWith(`worktree ${root}\n`));
  if (others.length) return { ok: false, error: `refused: ${RULE}, and ${branch} is checked out in another worktree too` };
  const old = out(await git(root, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`]));
  const tree = out(await git(root, ["write-tree"]));
  if (!tree) return { ok: false, error: "refused: the index could not be written as a tree" };
  if (old && out(await git(root, ["rev-parse", `${old}^{tree}`])) === tree) return { ok: false, error: "nothing to commit: the index equals the branch" };
  const made = await git(root, ["commit-tree", tree, ...(old ? ["-p", old] : []), "-m", msg]);
  const sha = out(made);
  if (!sha) return { ok: false, error: `commit-tree failed: ${made.stderr.trim().slice(0, 200)}` };
  await __between.run?.();
  // The worker can `git add` while this runs (it owns its index, the lock only
  // orders server calls): a commit that no longer matches the index is refused.
  if (out(await git(root, ["write-tree"])) !== tree) return { ok: false, error: "refused: the index changed while committing; stage again and retry" };
  // The old value is the guard: a branch that moved meanwhile is not overwritten.
  const moved = await git(root, ["update-ref", "-m", `commit: ${msg.split("\n")[0]}`, `refs/heads/${branch}`, sha, ...(old ? [old] : [""])]);
  if (moved.code !== 0) return { ok: false, error: `update-ref failed: ${moved.stderr.trim().slice(0, 200)}` };
  return { ok: true, branch, sha };
}

/**
 * The door's caller check. The folder is never the caller's to name: it is the
 * cwd and branch the server recorded for the worker its credential was minted for, so a
 * worker that posts another worker's folder commits nothing there. No worker
 * credential (a bare loopback call) is refused.
 */
export async function commitForWorker(caller: { principal?: string; worker?: string } | null | undefined, message: string, recordOf: (worker: string) => WorkerRecord | undefined): Promise<OwnCommit> {
  if (caller?.principal !== "worker" || !caller.worker) return { ok: false, error: `refused: ${RULE}; this door answers only a worker's own credential` };
  const rec = recordOf(caller.worker);
  if (!rec) return { ok: false, error: `refused: ${RULE}; no worktree and branch is recorded for worker ${caller.worker}` };
  return commitOwnBranch(rec.cwd, message, rec.branch);
}
