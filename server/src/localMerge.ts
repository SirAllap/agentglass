/*
 * The only module that merges a launched plan's branch into the project's local base branch.
 * It never pushes: every git call is built from the closed list in ALLOWED and goes through
 * the one runner below, which refuses anything else (push, fetch, remote, pull, send-pack...).
 * It never stashes or resets, and it never fetches or checks out: the repo's HEAD must already
 * be the base. Hooks are switched off for the merge (a hook could push), and the answer says so.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The closed list: first word of the argv, and for `merge` / `config` / `diff` / `log` the flags allowed after it. */
const ALLOWED = new Set(["rev-parse", "symbolic-ref", "status", "merge", "merge-base", "diff", "log", "config"]);
const NEVER = new Set(["push", "fetch", "remote", "pull", "send-pack", "stash", "reset", "checkout", "switch", "commit"]);

export interface GitOut { code: number; stdout: string; stderr: string }
/** Throws for anything outside the closed list: a bug here must be loud, not a silent push. */
export function assertAllowed(args: readonly string[]): void {
  const verb = args[0] ?? "";
  if (NEVER.has(verb) || !ALLOWED.has(verb)) throw new Error(`localMerge: git ${verb || "(nothing)"} is not on the closed list`);
  if (verb === "config" && !(args[1] === "--get" && args.length === 3)) throw new Error("localMerge: config only reads (--get <key>)");
}

let emptyHooks: string | null = null;
const hooksDir = (): string => (emptyHooks ??= mkdtempSync(join(tmpdir(), "agx-nohooks-")));

/** Tests replace the spawn to record every argv; null is the real git. */
let spy: ((args: string[]) => void) | null = null;
export const __spyGit = (f: ((args: string[]) => void) | null) => { spy = f; };

/** The single runner. */
export function runGit(root: string, args: string[]): GitOut {
  assertAllowed(args);
  spy?.(args);
  const hooks = args[0] === "merge" ? ["-c", `core.hooksPath=${hooksDir()}`] : [];
  // loop-ok: one local merge per click, and its callers cannot await (see the SYNC note in no-direct-spawn.test.ts).
  const p = Bun.spawnSync(["git", "-c", "core.fsmonitor=false", "-c", "color.ui=never", ...hooks, "-C", root, ...args], {
    stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 120_000,
    env: { ...process.env, GIT_EDITOR: "true", GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no", LC_ALL: "C" },
  });
  return { code: p.exitCode ?? 1, stdout: p.stdout?.toString() ?? "", stderr: p.stderr?.toString() ?? "" };
}

export const mergeSubject = (branch: string, planId: string): string => `Merge ${branch} (flight plan ${planId})`;

/** Every argv this module can build, for the no-push test. */
export function vectors(base: string, branch: string, sha: string, planId: string): string[][] {
  return [
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], ["symbolic-ref", "--short", "HEAD"], ["status", "--porcelain", "--untracked-files=no"],
    ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], ["merge-base", "--is-ancestor", sha, `refs/heads/${base}`],
    ["diff", `refs/heads/${base}...${sha}`], ["diff", "--name-only", "--diff-filter=U"],
    ["log", "--merges", "--first-parent", "--format=%H%x00%s", `${sha}..refs/heads/${base}`],
    ["config", "--get", "commit.gpgsign"], ["config", "--get", "merge.verifySignatures"],
    ["merge", "--no-ff", "--no-edit", "-m", mergeSubject(branch, planId), sha], ["merge", "--abort"],
  ];
}

const one = (r: GitOut): string => r.stdout.trim();
export const tipOf = (root: string, branch: string): string | null => { const r = runGit(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]); return r.code === 0 && one(r) ? one(r) : null; };
export const isAncestor = (root: string, sha: string, ref: string): boolean => runGit(root, ["merge-base", "--is-ancestor", sha, ref]).code === 0;
export const checkedOut = (root: string): string | null => { const r = runGit(root, ["symbolic-ref", "--short", "HEAD"]); return r.code === 0 ? one(r) : null; };
export const mergeHeadPresent = (root: string): boolean => runGit(root, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).code === 0;
export const treeClean = (root: string): boolean => { const r = runGit(root, ["status", "--porcelain", "--untracked-files=no"]); return r.code === 0 && !one(r); };
export const signsCommits = (root: string): boolean => ["commit.gpgsign", "merge.verifySignatures"].some((k) => one(runGit(root, ["config", "--get", k])).toLowerCase() === "true");
export const reviewDiff = (root: string, base: string, sha: string): GitOut => runGit(root, ["diff", `refs/heads/${base}...${sha}`]);
/** The merge commit this verb made after `before`, found by its exact subject. */
export function findMergeCommit(root: string, base: string, before: string, subject: string): string | null {
  const r = runGit(root, ["log", "--merges", "--first-parent", "--format=%H%x00%s", `${before}..refs/heads/${base}`]);
  if (r.code !== 0) return null;
  for (const l of r.stdout.split("\n")) { const [h, s] = l.split("\0"); if (h && s === subject) return h; }
  return null;
}

const locks = new Set<string>();
export type MergeResult =
  | { ok: true; sha: string }
  | { ok: false; status: 409; error: string; reason: "merge-busy" | "half-merge" | "base-not-checked-out" | "dirty-tree" | "conflict" | "merge-failed" | "tip-moved" | "base-moved" | "signing-not-supported"; files?: string[] };

/** Runs the merge under the per-repo lock. `onBeforeGit` writes the intent row; it throws when it cannot, and then git does not run. */
export function mergeLocal(root: string, o: { base: string; branch: string; sha: string; reviewedBase?: string | null; planId: string; onBeforeGit: () => void}): MergeResult {
  if (locks.has(root)) return { ok: false, status: 409, reason: "merge-busy", error: "another merge is running in this repository: retry in a moment" };
  locks.add(root);
  try {
    const fail = (reason: Extract<MergeResult, { ok: false }>["reason"], error: string, files?: string[]): MergeResult => {
      return { ok: false, status: 409, reason, error, ...(files ? { files } : {}) }; };
    if (mergeHeadPresent(root)) return { ok: false, status: 409, reason: "half-merge", error: "A merge is half done in this repository: run `git merge --abort` there, then retry." };
    if (checkedOut(root) !== o.base) return { ok: false, status: 409, reason: "base-not-checked-out", error: `The repository's checked-out branch is not ${o.base}: the server never checks out. Check it out, then retry.` };
    if (!treeClean(root)) return { ok: false, status: 409, reason: "dirty-tree", error: "The base branch's working tree has uncommitted changes: clean it, then retry." };
    if (signsCommits(root)) return { ok: false, status: 409, reason: "signing-not-supported", error: "This repo signs commits, and the server cannot sign without a terminal: merge by hand." };
    if (tipOf(root, o.branch) !== o.sha) return { ok: false, status: 409, reason: "tip-moved", error: "The branch moved since it was reviewed: a new review is needed on the new tip." };
    const before = tipOf(root, o.base);
    if (o.reviewedBase && before !== o.reviewedBase) return fail("base-moved", "The base branch moved since the review: a new review of the diff is needed.");
    o.onBeforeGit();
    const r = runGit(root, ["merge", "--no-ff", "--no-edit", "-m", mergeSubject(o.branch, o.planId), o.sha]);
    if (r.code === 0) {
      const sha = one(runGit(root, ["rev-parse", "--verify", `refs/heads/${o.base}`]));
      return { ok: true, sha };
    }
    if (mergeHeadPresent(root)) {
      const files = one(runGit(root, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
      runGit(root, ["merge", "--abort"]);
      const clean = tipOf(root, o.base) === before && treeClean(root);
      return fail("conflict", clean ? `The merge conflicts in ${files.length} file(s) and was aborted; ${o.base} did not move.` : `The merge conflicted and the abort did not leave ${o.base} clean: look at the repository.`, files);
    }
    return fail("merge-failed", (r.stderr || r.stdout).split("\n").find((l) => l.trim())?.trim() ?? "git refused the merge");
  } finally { locks.delete(root); }
}
