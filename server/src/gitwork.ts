// Live git working-tree adapter — the backend for agentglass's lazygit-style
// Source Control panel. Everything reads the repo on disk RIGHT NOW (never the
// telemetry snapshot). All git calls are arg-array spawns scoped with `-C root`
// (never a shell string); paths are validated to stay inside the repo root; and
// every mutating op is gated by AGENTGLASS_GIT_WRITE_DISABLED=1.

import { resolve, basename, relative, dirname, sep, join } from "node:path";
import { statSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { git, gitAsync, safeAbs, repoRootOf, currentBranch } from "./git.ts";
import { configuredRepoDirs, workspaceRoot, inScope } from "./config.ts";
import { worktreeParent, gitDir } from "./worktree.ts";
import { entered, backoff } from "./loopwatch.ts";
import type {
  ConflictBlock, BlockChoice,
  GitFileChange, GitBranchInfo, WorkingTree, GitRepoRef, GitActionResult, DiffHunk, GitFileStatus,
  GitBranch, GitCommit, GitStash, GitWorktree, GitGraphLine, GitTreeState,
  GitRemote, GitRemoteBranch, GitTag, GitReflogEntry, WorktreeLeftovers, LeftoverEntry, BlockedByOwner,
} from "../../shared/types.ts";

export const GIT_WRITE_ENABLED = process.env.AGENTGLASS_GIT_WRITE_DISABLED !== "1";
const UNTRACKED_MAX_BYTES = 512 * 1024; // don't inline-diff huge new files

/**
 * Validate that `root` is the top-level of a git repo; return the abs root.
 *
 * Cached, because this is the first line of nearly every function in this file
 * and it costs a subprocess: on a panel poll it ran a dozen times a second to
 * re-derive an answer that changes only if someone moves a directory. A repo's
 * top level does not move under a running app; a *miss* is not cached, so a
 * path that becomes a repo later is picked up.
 */
const ROOT_TTL_MS = 60_000;
const rootCache = new Map<string, { at: number; top: string }>();

function repoRoot(root: unknown): string | null {
  const abs = safeAbs(root);
  if (!abs) return null;
  const hit = rootCache.get(abs);
  if (hit && Date.now() - hit.at < ROOT_TTL_MS) return hit.top;
  const top = git(abs, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return null;
  const t = top.stdout.trim();
  if (!t) return null;
  if (rootCache.size > 200) rootCache.clear();
  rootCache.set(abs, { at: Date.now(), top: t });
  return t;
}

/** Resolve a repo-relative path and reject anything escaping the root. */
function inRepo(root: string, rel: string): string | null {
  if (typeof rel !== "string" || !rel || rel.includes("\0")) return null;
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

// Strip a/ b/ prefixes, /dev/null, and C-style git quoting from a diff path.
function pathFrom(s: string): string {
  s = s.trim().replace(/\t.*$/, "");
  if (s === "/dev/null") return "/dev/null";
  if (s.startsWith('"') && s.endsWith('"')) { try { s = JSON.parse(s); } catch { /* keep raw */ } }
  if (s.startsWith("a/") || s.startsWith("b/")) s = s.slice(2);
  return s;
}

/** Parse `git diff` / `git diff --cached` output into FileChange-shaped hunks. */
function parseDiff(root: string, text: string, staged: boolean): GitFileChange[] {
  const out: GitFileChange[] = [];
  const lines = text.split("\n");
  // `git diff` ends with a trailing "\n" → a phantom empty element that would
  // otherwise be pushed as a spurious blank context line on the last hunk.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const now = Date.now();
  let i = 0, id = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("diff --git ")) { i++; continue; }
    const header = lines[i];
    i++;
    let oldPath: string | null = null, newPath: string | null = null, binary = false;
    let status: GitFileStatus["status"] = "modified";
    const hunks: DiffHunk[] = [];
    let additions = 0, deletions = 0;
    // meta lines up to the first hunk / next file
    while (i < lines.length && !lines[i].startsWith("diff --git ") && !lines[i].startsWith("@@")) {
      const ln = lines[i];
      if (ln.startsWith("--- ")) oldPath = pathFrom(ln.slice(4));
      else if (ln.startsWith("+++ ")) newPath = pathFrom(ln.slice(4));
      else if (ln.startsWith("new file")) status = "added";
      else if (ln.startsWith("deleted file")) status = "deleted";
      else if (ln.startsWith("rename from ")) { status = "renamed"; oldPath = ln.slice(12).trim(); }
      else if (ln.startsWith("rename to ")) newPath = ln.slice(10).trim();
      else if (ln.startsWith("Binary files")) binary = true;
      i++;
    }
    // hunks
    while (i < lines.length && lines[i].startsWith("@@")) {
      const m = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      i++;
      if (!m) continue;
      const hunk: DiffHunk = { oldStart: +m[1], oldLines: m[2] ? +m[2] : 1, newStart: +m[3], newLines: m[4] ? +m[4] : 1, lines: [] };
      while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("diff --git ")) {
        const l = lines[i];
        if (l.startsWith("\\")) { i++; continue; } // "\ No newline at end of file"
        if (l[0] === "+") additions++;
        else if (l[0] === "-") deletions++;
        hunk.lines.push(l.length ? l : " ");
        i++;
      }
      hunks.push(hunk);
    }
    if (newPath === "/dev/null") status = "deleted";
    if (oldPath === "/dev/null") status = "added";
    const relNew = newPath && newPath !== "/dev/null" ? newPath : null;
    const relOld = oldPath && oldPath !== "/dev/null" ? oldPath : null;
    let rel = relNew ?? relOld ?? "";
    // Binary files carry no ---/+++ lines; recover the path from the header.
    if (!rel) { const hm = header.match(/ b\/(.+)$/); if (hm) rel = pathFrom("b/" + hm[1]); }
    out.push({
      id: id++, timestamp: now, source_app: "git", session_id: staged ? "staged" : "unstaged", tool: "git",
      file_path: rel ? resolve(root, rel) : rel, additions, deletions, hunks,
      status, staged, binary,
      oldPath: relOld && relOld !== rel ? resolve(root, relOld) : undefined,
    });
  }
  return out;
}

/** Build all-added GitFileChange entries for untracked files. */
async function untracked(root: string): Promise<GitFileChange[]> {
  const r = await gitAsync(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (r.code !== 0) return [];
  const now = Date.now();
  const out: GitFileChange[] = [];
  let id = 10000;
  for (const rel of r.stdout.split("\0")) {
    if (!rel) continue;
    const abs = resolve(root, rel);
    let binary = false, content = "";
    try {
      if (statSync(abs).size > UNTRACKED_MAX_BYTES) binary = true;
      else content = readFileSync(abs, "utf8");
    } catch { continue; }
    if (!binary && content.includes("\0")) binary = true;
    const arr = binary ? [] : content.split("\n");
    if (arr.length && arr[arr.length - 1] === "") arr.pop();
    const hunk: DiffHunk = { oldStart: 0, oldLines: 0, newStart: 1, newLines: arr.length, lines: arr.map((l) => "+" + l) };
    out.push({
      id: id++, timestamp: now, source_app: "git", session_id: "unstaged", tool: "git",
      file_path: abs, additions: arr.length, deletions: 0, hunks: binary ? [] : [hunk],
      status: "untracked", staged: false, binary,
    });
  }
  return out;
}

/**
 * What git is in the middle of, if anything.
 *
 * A repo mid-rebase behaves differently from a clean one — half the commit
 * operations are unavailable and the useful action is continue/abort/skip — so
 * the header has to say so rather than showing a branch name as if nothing were
 * happening. Probing `.git` is how git itself decides, and it costs one stat
 * per state instead of a subprocess.
 *
 * A linked worktree's `.git` is a *file* pointing at the real dir, and these
 * state files live in the per-worktree dir rather than the shared one — so this
 * resolves through gitDir() rather than assuming `<root>/.git`.
 */
function treeState(root: string): GitTreeState {
  const dir = gitDir(root);
  if (!dir) return "clean";
  if (existsSync(join(dir, "rebase-merge")) || existsSync(join(dir, "rebase-apply"))) return "rebasing";
  if (existsSync(join(dir, "MERGE_HEAD"))) return "merging";
  if (existsSync(join(dir, "CHERRY_PICK_HEAD"))) return "cherry-picking";
  if (existsSync(join(dir, "REVERT_HEAD"))) return "reverting";
  if (existsSync(join(dir, "BISECT_LOG"))) return "bisecting";
  return "clean";
}

async function branchInfo(root: string): Promise<GitBranchInfo> {
  const name = currentBranch(root);
  const detached = name === "(detached)";
  const upstream = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).stdout.trim() || null;
  let ahead = 0, behind = 0;
  if (upstream) {
    const c = git(root, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]).stdout.trim().split(/\s+/);
    behind = Number(c[0]) || 0;
    ahead = Number(c[1]) || 0;
  }
  // What this branch was cut from, and how far it has drifted — the header's
  // "sync" affordance. Cheap and cached; nothing here is per-branch fan-out.
  const base = detached ? null : await baseOf(root, name);
  return {
    name, upstream, ahead, behind, detached, state: treeState(root),
    base,
    behindBase: base ? await behindBase(root, name, base) : 0,
    // Two rev-parses, so only when the answer can change a decision: the
    // panel asks it to decide whether being behind upstream is a reason to
    // refuse a base merge, and that question only exists while behind.
    upstreamIsBase: upstream && base && behind > 0 ? sameBranch(root, upstream, base) : undefined,
    canUndoMerge: undoableMerge(root, ahead, upstream),
  };
}

/** Full working-tree state for one repo. */
export async function workingTree(rootIn: unknown): Promise<WorkingTree> {
  const root = repoRoot(rootIn);
  if (!root) {
    return { root: String(rootIn ?? ""), branch: { name: "", upstream: null, ahead: 0, behind: 0, detached: false }, staged: [], unstaged: [], clean: true, writeEnabled: GIT_WRITE_ENABLED, error: "not a git repository" };
  }
  // The four reads this is made of, run together rather than one after another
  // — and awaited, so the 618ms this measured at is wall clock instead of a
  // terminal that has stopped echoing. It is on a 2.5s poll whenever the panel
  // is open.
  const [stagedOut, unstagedOut, others, branch] = await Promise.all([
    gitAsync(root, ["-c", "core.quotePath=false", "diff", "--cached"]),
    gitAsync(root, ["-c", "core.quotePath=false", "diff"]),
    untracked(root),
    branchInfo(root),
  ]);
  const staged = parseDiff(root, stagedOut.stdout, true);
  const unstaged = [...parseDiff(root, unstagedOut.stdout, false), ...others];
  return {
    root, branch, staged, unstaged,
    clean: staged.length === 0 && unstaged.length === 0,
    writeEnabled: GIT_WRITE_ENABLED,
  };
}

/** How deep to look for repos below a configured root. Projects are commonly
 *  grouped a level or two down (`code/current_project/alavera_app`), and going
 *  deeper mostly finds vendored checkouts. */
const REPO_SCAN_DEPTH = (() => {
  // Number("abc") is NaN, and NaN <= 0 is false, so a garbage env var made the
  // recursion bottomless. Fall back to the default and cap the ceiling.
  const d = Number(process.env.AGENTGLASS_REPO_DEPTH);
  return Number.isFinite(d) ? Math.max(1, Math.min(8, d)) : 4;
})();

/** Directories that never hold a project worth listing — package caches,
 *  dependency trees and build output, all of which contain git checkouts.
 *  (Exported: the terminal's command scan skips the same trees.) */
export const SKIP_DIRS = new Set([
  "node_modules", "vendor", "target", "dist", "build", "Build",
  ".worktrees", ".venv", "venv", "__pycache__", "site-packages",
]);

/** A CI runner keeps its own checkout of the repo it builds — often one per
 *  runner instance. They're the same project, cloned N times, and would crowd
 *  out everything else in the picker. */
const skipped = (name: string) =>
  name.startsWith(".") || SKIP_DIRS.has(name) || name.startsWith("actions-runner") || name === "_work";

/**
 * Git repos at or below a base directory (cheap: an fs stat of `<dir>/.git`,
 * no subprocess per candidate).
 *
 * Descent stops as soon as a repo is found: a checkout vendored inside another
 * (`skia/buildtools`, `ladybird/Build/vcpkg`) is part of its parent, not a
 * project of its own, and listing it would bury the real ones. Hidden
 * directories are skipped too — `~/.tmux/plugins`, `~/.cache/yay` and friends
 * are full of clones nobody thinks of as their projects.
 */
function reposUnder(baseDir: string, depth = REPO_SCAN_DEPTH): string[] {
  const out: string[] = [];
  // The base may itself be a repo — pointing the setting straight at one
  // project is the obvious thing to try, and only looking at its children
  // returned nothing at all.
  try {
    statSync(resolve(baseDir, ".git"));
    return [baseDir];
  } catch { /* a container directory: walk it */ }
  const walk = (dir: string, left: number) => {
    try {
      statSync(resolve(dir, ".git"));
      out.push(dir);
      return; // a repo owns everything under it
    } catch { /* keep looking below */ }
    if (left <= 0) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      if (skipped(ent.name)) continue;
      walk(resolve(dir, ent.name), left - 1);
    }
  };
  try {
    for (const ent of readdirSync(baseDir, { withFileTypes: true })) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      if (skipped(ent.name)) continue;
      walk(resolve(baseDir, ent.name), depth - 1);
    }
  } catch { /* unreadable base dir */ }
  return out;
}

/**
 * The directories a user keeps code in, inferred from where their projects
 * already live.
 *
 * Only the parent of a known project counts, and only when it's specific
 * enough to be somebody's code folder: sweeping `/`, `/home` or `/mnt` would
 * walk other users and whole mounted disks for no benefit. A project sitting
 * directly in one of those (a home directory that is itself a repo) still gets
 * listed on its own — it just doesn't drag its neighbours in.
 */
/**
 * Where code tends to live, for an install that has nothing else to go on.
 *
 * Every other source of roots describes a machine that has already been used:
 * the cwd the app was launched from (a shortcut, so not a repo), projects the
 * transcript scan found (no sessions yet), the parents of those projects, repos
 * seen in telemetry (no events yet), and configured directories (unset). On a
 * fresh install all five are empty, so the picker offered "Whole machine" and
 * nothing else — which reads as discovery being broken, when it is discovery
 * working exactly as written.
 *
 * The list is short and conventional on purpose. This is a guess, and a guess
 * that walks somewhere surprising is worse than no guess at all: each of these
 * is a directory whose name says "my code is in here", and one `readdir` is the
 * whole cost of trying. Anything more exotic is what `repoDirs` is for, which
 * the empty state now names.
 */
const CODE_HOMES = ["code", "src", "projects", "dev", "repos", "workspace", "Developer", "Documents/GitHub"];

export function firstRunRoots(): string[] {
  // `$HOME` first, `homedir()` behind it. On POSIX the variable is the user's
  // own statement about where their home is, and honouring it is also what
  // makes this testable against a fixture rather than against the machine the
  // test happens to run on.
  const home = process.env.HOME || homedir();
  const out: string[] = [];
  for (const name of CODE_HOMES) {
    const dir = resolve(home, name);
    try { if (statSync(dir).isDirectory()) out.push(dir); } catch { /* not on this machine */ }
  }
  return out;
}

function codeRootsOf(knownRoots: string[]): string[] {
  const TOO_BROAD = new Set(["/", "/home", "/mnt", "/media", "/run", "/usr", "/opt", "/var", "/tmp", "/etc", "/srv"]);
  const out = new Set<string>();
  for (const r of knownRoots) {
    const abs = safeAbs(r);
    if (!abs) continue;
    const parent = dirname(abs);
    if (TOO_BROAD.has(parent) || parent === abs) continue;
    out.add(parent);
  }
  return [...out];
}

/** Repos agentglass offers in the panel: the server's own repo, its sibling
 *  repos (e.g. everything under ~/code), every project the transcript scan
 *  found, any repo seen in recent telemetry, and env-configured extras
 *  (AGENTGLASS_REPOS=path1:path2, AGENTGLASS_REPO_DIRS=dir1:dir2).
 *
 *  `knownRoots` are already-resolved project roots, so they're added directly.
 *  They matter because the panel would otherwise only reach repos that sit next
 *  to agentglass itself or produced a parseable diff — a project on another
 *  disk entirely would never show up. */
/** Branch + dirty count for one repo, in a single git call. `--branch` prepends
 *  a `##` header naming the branch, so asking separately would double the
 *  process count for data already in hand — including ahead/behind, which the
 *  same header already carries as "[ahead 1, behind 2]". Reading it here is
 *  free; computing it with rev-list would be one more subprocess per repo, and
 *  this runs for every repo in the sweep.
 *
 *  Both counts are only as fresh as the last fetch — they compare against the
 *  local origin/* refs, not the remote. See startAutoFetch(). */
/**
 * When work last landed on each checkout's branch, cached hard.
 *
 * The dirty count next to it has to be fresh — it changes as you edit — but a
 * commit date does not: it moves when you commit, and `run()` clears this the
 * moment anything writes. Measured without the cache on a repo with eighteen
 * checkouts, `/git/repos` spawned 36 processes and burned 4.1 seconds of CPU
 * every five seconds, half of it re-asking eighteen branches for a date that
 * had not changed since the last time. While the user was typing in a terminal
 * this same process serves.
 */
const TIP_TTL_MS = 60_000;
const tipCache = new Map<string, { at: number; ms: number }>();

async function tipDate(root: string): Promise<number> {
  const hit = tipCache.get(root);
  if (hit && Date.now() - hit.at < TIP_TTL_MS) return hit.ms;
  const r = await gitAsync(root, ["log", "-1", "--format=%ct", "HEAD"]);
  const ms = r.code === 0 ? (Number(r.stdout.trim()) || 0) * 1000 : 0;
  if (tipCache.size > 400) tipCache.clear();
  tipCache.set(root, { at: Date.now(), ms });
  return ms;
}

async function repoRef(root: string): Promise<GitRepoRef | null> {
  // Two questions, asked at once: what is dirty here (fresh every time), and
  // when work last landed on this branch (cached — see tipDate).
  const [r, tip] = await Promise.all([
    gitAsync(root, ["status", "--porcelain=v1", "--branch"]),
    tipDate(root),
  ]);
  if (r.code !== 0) return null;
  const lines = r.stdout.split("\n").filter(Boolean);
  const head = lines[0]?.startsWith("##") ? lines[0] : "";
  // "## main...origin/main [ahead 1]" · "## HEAD (no branch)"
  // The name ends at the "..." upstream separator or at whitespace — not at the
  // first dot, which is legal in a branch name (release-1.2.0 truncated to
  // "release-1").
  const m = head.match(/^## (?:No commits yet on )?(.+?)(?:\.\.\.|\s|$)/);
  const branch = head.includes("(no branch)") ? "(detached)" : m?.[1] ?? "(detached)";
  // Free (one stat + one small read, no subprocess), and it's what lets every
  // panel say "this is a worktree of X" rather than showing a bare directory
  // name that happens to look like a project.
  const parent = worktreeParent(root);
  return {
    root, name: basename(root), branch, dirty: lines.length - (head ? 1 : 0),
    ahead: Number(head.match(/ahead (\d+)/)?.[1]) || 0,
    behind: Number(head.match(/behind (\d+)/)?.[1]) || 0,
    touchedAt: touchedAt(root, tip),
    ...(parent ? { worktreeOf: parent } : {}),
  };
}

/**
 * When this checkout was last worked in — what the pickers sort on.
 *
 * `HEAD` and the reflog (`logs/HEAD`) inside the checkout's own git dir,
 * whichever is newer. Git appends to the reflog every time HEAD moves — commit,
 * checkout, merge, rebase, reset, pull — and rewrites HEAD on a branch switch,
 * so between them they answer "when did I last do something here" for two
 * stats and no subprocess. A linked worktree has its own pair under
 * `.git/worktrees/<dir>/`, which is what makes this per-checkout rather than
 * per-repository.
 *
 * NOT the index, which is the obvious choice and the wrong one: `git status`
 * refreshes it and writes it back, and this server runs `git status` against
 * every checkout on a five-second sweep to fill in the dirty counts. The
 * timestamp would have been "when the picker last polled", identical
 * everywhere, and the order would have come out as whichever parallel status
 * happened to finish last. Measured, not assumed — a backdated index came back
 * stamped `now` after a single status.
 *
 * NOT the working tree's own files either: a build writing into `dist/` would
 * make an untouched checkout look like the freshest one on the machine.
 *
 * 0 when it could not be read; those sort last rather than first.
 */
function touchedAt(root: string, tipMs: number): number {
  const dir = gitDir(root);
  if (!dir) return tipMs;
  let newest = tipMs;
  // HEAD itself, not the reflog beside it: a symref file git rewrites on
  // checkout and leaves alone otherwise.
  try { newest = Math.max(newest, statSync(join(dir, "HEAD")).mtimeMs); } catch { /* mid-write, or gone */ }
  return Math.round(newest);
}

// Opening git, terminal and chat each asks for the same list, and a user
// flipping between panels asks again seconds later. The answer is a directory
// sweep plus a git call per repo, so it's worth holding briefly — short enough
// that a branch switch or a new file shows up almost immediately.
/**
 * How long the repo list is held.
 *
 * Was five seconds, which on a repo with eighteen checkouts meant eighteen
 * `git status` calls — 2.9 seconds of CPU — every five seconds, forever, for
 * the dirty dots in a dropdown. Nothing here needs that: the *selected* repo's
 * working tree has its own 2.5s poll through `/git/tree`, and a dot beside a
 * checkout you are not looking at can be a few seconds old. Every write still
 * clears this immediately, so anything you do shows up at once.
 */
const REPO_CACHE_MS = 15_000;
// A small map rather than one slot: the scoped panels and the machine-wide
// project picker ask with different keys, and alternating between them must
// not evict each other's still-fresh answer (each miss re-runs a directory
// sweep plus a git subprocess per repo).
const repoCache = new Map<string, { at: number; repos: GitRepoRef[] }>();

/** Drop cached repo listings touching `root`. Keys are scope-dependent and a
 *  worktree's counts live in its parent's listing too, so this clears the lot:
 *  the list is one directory sweep and is about to be asked for again anyway. */
export function invalidateRepos(_root?: string): void {
  repoCache.clear();
  // Committing or staging changes what is dirty, and this is the one place
  // every write in this file passes through.
  dirtyCache.clear();
  // A commit or a checkout moves the tip date too, and both go through run().
  tipCache.clear();
}

export async function discoverRepos(paths: string[], knownRoots: string[] = [], opts: { ignoreScope?: boolean } = {}): Promise<GitRepoRef[]> {
  // The workspace is part of the key: switching projects at runtime must not
  // serve the old scope's answer for the next five seconds.
  const key = [opts.ignoreScope ? "*" : workspaceRoot() ?? "", ...knownRoots].join("\\0");
  const hit = repoCache.get(key);
  // Held longer while a shell is in use or the loop is stalling: this sweep is
  // eighteen `git status` calls on a worktree-heavy repo, and none of them is
  // worth a late keystroke. See backoff().
  if (hit && Date.now() - hit.at < REPO_CACHE_MS * backoff()) return hit.repos;
  if (repoCache.size > 8) repoCache.clear(); // scope churn — don't hoard stale lists
  const roots = new Set<string>();

  // Opened for one project: that project is the whole answer. No sweeping, no
  // neighbours, no repos that merely showed up in telemetry — the point of
  // scoping to a directory is that nothing else appears. Its linked worktrees
  // come along because they *are* the project, on other branches.
  // (`ignoreScope` is the project *picker* asking — choosing a different
  // project requires seeing more than the current one.)
  const only1 = opts.ignoreScope ? null : workspaceRoot();
  if (only1) {
    const self = repoRoot(only1);
    // The scope may be a repo ("this project") or a plain folder ("my projects
    // live in here" — e.g. ~/code picked in the app). A repo brings its linked
    // worktrees, because they ARE the project on other branches; a container
    // folder brings every repo found from that folder inward, and nothing else.
    const found = self
      // `worktreeList`, not `worktrees`: this needs the paths and nothing else,
      // and the richer call computes a base branch and a `rev-list --count`
      // per checkout — synchronously, on the server's only thread. On a repo
      // with 17 worktrees that is 34 blocking subprocesses, ~200ms each, on
      // the most frequently requested endpoint in the app. Measured: it froze
      // the whole UI — the terminal's PTY socket included — for up to 2.8s at
      // a time, several times a minute, while the user was typing.
      ? [self, ...worktreeList(self).map((w) => w.path).filter((p) => p && p !== self)]
      : reposUnder(only1);
    const refs = await Promise.all(found.map((r) => repoRef(r)));
    const scoped = refs.filter((r): r is GitRepoRef => !!r);
    // The project itself first, then its worktrees. Dirtiest-first is the right
    // order among peers, but it shouldn't bury the main checkout behind a
    // worktree that happens to have more edits open — the dropdown is read as
    // "the project, and the branches I have checked out beside it".
    // The project itself stays at the top — it is the thing the others are
    // worktrees OF, and hunting for it in a list of seventeen is not a thing
    // anyone should have to do. Below it, most recently worked in first: on a
    // ticket-per-worktree repo that is the only ordering that puts what you are
    // doing today above what you did in March. Dirty-first used to be the rule
    // and is subsumed by it — staging a file touches the index.
    scoped.sort((a, b) =>
      Number(!!a.worktreeOf) - Number(!!b.worktreeOf) || b.touchedAt - a.touchedAt || a.name.localeCompare(b.name));
    repoCache.set(key, { at: Date.now(), repos: scoped });
    return scoped;
  }

  // Naming directories has to mean *only* these. The other sources below —
  // agentglass's own neighbours, projects with history, repos seen in
  // telemetry — are how an unconfigured install finds anything at all, but
  // left additive they quietly put back everything the setting was meant to
  // exclude. So they still run (a configured directory is about scope, not
  // about disabling discovery within it) and the result is filtered at the
  // end.
  const only = configuredRepoDirs();
  const selfRoot = repoRootOf(process.cwd());
  if (selfRoot) { roots.add(selfRoot); for (const r of reposUnder(dirname(selfRoot))) roots.add(r); }
  for (const r of knownRoots) { const a = safeAbs(r); if (a && repoRoot(a)) roots.add(a); }
  // Where to sweep for repos no agent has touched yet — without this the panel
  // only offers projects that already have history, which is the wrong way
  // round for a picker you use to *start* working somewhere.
  //
  // Configured directories win outright: naming them is faster than inferring
  // them and, more to the point, predictable. Inference is only the fallback
  // for an unconfigured install, and it can do no better than guess from the
  // directories that happen to hold existing projects.
  // Inferred parents first, then the conventional homes — and the homes only
  // when inference came back with nothing, which is exactly the fresh-install
  // case. A machine that has been used has better information about itself than
  // this list does, and adding `~/code` to it would put back projects the user
  // has never opened here alongside the ones they work in daily.
  const inferred = codeRootsOf(knownRoots);
  const bases = only.length ? only : (inferred.length ? inferred : firstRunRoots());
  for (const base of bases) for (const r of reposUnder(base)) roots.add(r);
  // env overrides for repos that live elsewhere
  for (const p of (process.env.AGENTGLASS_REPOS || "").split(":").filter(Boolean)) { const r = repoRootOf(p); if (r) roots.add(r); }
  // repos seen in recent telemetry — dedupe by parent dir first so this is one
  // `rev-parse` per unique directory, not one per file path.
  const dirs = new Set<string>();
  for (const p of paths) { const a = safeAbs(p); if (a) dirs.add(dirname(a)); }
  for (const d of dirs) { const r = repoRootOf(d); if (r) roots.add(r); }
  // Fold linked worktrees into the project they belong to — for the PICKER only.
  //
  // A user working the way worktrees are meant to be used has a dozen sibling
  // checkouts of one repo (~/code/orbit, ~/code/orbit-WEB-1042, …); each has a
  // `.git`, so the sweep called every one of them a project and "Open a project"
  // showed thirteen entries for what the user has one name for, burying every
  // other project on the machine. Choosing a *project* should offer projects.
  //
  // The panel lists (`/git/repos` without `all=1`) must NOT be folded, even
  // though they run through this same branch when nothing is scoped. There the
  // question is "which checkout do I want a shell / a diff / a chat in", and a
  // worktree is a real answer — an unscoped cockpit has no other way to reach
  // one, since those dropdowns have no free-text path box. They come back tagged
  // with `worktreeOf` instead, and the UI indents them under their project.
  const folded = new Map<string, number>();
  if (opts.ignoreScope) {
    // Only folded when the parent is in the list too. A worktree whose main repo
    // lives outside the swept directories has nothing to fold into, and dropping
    // it would make it unreachable rather than tidy.
    for (const r of [...roots]) {
      const parent = worktreeParent(r);
      if (!parent || !roots.has(parent)) continue;
      roots.delete(r);
      folded.set(parent, (folded.get(parent) ?? 0) + 1);
    }
  }
  // One git call per repo, all of them at once. `--branch` prepends a `##`
  // header naming the branch, which is the other thing the dropdown shows —
  // asking separately doubled the process count for data already in hand.
  // ahead/behind stays 0 here; the header computes the real values for the
  // selected repo via workingTree().
  const out = (await Promise.all([...roots].map((r) => repoRef(r)))).filter((r): r is GitRepoRef => !!r);
  for (const r of out) { const n = folded.get(r.root); if (n) r.worktrees = n; }
  const scoped = only.length ? within(out, only) : out;
  // Families stay together, most recently worked-in family first, the project
  // ahead of its own worktrees. Sorting the flat list alone scatters a repo's
  // checkouts through the dropdown, so `orbit` and `orbit-WEB-1042` end up
  // pages apart — the one arrangement that makes a worktree look like an
  // unrelated project, which is the confusion this whole change is about.
  //
  // A family is as recent as its most recent checkout: work happens in the
  // worktrees, so ranking a project by its own main checkout would sink an
  // actively-worked repo below one nobody has opened in a month.
  const family = (r: GitRepoRef) => r.worktreeOf ?? r.root;
  const rank = new Map<string, { touchedAt: number; name: string }>();
  for (const r of scoped) {
    const f = family(r);
    const cur = rank.get(f);
    // The family's name comes from the project itself, not from whichever
    // worktree happens to sort first.
    if (!cur || (!r.worktreeOf && cur.name !== r.name) || r.touchedAt > cur.touchedAt) {
      rank.set(f, { touchedAt: Math.max(cur?.touchedAt ?? 0, r.touchedAt), name: r.worktreeOf ? cur?.name ?? r.name : r.name });
    }
  }
  scoped.sort((a, b) => {
    const fa = family(a), fb = family(b);
    if (fa !== fb) {
      const ra = rank.get(fa)!, rb = rank.get(fb)!;
      return rb.touchedAt - ra.touchedAt || ra.name.localeCompare(rb.name);
    }
    return Number(!!a.worktreeOf) - Number(!!b.worktreeOf) || b.touchedAt - a.touchedAt || a.name.localeCompare(b.name);
  });
  repoCache.set(key, { at: Date.now(), repos: scoped });
  return scoped;
}

/** Keep only repos inside one of `dirs`. */
function within(repos: GitRepoRef[], dirs: string[]): GitRepoRef[] {
  const bases = dirs.map((d) => safeAbs(d)).filter((d): d is string => !!d);
  return repos.filter((r) => bases.some((b) => r.root === b || r.root.startsWith(b + sep)));
}

// --- mutating ops (all gated + path-validated) -------------------------------

function guard(root: string): GitActionResult | null {
  if (!GIT_WRITE_ENABLED) return { ok: false, error: "git write is disabled (AGENTGLASS_GIT_WRITE_DISABLED=1)" };
  if (!repoRoot(root)) return { ok: false, error: "not a git repository root" };
  // A cockpit opened for one project should not be able to commit, stage or
  // discard in a different one. The message names the way out rather than just
  // refusing: scoping to a parent folder is the supported multi-repo setup.
  if (!inScope(root)) return { ok: false, error: "outside the open project — open the parent folder to work across repos" };
  return null;
}

function validRels(root: string, rels: unknown): string[] | null {
  if (!Array.isArray(rels)) return null;
  const out: string[] = [];
  for (const r of rels) {
    if (typeof r !== "string" || !inRepo(root, r)) return null;
    out.push(r);
  }
  return out;
}

/**
 * Told when a repository mutates, so the server can push a nudge to every
 * client. A hook rather than an import: gitwork must not depend on the HTTP
 * layer, and this keeps the direction of that dependency honest.
 */
let onGitChange: (() => void) | null = null;
export function setGitChangeHook(fn: (() => void) | null): void { onGitChange = fn; }

function run(root: string, args: string[]): GitActionResult {
  const r = git(root, args);
  // Every mutating path goes through here, so this is the one place that has to
  // know the merged-set may have moved — rather than each of the twenty callers
  // remembering to say so.
  invalidateMerged(root);
  // And the repo list, for the same reason. It is cached for 5s, and the panel
  // re-fetches the instant an action returns — so a pull answered from the
  // cache written moments earlier, and the picker went on showing "behind 351"
  // against a header that already said the branch was up to date. Nothing
  // re-fetched afterwards, so it stayed wrong until the next action.
  invalidateRepos(root);
  // And the behind-the-base counts. They have their own 15s TTL, so after a
  // sync the header went on advertising "↓370" against a branch that had just
  // taken those very commits — while the push count beside it had already
  // updated, which is worse than both being stale.
  behindCache.clear();
  // One signal out to every panel. Without it each of them discovered the
  // change on its own clock — 5s, 90s, or not until it was remounted.
  try { onGitChange?.(); } catch { /* a broken listener must not fail the op */ }
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || r.stdout.trim() || `git ${args[0]} failed`, output: (r.stdout + r.stderr).trim() };
  return { ok: true, output: (r.stdout + r.stderr).trim() };
}

export function stage(rootIn: string, rels: unknown): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  const v = validRels(root, rels); if (!v || !v.length) return { ok: false, error: "no valid paths" };
  return run(root, ["add", "-A", "--", ...v]);
}

export function unstage(rootIn: string, rels: unknown): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  const v = validRels(root, rels); if (!v || !v.length) return { ok: false, error: "no valid paths" };
  // `restore --staged` handles the no-HEAD (empty repo) case gracefully.
  return run(root, ["reset", "-q", "--", ...v]);
}

export function stageAll(rootIn: string): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  return run(root, ["add", "-A"]);
}

export function unstageAll(rootIn: string): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  return run(root, ["reset", "-q", "HEAD", "--"]);
}

/** Discard working-tree changes for tracked paths, and delete untracked ones. */
export function discard(rootIn: string, rels: unknown): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  const v = validRels(root, rels); if (!v || !v.length) return { ok: false, error: "no valid paths" };
  // Split tracked vs untracked; restore the former, clean the latter.
  const tracked: string[] = [], others: string[] = [];
  for (const rel of v) {
    const known = git(root, ["ls-files", "--error-unmatch", "--", rel]).code === 0;
    (known ? tracked : others).push(rel);
  }
  if (tracked.length) {
    const r = run(root, ["restore", "--staged", "--worktree", "--", ...tracked]);
    if (!r.ok) return r;
  }
  if (others.length) {
    const r = run(root, ["clean", "-fd", "--", ...others]);
    if (!r.ok) return r;
  }
  return { ok: true, output: `discarded ${v.length} path(s)` };
}

/** Commit whatever is currently staged (the index). */
export function commitStaged(rootIn: string, title: string, body: string): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  if (!title.trim()) return { ok: false, error: "commit title required" };
  const staged = git(root, ["diff", "--cached", "--name-only"]).stdout.trim();
  if (!staged) return { ok: false, error: "nothing staged to commit" };
  const args = ["commit", "-m", title.trim()];
  if (body && body.trim()) args.push("-m", body.trim());
  const r = run(root, args);
  if (!r.ok) return r;
  const sha = git(root, ["rev-parse", "--short", "HEAD"]).stdout.trim();
  return { ok: true, output: `committed ${sha}` };
}

// Network ops — bounded and gated. pull is --ff-only to avoid surprise merges.
export function push(rootIn: string): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  return run(root, ["push"]);
}
export function pull(rootIn: string): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  return run(root, ["pull", "--ff-only"]);
}
/**
 * Keep ahead/behind honest, in the background.
 *
 * `git status` and `for-each-ref` compare HEAD against the *local* `origin/*`
 * refs, which only move when something fetches. Without this the counts are as
 * old as the last manual fetch — which is why a branch could sit 500 commits
 * behind its upstream and the panel would cheerfully show nothing at all.
 * lazygit solves it the same way (`git.autoFetch`, 60s).
 *
 * Three things this must never do, all of which rule out reusing fetch():
 *   * Block. fetch() is spawnSync, and this server is single-threaded — one
 *     stalled network call would freeze every other request for its timeout.
 *   * Prompt. A repo whose credentials expired would otherwise hang on a
 *     terminal password prompt no one can answer, once a minute, forever.
 *     GIT_TERMINAL_PROMPT=0 and an empty GIT_ASKPASS turn that into a fast
 *     failure; SSH_ASKPASS_REQUIRE covers the ssh path.
 *   * Complain. Being offline is the normal state of a laptop, not an error
 *     worth logging every minute.
 *
 * Only the open project is fetched — never a sweep of the machine. Its linked
 * worktrees come along for free: they share one object store and one set of
 * remote refs, so a single fetch updates the counts for all of them.
 */
const AUTO_FETCH_MS = Number(process.env.AGENTGLASS_AUTOFETCH_SECONDS ?? 60) * 1000;
let fetching = false;

async function autoFetchOnce(): Promise<void> {
  // Overlapping fetches would pile up on a slow remote; one in flight is enough.
  if (fetching) return;
  const root = workspaceRoot();
  // Unscoped means "the whole machine", and fetching every repo on the machine
  // once a minute is exactly the cost this feature must not have.
  if (!root || !repoRoot(root)) return;
  fetching = true;
  try {
    // What the remote refs point at, before and after. Invalidating on every
    // tick regardless is what broke squash detection outright: the sweep that
    // recognises squash- and rebase-merged branches takes tens of seconds on a
    // large repo, and this ran every 60s and cleared its "already swept" mark
    // each time — so on a 38-branch repo the sweep NEVER finished, the panel
    // sat on "still checking for squash merges…" permanently, and not one
    // squash-merged branch was ever recognised. Most fetches change nothing.
    const refsOf = () => git(root, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/remotes"]).stdout;
    const before = refsOf();
    const proc = Bun.spawn(["git", "-C", root, "fetch", "--all", "--prune", "--quiet"], {
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS_REQUIRE: "never" },
    });
    const timer = setTimeout(() => proc.kill(), 20_000);
    await proc.exited;
    clearTimeout(timer);
    // A fetch that MOVED origin/* changes what "merged into the trunk" means.
    // One that moved nothing changes nothing, and must not throw away work.
    if (refsOf() !== before) invalidateMerged(root);
  } catch {
    // Offline, no remote, no credentials — all ordinary. The counts simply stay
    // where they were, which is the same as the old behaviour.
  } finally {
    fetching = false;
  }
}

export function startAutoFetch(): void {
  if (AUTO_FETCH_MS <= 0) return; // AGENTGLASS_AUTOFETCH_SECONDS=0 turns it off
  setInterval(() => { entered("auto-fetch"); void autoFetchOnce(); }, AUTO_FETCH_MS).unref?.();
  autoFetchOnce(); // don't make the first minute a lie
}

export function fetch(rootIn: string): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  return run(root, ["fetch", "--all", "--prune"]);
}

// --- branches / log / stash --------------------------------------------------
const US = "\x1f"; // field separator
const validRef = (n: string) => typeof n === "string" && /^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]+$/.test(n) && !n.endsWith("/") && !n.endsWith(".lock");
const validHash = (h: string) => typeof h === "string" && /^[0-9a-fA-F]{4,40}$/.test(h);

/**
 * The repository's trunk — what "was this merged?" has to be asked against.
 *
 * `git branch -d` asks whether a branch is merged into **HEAD**, which is the
 * wrong question the moment you work in worktrees: opened on a ticket branch,
 * every merged PR looks unmerged, because it was merged into master and master
 * isn't what you have checked out. The honest question is always "is it in the
 * trunk", so we have to name the trunk ourselves.
 *
 * `origin/HEAD` is the remote's own answer and survives a repo whose default is
 * neither `main` nor `master`. It's only a local symref though, so it can be
 * missing on a clone made with `--single-branch`; the fallbacks cover that.
 */
export function defaultBranch(root: string): string | null {
  const sym = git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).stdout.trim();
  if (sym) return sym;
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (git(root, ["rev-parse", "--verify", "--quiet", ref]).code === 0) return ref;
  }
  return null;
}

/**
 * Branch names already contained in `ref` — one call, not one per branch.
 *
 * Cached, and it has to be: `--merged` walks history for every branch in the
 * repo, which on a real one (57 branches, a few hundred thousand commits)
 * measures 819ms. The branches view polls every 2.5s, so computing it live
 * spent a third of every cycle answering a question whose answer only changes
 * when something merges, rebases or fetches — none of which happen twice a
 * second. Uncached, this alone took /git/branches from 90ms to 908ms.
 *
 * The TTL is the staleness anyone can perceive: merge a branch and it stops
 * being marked deletable up to half a minute later, which is invisible next to
 * the panel being usable.
 */
const MERGED_TTL_MS = 30_000;
const mergedCache = new Map<string, { at: number; set: Set<string> }>();

/**
 * Was this branch squash-merged into `ref`?
 *
 * `--merged` only knows ancestry, and a squash merge destroys it: the PR lands
 * as one new commit with a new hash, so the branch tip never becomes an
 * ancestor of the trunk. Every branch merged through the GitHub button is
 * therefore "unmerged" by that test — which is most of them here, and which is
 * why the panel dead-ended on "not fully merged" for work already in main.
 *
 * The test that survives the rewrite is by content, not ancestry: replay the
 * branch's whole diff as a single commit on top of the merge base, then ask
 * `git cherry` whether the trunk already holds an equivalent patch. That is
 * exactly the shape a squash merge produces, so the patch-ids match; a leading
 * `-` means "already upstream".
 *
 * `commit-tree` leaves one dangling commit behind. It's unreferenced and the
 * next gc collects it — the standard price for this probe.
 *
 * False, never a throw, when the two share no history: this repo has unrelated
 * histories in it, and "no merge base" means there is nothing to compare, not
 * that the work is safe to delete.
 */
function isSquashMerged(root: string, ref: string, name: string): boolean {
  const base = git(root, ["merge-base", ref, name]);
  const mergeBase = base.stdout.trim();
  if (base.code !== 0 || !mergeBase) return false;
  const tree = git(root, ["rev-parse", `${name}^{tree}`]).stdout.trim();
  if (!tree) return false;
  // A branch holding nothing the base didn't already have has no patch to find,
  // and would otherwise look "merged" on the strength of an empty diff.
  if (tree === git(root, ["rev-parse", `${mergeBase}^{tree}`]).stdout.trim()) return false;
  const dangling = git(root, ["commit-tree", tree, "-p", mergeBase, "-m", "_"]);
  if (dangling.code !== 0) return false;
  const cherry = git(root, ["cherry", ref, dangling.stdout.trim()]);
  return cherry.code === 0 && cherry.stdout.trim().startsWith("-");
}

/**
 * Was this branch rebase-merged into `ref` — replayed commit by commit?
 *
 * Neither check above can see that shape. Ancestry can't, because the replay
 * gives every commit a new hash. And the squash probe can't either: it asks
 * about ONE commit carrying the branch's whole diff, and that combined patch-id
 * matches nothing when the rebase left several separate commits upstream. A
 * branch merged this way reads as unmerged forever, on both tests at once.
 *
 * `git cherry` is the check shaped for it — patch-ids compared per commit, with
 * a leading `-` on the ones already upstream. Every line a `-` means every
 * commit this branch adds is in the trunk already under a different hash.
 *
 * One spawn, against the squash probe's five, so it goes first.
 *
 * Empty output is not an answer, and must not be read as one. It means there
 * are no non-merge commits ahead: either an ancestor, which `--merged` has
 * already said, or a branch whose only commits ahead are merges — and a merge
 * can carry conflict resolutions that exist nowhere else. This can't vouch for
 * those, so it declines and leaves the branch its confirmation.
 *
 * Where it stops, precisely: `git cherry` skips merge commits, so a branch that
 * pulled the trunk in and hand-resolved a conflict into content living nowhere
 * else is the one thing a clean run of dashes can still miss. Reaching this
 * code at all means the remote branch is gone — the PR closed, taking that
 * resolution upstream with it — so the gap is narrow enough to be worth the
 * branches it frees. It is the only gap.
 */
function isRebaseMerged(root: string, ref: string, name: string): boolean {
  const r = git(root, ["cherry", ref, name]);
  if (r.code !== 0) return false;
  const lines = r.stdout.split("\n").filter(Boolean);
  return lines.length > 0 && lines.every((l) => l.startsWith("-"));
}

/**
 * Up to five spawns per branch, so this can't run over every branch of a big
 * repo on a 2.5s poll. The branches anyone is actually trying to delete are the
 * recent ones, so probe those and leave the tail to the ancestry answer. A
 * branch past the cap reads as unmerged, which is the safe direction to be
 * wrong in: it keeps its confirmation prompt instead of losing it.
 */
const PROBE_MAX = 20;

/** How long a completed sweep is trusted. Far longer than the ancestry TTL
 *  because it costs several spawns per branch: re-running it every 30s burns a
 *  second of CPU to learn nothing, and anything that could change the answer
 *  calls invalidateMerged() anyway. */
const PROBE_TTL_MS = 5 * 60_000;
/** Keys whose sweep has finished, and when. Separate from mergedCache so the
 *  cheap ancestry answer can keep refreshing on its own clock. */
const probedAt = new Map<string, number>();
/** Keys with a sweep in flight, so a burst of polls starts one, not ten. */
const probeRunning = new Set<string>();

/**
 * What the sweep proved, and the tip it proved it at: key → branch → sha.
 *
 * The sweep fills the Set the cache entry holds, in place. That works right up
 * until MERGED_TTL_MS expires and mergedInto() builds a *new* Set from ancestry
 * alone — and the sweep will not refill it, because PROBE_TTL_MS is ten times
 * longer and its "swept recently" stamp turns the next call into a no-op. So
 * every squash- and rebase-merged branch was recognised for thirty seconds out
 * of every five minutes, and read "not merged — kept" for the other four and a
 * half. This is what makes a verdict outlive the Set it was written into.
 *
 * Keyed by tip sha, because a branch that has moved since is a branch carrying
 * commits nobody has checked — and the button behind this answer is `branch -D`.
 */
const probeMemo = new Map<string, Map<string, string>>();

/** Every local branch and the commit it points at, newest first — one spawn. */
function branchTips(root: string): Map<string, string> {
  const r = git(root, ["for-each-ref", "--sort=-committerdate", "refs/heads", `--format=%(refname:short)${US}%(objectname)`]);
  const out = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const [name, sha] = line.split(US);
    if (name && sha) out.set(name, sha);
  }
  return out;
}

/** Re-apply the sweep's verdicts to a freshly built ancestry set, forgetting
 *  any whose branch has since moved or gone. Costs a spawn, and only when there
 *  is something to re-apply. */
function applyMemo(root: string, key: string, set: Set<string>): void {
  const memo = probeMemo.get(key);
  if (!memo?.size) return;
  const tips = branchTips(root);
  for (const [name, sha] of memo) {
    if (tips.get(name) === sha) set.add(name);
    else memo.delete(name);
  }
}

async function mergedInto(root: string, ref: string): Promise<Set<string>> {
  // \u0000 rather than a raw NUL byte: written literally it makes the whole
  // file `data` to grep, which then skips it silently — you get no matches
  // and no warning. Same separator, same keys, still greppable.
  const key = `${root}\u0000${ref}`;
  const hit = mergedCache.get(key);
  if (hit && Date.now() - hit.at < MERGED_TTL_MS) return hit.set;
  // 644ms on a repo with a long history — the single most expensive call in
  // this endpoint, and cached, so it is paid on a miss and then not again until
  // a ref moves. Awaited so that miss costs wall clock rather than a terminal.
  const r = await gitAsync(root, ["for-each-ref", "--merged", ref, "refs/heads", "--format=%(refname:short)"]);
  const set = new Set(r.stdout.split("\n").filter(Boolean));
  applyMemo(root, key, set);
  mergedCache.set(key, { at: Date.now(), set });
  sweepProbes(root, ref, key, set);
  return set;
}

/**
 * Recover the merges ancestry can't see — squashed and rebased — off the
 * request path.
 *
 * This used to run inline, and it is what made the Branches tab take five
 * seconds on a 44-branch repo (measured: 4.95s cold against a 30s TTL, which
 * guaranteed you met the cold path constantly; 130ms warm). Each probe is ~5
 * git spawns, up to twenty of them, all before the response could be written.
 *
 * None of that has to happen before the list is shown. Ancestry — one spawn —
 * already answers for most branches, and `mergedIntoTrunk` is allowed to be
 * absent: the UI reads that as "we don't know" and keeps the delete
 * confirmation, which is the safe direction to be wrong in. So the list goes
 * out immediately and the sweep fills the very Set the cache entry holds, in
 * place, so the next poll serves the fuller answer with no extra request — and
 * records each verdict in probeMemo, which is what carries it past the moment
 * that Set is thrown away and rebuilt.
 *
 * Newest first: that's the order for-each-ref gives with this sort, and the
 * order that spends the probe budget where deletes actually happen.
 */
function sweepProbes(root: string, ref: string, key: string, set: Set<string>): void {
  if (probeRunning.has(key)) return;
  const done = probedAt.get(key);
  if (done && Date.now() - done < PROBE_TTL_MS) return;
  probeRunning.add(key);

  // One branch per tick, not the whole sweep in one.
  //
  // `git()` is spawnSync, so moving the loop into a timeout does not stop it
  // blocking — it only chooses a different victim. Measured: the first request
  // dropped from 4.9s to 0.8s, and the *next* one paid 3.3s instead, because it
  // arrived while the twenty probes were still running on the one thread.
  //
  // Yielding between probes bounds that to a single probe (~150ms) instead of
  // the whole sweep, so the panel stays responsive while it fills in behind.
  let idx = 0;
  let probes = 0;
  let started = false;
  let all: [string, string][] = [];
  const step = () => {
    try {
      if (!started) { all = [...branchTips(root)]; started = true; }
      while (idx < all.length) {
        const [name, sha] = all[idx++]!;
        if (set.has(name)) continue;
        if (probes++ >= PROBE_MAX) { idx = all.length; break; }
        // Cheapest test first: one spawn, and it answers for every branch the
        // trunk took by rebase. The squash probe's five only run when it can't.
        if (isRebaseMerged(root, ref, name) || isSquashMerged(root, ref, name)) {
          // Mutates the Set the cache entry already holds, so the next read
          // sees the fuller answer without another sweep — and the memo keeps
          // it once that Set expires.
          set.add(name);
          let memo = probeMemo.get(key);
          if (!memo) probeMemo.set(key, (memo = new Map()));
          memo.set(name, sha);
        }
        setTimeout(step, 0); // one probe per turn of the loop
        return;
      }
      probedAt.set(key, Date.now());
      probeRunning.delete(key);
    } catch {
      // A failed sweep just leaves the ancestry answer standing.
      probeRunning.delete(key);
    }
  };
  setTimeout(step, 0);
}


/** Drop the cache after anything that can change what's merged, so the panel
 *  reflects your own action immediately rather than up to a TTL later. */
export function invalidateMerged(root?: string): void {
  // All three, always. The sweep stamp has a far longer TTL than the ancestry
  // entry, so clearing only the latter would hand the rebuilt entry a "swept
  // recently" mark and skip the probe pass for minutes — exactly the window
  // after a merge, when the answer has just changed. The memo goes with them,
  // or a verdict recorded before the merge is re-applied to the rebuilt set and
  // outlives the very event that invalidated it.
  if (!root) { mergedCache.clear(); probedAt.clear(); probeMemo.clear(); return; }
  const mine = `${root}\u0000`;
  for (const m of [mergedCache, probedAt, probeMemo] as Map<string, unknown>[]) {
    for (const k of m.keys()) if (k.startsWith(mine)) m.delete(k);
  }
}


export async function branches(rootIn: unknown): Promise<{ current: string; branches: GitBranch[]; trunk: string | null }> {
  const root = repoRoot(rootIn);
  if (!root) return { current: "", branches: [], trunk: null };
  const fmt = `%(refname:short)${US}%(HEAD)${US}%(upstream:short)${US}%(upstream:track)${US}%(committerdate:relative)${US}%(contents:subject)`;
  const [r, trunk] = [git(root, ["for-each-ref", "--sort=-committerdate", "refs/heads", `--format=${fmt}`]), defaultBranch(root)];
  const merged = trunk ? await mergedInto(root, trunk) : null;
  const list: GitBranch[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const [name, head, upstream, track, date, subject] = line.split(US);
    list.push({
      name, current: head === "*", upstream: upstream || null, track: track || "",
      date: date || "", subject: subject || "",
      // Undefined rather than false when there's no trunk to compare against —
      // "we don't know" and "not merged" must not look the same to the UI.
      ...(merged ? { mergedIntoTrunk: merged.has(name) } : {}),
    });
  }
  // No "still sweeping" flag here, deliberately. mergedInto() above is what
  // schedules the sweep, so asking whether one is running always answered yes:
  // the sweep is a setTimeout and cannot have run yet within this call. The
  // flag was a question asked immediately after switching it on. The count
  // settling a beat later is the honest behaviour, and a permanent label
  // explaining it was worse than the thing it explained.
  return { current: currentBranch(root), branches: list, trunk };
}

// lazygit-style branch ops
export function mergeBranch(rootIn: string, name: string): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  if (!validRef(name)) return { ok: false, error: "invalid branch name" };
  return run(root, ["merge", "--no-edit", name]);
}
export function rebaseBranch(rootIn: string, name: string): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  if (!validRef(name)) return { ok: false, error: "invalid branch name" };
  return run(root, ["rebase", name]);
}
export function renameBranch(rootIn: string, name: string, to: string): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  if (!validRef(name) || !validRef(to)) return { ok: false, error: "invalid branch name" };
  return run(root, ["branch", "-m", name, to]);
}
export function resetTo(rootIn: string, ref: string, mode: "soft" | "mixed" | "hard"): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  if (!validHash(ref) && !validRef(ref)) return { ok: false, error: "invalid ref" };
  if (!["soft", "mixed", "hard"].includes(mode)) return { ok: false, error: "invalid reset mode" };
  return run(root, ["reset", `--${mode}`, ref]);
}

/**
 * `git log --graph` rendered to rows: the graph glyphs plus commit fields
 * (graph-only connector rows carry just `graph`).
 *
 * `scope` decides whose history this is, and the default matters. It used to be
 * `--all` unconditionally, so a worktree on a ticket branch showed 500 commits
 * belonging to every branch in the repo — on a busy repo the top of the log was
 * other people's work, and the branch you were standing on was nowhere near the
 * top. That reads as a bug even though git was doing exactly what it was asked.
 *
 * So: HEAD by default — the log of the checkout you are in — with `--all` still
 * a click away for the times you genuinely want the whole graph.
 */
export async function logGraph(rootIn: unknown, limit = 400, scope: "head" | "all" = "head"): Promise<{ lines: GitGraphLine[]; scope: "head" | "all"; branch: string }> {
  const root = repoRoot(rootIn);
  if (!root) return { lines: [], scope, branch: "" };
  const n = Math.max(1, Math.min(2000, limit | 0));
  // NUL can't go in an argv string (execve truncates at it), so use the same
  // \x1f unit-separator the branch code uses — safe in args, absent from commits.
  const fmt = `${US}%h${US}%an${US}%ar${US}%s${US}%D`;
  // Awaited: measured at 761ms on a large repo, and the cost is `--graph`'s
  // topological walk rather than the row count — asking for 60 commits instead
  // of 500 saves nothing (762ms vs 761ms). So the only thing that helps is not
  // holding the loop while it runs.
  const r = await gitAsync(root, ["-c", "core.quotePath=false", "log", "--graph", ...(scope === "all" ? ["--all"] : []), "--date=relative", `-n${n}`, `--format=${fmt}`]);
  const lines: GitGraphLine[] = [];
  for (const raw of r.stdout.split("\n")) {
    if (!raw) continue;
    const i = raw.indexOf(US);
    if (i === -1) { lines.push({ graph: raw }); continue; }
    const [hash, author, date, subject, refs] = raw.slice(i + 1).split(US);
    lines.push({ graph: raw.slice(0, i), hash, author, date, subject, refs });
  }
  // Named so the pane can say whose history it is showing rather than leaving
  // the user to infer it from the commits.
  return { lines, scope, branch: currentBranch(root) };
}

// --- worktrees (the user's per-card unit of work) ----------------------------
/**
 * The branch this one was cut from — what a PR would call its base.
 *
 * Git does not record it. `@{upstream}` is the *remote* tracking branch, not
 * the branch the work forked off, and nothing else in the repository stores
 * the answer: it lives in the pull request, on a server we are not talking to.
 *
 * So: an explicit answer if there is one, the trunk otherwise. The override is
 * written to the repository's own config (`branch.<name>.agentglassbase`), so
 * it survives restarts, travels with the checkout, and can be read or changed
 * with plain `git config` by someone who has never heard of this app.
 *
 * Deliberately not inferred by walking merge-bases against every other branch:
 * that is one subprocess per branch for a guess that is wrong exactly when
 * branches are stacked — the case where being wrong costs you a bad merge.
 */
export async function baseOf(root: string, branch: string): Promise<string | null> {
  if (!branch || branch === "(detached)") return null;
  // Two subprocesses, and `worktrees()` asks once per checkout — 34 of them on
  // a repo with seventeen. Left synchronous they were the 806ms this endpoint
  // still cost after everything around them had been awaited.
  const cfg = (await gitAsync(root, ["config", "--get", `branch.${branch}.agentglassbase`])).stdout.trim();
  if (cfg && validRef(cfg) && (await gitAsync(root, ["rev-parse", "--verify", "--quiet", cfg])).code === 0) return cfg;
  const trunk = defaultBranch(root);
  // A branch is not its own base; the trunk checkout simply has none.
  if (!trunk || trunk === branch || trunk.replace(/^origin\//, "") === branch) return null;
  return trunk;
}

/**
 * Do two refs name the same branch, ignoring which remote they came through?
 *
 * `origin/main` and `main` are one branch wearing two names, and telling them
 * apart matters: a branch that tracks the trunk directly — every local-only
 * branch made with `git branch --track main`, and every worktree cut from one —
 * has `@{upstream}` pointing at the trunk rather than at a remote copy of
 * itself. Comparing the strings says "different"; comparing what they resolve
 * to says "the same", and only the second answer is useful.
 *
 * Compared as full ref names rather than by stripping a slash, because branch
 * names contain slashes too: chopping the first segment off `native/egui-shell`
 * leaves `egui-shell`, which is not a branch anyone has.
 */
function sameBranch(root: string, a: string, b: string): boolean {
  const short = (ref: string): string => {
    const full = git(root, ["rev-parse", "--symbolic-full-name", ref]).stdout.trim();
    return full
      .replace(/^refs\/heads\//, "")
      .replace(/^refs\/remotes\/[^/]+\//, "");
  };
  const x = short(a);
  return !!x && x === short(b);
}

export function setBase(rootIn: unknown, branch: unknown, base: unknown): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  if (typeof branch !== "string" || !validRef(branch)) return { ok: false, error: "invalid branch" };
  if (base === null || base === "") return run(root, ["config", "--unset", `branch.${branch}.agentglassbase`]);
  if (typeof base !== "string" || !validRef(base)) return { ok: false, error: "invalid base" };
  return run(root, ["config", `branch.${branch}.agentglassbase`, base]);
}

/** How many commits the base has that this branch does not. Cached: it moves
 *  only when something fetches or merges, and these views poll. */
const BEHIND_TTL_MS = 15_000;
const behindCache = new Map<string, { at: number; n: number }>();
export async function behindBase(root: string, branch: string, base: string): Promise<number> {
  const key = `${root}\u0000${branch}\u0000${base}`;
  const hit = behindCache.get(key);
  if (hit && Date.now() - hit.at < BEHIND_TTL_MS) return hit.n;
  // ~200ms per checkout on a large repo, and `worktrees()` asks it once per
  // worktree — seventeen of them here. Awaited, so the seventeen overlap and
  // none of them holds the thread the terminal is on.
  const r = await gitAsync(root, ["rev-list", "--count", `${branch}..${base}`]);
  const n = r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
  if (behindCache.size > 400) behindCache.clear();
  behindCache.set(key, { at: Date.now(), n });
  return n;
}

/**
 * Bring the base's commits into a checkout — "update from base", the action a
 * pull request page offers as "Update branch".
 *
 * A merge, not a rebase. Rebase rewrites commits that may already be pushed,
 * which turns a one-click convenience into a force-push and somebody else's
 * bad afternoon. The merge runs *in the worktree that has the branch checked
 * out*, which is what makes this possible at all: you cannot merge into a
 * branch you are not on, and a worktree per card means every branch is on one.
 */
export async function syncFromBase(dirIn: unknown, baseIn?: unknown): Promise<GitActionResult> {
  const dir = repoRoot(dirIn); if (!dir) return { ok: false, error: "not a git repository root" };
  const g = guard(dir); if (g) return g;
  const branch = currentBranch(dir);
  if (!branch || branch === "(detached)") return { ok: false, error: "this checkout is not on a branch" };
  const base = typeof baseIn === "string" && baseIn ? baseIn : await baseOf(dir, branch);
  if (!base) return { ok: false, error: "no base branch is known for this checkout" };
  if (!validRef(base)) return { ok: false, error: "invalid base" };
  // Refuse on a dirty tree rather than merging over uncommitted work: git would
  // usually stop anyway, but "usually" is not a promise worth making with
  // somebody's changes.
  if (git(dir, ["status", "--porcelain"]).stdout.trim()) return { ok: false, error: "commit or stash your changes first" };
  return run(dir, ["merge", "--no-edit", base]);
}

/**
 * Files git has left conflicted, from `--diff-filter=U`.
 *
 * A conflicted file is not "modified": it is a file git has stopped in the
 * middle of and will not commit until you say what it should contain. The
 * working-tree lists showed them alongside ordinary edits with no way to tell,
 * which is how you end up committing a file with `<<<<<<<` in it.
 */
export function conflicts(rootIn: unknown): { ok: boolean; state: GitTreeState; files: string[]; error?: string } {
  const root = repoRoot(rootIn);
  if (!root) return { ok: false, state: "clean", files: [], error: "not a git repository root" };
  const r = git(root, ["diff", "--name-only", "--diff-filter=U", "-z"]);
  const files = r.stdout.split("\u0000").filter(Boolean).map((rel) => join(root, rel));
  return { ok: true, state: treeState(root), files };
}

/** Take one side of a conflicted file wholesale, and stage it — the two
 *  resolutions that need no editor and cover most conflicts (a lockfile, a
 *  generated migration, a file the other branch deleted). */
export function resolveWith(rootIn: unknown, relIn: unknown, side: unknown): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  if (side !== "ours" && side !== "theirs") return { ok: false, error: "side must be ours or theirs" };
  const rels = validRels(root, Array.isArray(relIn) ? relIn : [relIn]);
  if (!rels?.length) return { ok: false, error: "invalid path" };
  const co = run(root, ["checkout", `--${side}`, "--", ...rels]);
  if (!co.ok) return co;
  return run(root, ["add", "--", ...rels]);
}

/** Abandon the merge and put the tree back exactly as it was. The only move
 *  that is always safe, and the one someone reaches for first. */
export function mergeAbort(rootIn: unknown): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  const state = treeState(root);
  if (state === "rebasing") return run(root, ["rebase", "--abort"]);
  if (state === "cherry-picking") return run(root, ["cherry-pick", "--abort"]);
  if (state === "reverting") return run(root, ["revert", "--abort"]);
  return run(root, ["merge", "--abort"]);
}

/** Finish once every conflict is staged. Refuses while any remain rather than
 *  letting git fail with a message nobody reads. */
export function mergeContinue(rootIn: unknown): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  const left = git(root, ["diff", "--name-only", "--diff-filter=U"]).stdout.trim();
  if (left) return { ok: false, error: `still conflicted: ${left.split("\n").length} file(s) to resolve` };
  const state = treeState(root);
  if (state === "rebasing") return run(root, ["-c", "core.editor=true", "rebase", "--continue"]);
  if (state === "cherry-picking") return run(root, ["-c", "core.editor=true", "cherry-pick", "--continue"]);
  // `merge --continue` needs an editor; --no-edit keeps git's own message.
  return run(root, ["commit", "--no-edit"]);
}

/**
 * What you can sensibly merge from.
 *
 * Local heads *and* remote-tracking refs, because the default base is a remote
 * one — `origin/master`, the master that has actually been fetched. Offering
 * only local branches meant the picker's `master` was a different, usually
 * staler commit than the base it was replacing, and nothing said so.
 *
 * Remotes first: on a repo where every branch is a ticket, the thing you merge
 * from is nearly always upstream.
 */
export function baseCandidates(rootIn: unknown): { ok: boolean; refs: { name: string; remote: boolean }[] } {
  const root = repoRoot(rootIn);
  if (!root) return { ok: false, refs: [] };
  const read = (ref: string) =>
    git(root, ["for-each-ref", "--sort=-committerdate", ref, "--format=%(refname:short)"])
      .stdout.split("\n").filter(Boolean);
  // Drop `origin/HEAD` and the bare `origin` symref: neither is a branch you
  // merge from, and the bare one reads as if it were.
  const remotes = read("refs/remotes").filter((n) => !n.endsWith("/HEAD") && n.includes("/"));
  const locals = read("refs/heads");
  const seen = new Set<string>();
  const refs: { name: string; remote: boolean }[] = [];
  for (const n of remotes) if (!seen.has(n)) { seen.add(n); refs.push({ name: n, remote: true }); }
  for (const n of locals) if (!seen.has(n)) { seen.add(n); refs.push({ name: n, remote: false }); }
  return { ok: true, refs };
}

/**
 * Is the tip an undoable merge?
 *
 * Three conditions, all about not destroying anything you cannot get back:
 *
 *  - the tip is a merge commit (two parents), so there is a "before" to return
 *    to that is exactly the branch as it was;
 *  - nothing is committed on top of it, which the first condition already
 *    guarantees — a later commit would be the tip instead;
 *  - it has not been pushed. Rewriting local history is free; rewriting
 *    published history is somebody else's problem tomorrow.
 *
 * A dirty tree disqualifies it too: the undo is a hard reset, and there is no
 * version of "discard your uncommitted work as a side effect" worth offering.
 */
export function undoableMerge(root: string, ahead: number, upstream: string | null): boolean {
  // Pushed work is never undone this way. `ahead` is already computed for the
  // header, so this costs nothing for a branch level with its remote.
  //
  // No upstream at all is the *safest* case, not the most dangerous: nothing
  // has been published anywhere, so there is nobody to surprise. Reading
  // ahead===0 as "already pushed" got that exactly backwards and refused the
  // one situation where the undo is unambiguously free.
  if (upstream && ahead < 1) return false;
  const parents = git(root, ["rev-list", "--parents", "-n", "1", "HEAD"]).stdout.trim().split(/\s+/);
  if (parents.length < 3) return false; // sha + two parents = a merge
  return !git(root, ["status", "--porcelain"]).stdout.trim();
}

/** Put the branch back exactly as it stood before its last merge. */
export async function undoMerge(rootIn: unknown): Promise<GitActionResult> {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  // Re-checked here, never trusted from the client: this is a hard reset, and
  // these conditions are the only thing making it safe.
  const info = await branchInfo(root);
  if (!undoableMerge(root, info.ahead, info.upstream)) {
    return { ok: false, error: "nothing to undo — the tip is not an unpushed merge, or the tree is dirty" };
  }
  return run(root, ["reset", "--hard", "HEAD^1"]);
}

/** `git worktree list --porcelain`, parsed and nothing more — no base branch,
 *  no rev-list, no per-checkout status. The cheap half, for callers that only
 *  need to know which paths exist and what is checked out in them. */
function worktreeList(root: string): GitWorktree[] {
  const r = git(root, ["worktree", "list", "--porcelain"]);
  const out: GitWorktree[] = [];
  let cur: Partial<GitWorktree> | null = null;
  const flush = () => {
    if (cur && cur.path) out.push({ path: cur.path, branch: cur.branch || "(detached)", head: cur.head || "", current: cur.path === root, bare: !!cur.bare, locked: !!cur.locked });
    cur = null;
  };
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) { flush(); cur = { path: line.slice(9) }; }
    else if (!line) flush();
    else if (!cur) continue;
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5, 12);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace("refs/heads/", "");
    else if (line === "bare") cur.bare = true;
    else if (line === "detached") cur.branch = "(detached)";
    else if (line.startsWith("locked")) cur.locked = true;
  }
  flush();
  return out;
}

export async function worktrees(rootIn: unknown): Promise<GitWorktree[]> {
  const root = repoRoot(rootIn);
  if (!root) return [];
  const out = worktreeList(root);
  // How far each checkout has drifted from what it was branched off. One
  // rev-list per worktree, cached, and only for the ones on a real branch —
  // and all of them at once rather than one after another: seventeen serial
  // 200ms calls is the 1955ms this endpoint used to cost, all of it on the
  // thread carrying the terminal.
  await Promise.all(out.map(async (w) => {
    const base = w.branch === "(detached)" ? null : await baseOf(root, w.branch);
    w.base = base;
    w.behindBase = base ? await behindBase(root, w.branch, base) : 0;
  }));
  return out;
}

/**
 * The worktree list, plus how dirty each checkout is.
 *
 * Split from `worktrees()` because it costs a `git status` per checkout — a
 * dozen subprocesses on a worktree-heavy repo, which the repo picker already
 * pays for the same paths, but which callers like `discoverRepos` must not pay
 * twice. Run concurrently, so it's one status' worth of wall clock rather than
 * a dozen.
 *
 * The panel needs this for one reason: `syncFromBase` refuses to merge into a
 * dirty checkout, and a button that can only fail is worse than a disabled one.
 */
/**
 * Dirty counts, held briefly.
 *
 * `git status` per checkout is fifteen subprocesses on a worktree-heavy repo,
 * and even fully awaited that is fifteen spawns' worth of setup on the loop —
 * the last measurable cost in this endpoint once everything else was converted
 * (~200ms a call, on a 10s poll). The repo picker already statuses the same
 * paths on its own cache; this stops the two of them racing to re-derive the
 * same answer seconds apart.
 *
 * Short, and stretched by `backoff()` while a shell is in use: a dirty dot on a
 * checkout you are not looking at can be a few seconds old, and every write
 * clears it through run() anyway.
 */
const DIRTY_TTL_MS = 5_000;
const dirtyCache = new Map<string, { at: number; n: number }>();

export async function worktreesWithState(rootIn: unknown): Promise<GitWorktree[]> {
  const out = await worktrees(rootIn);
  const ttl = DIRTY_TTL_MS * backoff();
  await Promise.all(out.map(async (w) => {
    if (w.bare) return; // no working tree to be dirty
    const hit = dirtyCache.get(w.path);
    if (hit && Date.now() - hit.at < ttl) { w.dirty = hit.n; return; }
    const r = await gitAsync(w.path, ["status", "--porcelain"]);
    // A checkout whose directory was deleted from under git answers non-zero;
    // "unknown" is honest there, and leaves the button enabled rather than
    // silently blocking on a status we never got.
    if (r.code === 0) {
      w.dirty = r.stdout.split("\n").filter(Boolean).length;
      if (dirtyCache.size > 200) dirtyCache.clear();
      dirtyCache.set(w.path, { at: Date.now(), n: w.dirty });
    }
  }));
  return out;
}
/**
 * Where a new worktree is allowed to land.
 *
 * safeAbs alone accepts any absolute path, which would let a caller plant a
 * full checkout anywhere the server can write — a served web root, an autostart
 * directory. So this is an allowlist of two shapes, and only two:
 *
 *   * `<repo>-<name>` beside the repo — the sibling layout, which is what the
 *     panel's own "+ add worktree" has always sent (`${root}-${branch}`) and
 *     what a worktree-per-ticket setup looks like on disk. It was NOT accepted
 *     here, so that button answered "worktree path must be under
 *     <repo>/.worktrees/" every single time it was pressed, for every user,
 *     since the first release. The rule and its only caller disagreed, and the
 *     rule was the one nobody read.
 *   * `<repo>/.worktrees/<name>` — the nested layout, kept because it was the
 *     documented one. It has a cost the sibling layout doesn't: the directory
 *     is untracked, so the repo reports itself dirty forever after.
 *
 * A prefix test is enough for both because the name is a single path segment:
 * `dirname` of the candidate must be exactly the repo's parent (so `../..`
 * cannot climb) and the basename must start with the repo's own.
 */
function worktreeSpot(root: string, abs: string): boolean {
  const nested = resolve(root, ".worktrees");
  if (abs !== nested && abs.startsWith(nested + sep)) return true;
  const parent = dirname(root);
  return dirname(abs) === parent && basename(abs).startsWith(basename(root) + "-");
}

/**
 * `startPoint` is what the new branch is cut from — a remote branch, when the
 * Remotes tab is the one asking. Omitted it means HEAD, which is right for
 * "start a new card from where I am" and wrong for "give me a checkout of
 * somebody's branch", and those are the two things this call is used for.
 */
export function addWorktree(rootIn: string, pathIn: unknown, branch: string, newBranch: boolean, startPoint?: unknown): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  const abs = safeAbs(pathIn); if (!abs) return { ok: false, error: "invalid path" };
  if (!worktreeSpot(root, abs)) {
    return { ok: false, error: `worktree path must be ${basename(root)}-<name> beside the repo, or under ${basename(root)}/.worktrees/` };
  }
  if (!validRef(branch)) return { ok: false, error: "invalid branch name" };
  let from: string[] = [];
  if (startPoint != null && startPoint !== "") {
    if (typeof startPoint !== "string" || !validRef(startPoint)) return { ok: false, error: "invalid start point" };
    if (git(root, ["rev-parse", "--verify", "--quiet", startPoint]).code !== 0) return { ok: false, error: `${startPoint} does not exist here — fetch first` };
    from = [startPoint];
  }
  return run(root, newBranch ? ["worktree", "add", "-b", branch, abs, ...from] : ["worktree", "add", abs, branch]);
}
/**
 * Ignored paths that are output, not work — safe to leave out of "here is what
 * you lose", because deleting them costs a rebuild and nothing else.
 *
 * Deliberately short, and matched on whole path segments. Every name here is
 * one whose contents are reproducible from the repo by definition of the tool
 * that writes it. `dist`, `build`, `target`, `out` and `.cache` are NOT here
 * and are not oversights: they're plausible directory names for real sources in
 * a repo somebody else laid out, and the cost of being wrong is asymmetric —
 * over-listing makes a confirmation dialog longer, under-listing deletes work.
 */
const REBUILDABLE = new Set([
  "__pycache__", ".mypy_cache", ".ruff_cache", ".pytest_cache", ".tox",
  "node_modules", ".venv", "venv", ".turbo", ".parcel-cache", ".next",
  ".gradle", ".eggs", ".nyc_output", ".sass-cache", "htmlcov", "coverage",
  ".DS_Store",
]);
const rebuildable = (rel: string): boolean =>
  rel.split("/").some((seg) => REBUILDABLE.has(seg) || seg.endsWith(".egg-info")) ||
  /\.(pyc|pyo)$/.test(rel);

/**
 * How many paths a report names before it starts counting.
 *
 * Twelve, back when this filled a text `confirm()` and the list was only ever
 * read. It now fills a scrolling modal where each row is a thing you can TICK,
 * so anything past the cap is not merely unmentioned — it cannot be rescued at
 * all, and the count that replaces it offers no way to get at it. On a real
 * checkout twelve hid eight entries.
 *
 * Sixty scrolls fine and comfortably clears the worst checkout here (34).
 * Entries are sorted safe-and-small first, so a cap that does bite still bites
 * the build output rather than the notes.
 */
const LEFTOVERS_MAX = 60;
/** Ignored directories opened up to see what's inside — one git call each. */
const EXPAND_MAX = 8;
/** Above this, two same-sized files are called `differs` rather than read.
 *  Being wrong here only over-reports: it lists an entry that had nothing to
 *  lose, and refuses to pre-select it. Reading 12 MB to say "identical" is not
 *  worth blocking the dialog for. */
const COMPARE_MAX_BYTES = 2 * 1024 * 1024;
/** Files walked when measuring a directory. Past it the size is a floor, which
 *  is all the number is for — nobody needs `dist/` weighed precisely. */
const WALK_MAX = 4000;

/** How many children a wholly-ignored directory is broken into before it stays
 *  one row. Past this it is a build output or a dependency tree, and forty rows
 *  of it would bury the file the list exists for. */
const CHILDREN_MAX = 40;

/**
 * The immediate children of a directory git refused to look inside, as paths
 * relative to the worktree. Directories keep their trailing slash so the rest
 * of the pipeline treats them as directories.
 *
 * Falls back to the directory itself when it is too crowded to be worth
 * splitting, or unreadable — both of which have to keep the entry on the list
 * rather than drop it.
 */
function readOneLevel(worktree: string, dir: string): string[] {
  const rel = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  try {
    const kids = readdirSync(join(worktree, rel), { withFileTypes: true });
    if (!kids.length || kids.length > CHILDREN_MAX) return [dir];
    return kids.map((k) => `${rel}/${k.name}${k.isDirectory() ? "/" : ""}`);
  } catch { return [dir]; }
}

/** Entries walked looking for foreign owners before the answer becomes "at
 *  least this many". One is already enough to block the removal; the rest of
 *  the count is only there to make the message honest. */
const OWNER_SCAN_MAX = 20_000;

/**
 * Paths in this checkout that belong to somebody else.
 *
 * A repo built with docker-compose gets `tmp/`, `.mypy_cache/` and
 * `.ruff_cache/` written by a container running as root, straight into the
 * bind-mounted worktree. They are root:root on the host, so nothing the user
 * runs can delete them — and `git worktree remove --force` finds that out
 * halfway through, AFTER it has already deleted the worktree's registration.
 * What is left is a directory that is no longer a worktree of anything, with
 * some of its tracked files gone: measured on a real repo, 1450 files deleted
 * out of one checkout and its registration destroyed, while the root-owned
 * caches sat there untouched.
 *
 * So this is a precondition, not a diagnosis after the fact.
 *
 * Reported per top-level directory because that is the unit that gets fixed:
 * one `chown -R` on `tmp/` settles the four hundred files under it.
 */
export function foreignOwned(dir: string): BlockedByOwner | null {
  const me = typeof process.getuid === "function" ? process.getuid() : -1;
  if (me < 0) return null; // no uids to compare (Windows) — nothing to claim
  const tops = new Set<string>();
  const owners = new Set<string>();
  let count = 0, seen = 0, more = false;

  const walk = (abs: string, top: string): void => {
    if (seen >= OWNER_SCAN_MAX) { more = true; return; }
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (seen++ >= OWNER_SCAN_MAX) { more = true; return; }
      const child = join(abs, e.name);
      if (e.isSymbolicLink()) continue; // the link is ours even when the target isn't
      let st;
      try { st = statSync(child); } catch { continue; }
      if (st.uid !== me) {
        count++;
        tops.add(top || e.name);
        owners.add(String(st.uid));
        // No need to descend: the whole subtree goes in one chown, and walking
        // 30k root-owned cache files to raise a number nobody reads is waste.
        if (e.isDirectory()) continue;
      } else if (e.isDirectory()) {
        walk(child, top || e.name);
      }
    }
  };
  walk(dir, "");
  if (!count) return null;
  return {
    count, more,
    paths: [...tops].sort().slice(0, 12),
    // uid 0 is root everywhere; anything else is named by number, which is
    // still what `chown` wants.
    owners: [...owners].map((u) => (u === "0" ? "root" : `uid ${u}`)),
  };
}

/** The repository's main working checkout — where a rescued file belongs.
 *  `git worktree list` puts it first; that is its documented order, and it is
 *  the one entry whose `.git` is a real directory rather than a file. */
function mainCheckout(root: string): string {
  return worktreeList(root)[0]?.path ?? root;
}

/** Bytes under `p`, recursive, bounded. -1 when it can't be read at all. */
function sizeOf(p: string): number {
  try {
    const st = statSync(p);
    if (!st.isDirectory()) return st.size;
    let total = 0, seen = 0;
    const walk = (d: string): void => {
      if (seen >= WALK_MAX) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (seen++ >= WALK_MAX) return;
        const child = join(d, e.name);
        // Never follow a symlink out of the tree we're measuring.
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(child);
        else { try { total += statSync(child).size; } catch { /* vanished mid-walk */ } }
      }
    };
    walk(p);
    return total;
  } catch { return -1; }
}

/**
 * What the main checkout has at this path, and how big the worktree's copy is.
 *
 * "Same" has to mean byte-identical, because the entire consequence of the
 * answer is that the entry stops being shown at all. Size first (one stat, and
 * it settles most of them), contents only when the sizes match and the file is
 * small enough to be worth reading.
 *
 * Directories are never called "same": proving it means walking both trees, and
 * the answer that costs nothing — list it, don't pre-select it — is already the
 * safe one.
 */
async function compareToMain(main: string, worktree: string, rel: string): Promise<{ vsMain: "same" | "absent" | "differs"; bytes: number }> {
  const clean = rel.endsWith("/") ? rel.slice(0, -1) : rel;
  const mine = join(worktree, clean);
  const theirs = join(main, clean);
  const bytes = sizeOf(mine);
  let a, b;
  try { a = statSync(mine); } catch { return { vsMain: "absent", bytes }; }
  try { b = statSync(theirs); } catch { return { vsMain: "absent", bytes }; }
  if (a.isDirectory() || b.isDirectory()) return { vsMain: "differs", bytes };
  if (a.size !== b.size) return { vsMain: "differs", bytes };
  if (a.size > COMPARE_MAX_BYTES) return { vsMain: "differs", bytes };
  try {
    const [x, y] = await Promise.all([Bun.file(mine).arrayBuffer(), Bun.file(theirs).arrayBuffer()]);
    return { vsMain: Buffer.from(x).equals(Buffer.from(y)) ? "same" : "differs", bytes };
  } catch { return { vsMain: "differs", bytes }; }
}

/**
 * What `git worktree remove` would delete here that git would never warn about.
 *
 * The whole point is the ignored files. Git refuses to remove a worktree with
 * modified or untracked files, so those already have a guard; ignored ones have
 * none, and `remove` (no `--force`) deletes them silently — measured, not
 * assumed: a worktree whose only content is a gitignored `secrets.env` reports
 * `status --porcelain` empty and is removed with exit 0, file included.
 *
 * On a real checkout that is `compose/envs/*.env` and a page of local notes
 * sitting beside four hundred `__pycache__/` directories, so the ignored list
 * is filtered through REBUILDABLE — otherwise the noise buries the one line
 * that mattered, and a dialog nobody reads guards nothing.
 *
 * `--ignored` in its traditional mode, not `=matching`: it collapses an ignored
 * directory to one entry instead of listing every file under it, which is the
 * difference between 403 lines and 3356 on this repo, and 100ms of work.
 */
export async function worktreeLeftovers(rootIn: string, pathIn: unknown): Promise<WorktreeLeftovers> {
  const root = repoRoot(rootIn);
  const abs = safeAbs(pathIn);
  if (!root || !abs) return { path: String(pathIn ?? ""), entries: [], more: 0, skipped: 0, identical: 0, error: "invalid path" };
  // Only a path this repo actually owns as a worktree, so this can't be used to
  // enumerate arbitrary directories through the API.
  if (!worktreeList(root).some((w) => w.path === abs)) {
    return { path: abs, entries: [], more: 0, skipped: 0, identical: 0, error: "not a worktree of this repository" };
  }
  const r = await gitAsync(abs, ["-c", "core.quotePath=false", "status", "--porcelain=v1", "--ignored"]);
  // A directory git can't read is not an empty one. Say so, and let the caller
  // present it as a reason to keep the worktree rather than a green light.
  if (r.code !== 0) return { path: abs, entries: [], more: 0, skipped: 0, identical: 0, error: r.stderr.trim() || "could not read that checkout" };

  const parse = (out: string): { code: string; rel: string }[] =>
    out.split("\n").filter((l) => l.length >= 4).map((l) => ({
      code: l.slice(0, 2),
      // Quoted when the path has odd bytes in it; core.quotePath=false keeps
      // UTF-8 readable, and the quotes that remain are honest about the rest.
      rel: l.slice(3).replace(/^"|"$/g, ""),
    })).filter((e) => e.rel);

  const work: string[] = [];    // modified / untracked — git already guards these
  const ignored: string[] = []; // the ones nothing guards
  const dirs: string[] = [];    // ignored directories worth looking inside
  let skipped = 0;
  for (const { code, rel } of parse(r.stdout)) {
    if (code !== "!!") { work.push(rel); continue; }
    if (rebuildable(rel)) { skipped++; continue; }
    if (rel.endsWith("/")) dirs.push(rel); else ignored.push(rel);
  }

  // A directory whose every entry is ignored collapses to one line — `cfg/`,
  // not `cfg/local.env` and `cfg/__pycache__/`. That single line is both too
  // alarming and too vague: it can be nothing but a cache, or it can be the one
  // env file you needed, and it reads identically either way. So look inside
  // the ones we don't already recognise, one level, and let the names speak.
  //
  // Bounded, and only ever a handful in practice: a directory collapses only
  // when it holds nothing tracked at all. Past the cap the directory keeps its
  // own name in the list, which over-reports rather than under-reports.
  const expand = dirs.slice(0, EXPAND_MAX);
  ignored.push(...dirs.slice(EXPAND_MAX));
  const inner = await Promise.all(expand.map((d) =>
    gitAsync(abs, ["-c", "core.quotePath=false", "status", "--porcelain=v1", "--ignored=matching", "--", d])));
  for (let i = 0; i < expand.length; i++) {
    const dir = expand[i]!;
    const entries = inner[i]!.code === 0 ? parse(inner[i]!.stdout).filter((e) => e.code === "!!") : [];
    // Git will not descend when the ignore rule names the DIRECTORY — a
    // `.gitignore` line of `.specs/` makes `--ignored=matching -- .specs/`
    // answer `.specs/` again, forever. That is the common shape, and left here
    // it costs the whole feature: an undivided `.specs/` is "differs" against
    // the main checkout's own `.specs/`, so it can never be pre-ticked and the
    // rescue would refuse it as already-existing. The one file inside that
    // nobody has a copy of never gets offered.
    //
    // So when git says nothing new, read the directory. One level: deeper turns
    // a screenshots folder into forty rows, and the directory is the useful
    // unit anyway.
    const useful = entries.filter((e) => e.rel !== dir);
    if (!useful.length) { for (const child of readOneLevel(abs, dir)) { if (rebuildable(child)) skipped++; else ignored.push(child); } continue; }
    for (const { rel } of useful) { if (rebuildable(rel)) skipped++; else ignored.push(rel); }
  }

  // Now the question that turns a warning into an offer: what does the main
  // checkout already have at each of these paths? A worktree is a second copy
  // of the repo, so most of this list is a duplicate of a file sitting safely
  // in the main checkout — on the repo this was built for, 20 of 34.
  const main = mainCheckout(root);
  const entries: LeftoverEntry[] = [];
  let identical = 0;
  // Work git would have stopped for goes first: if there is any, the answer is
  // "don't do this" and it should be the first thing read.
  for (const rel of [...work, ...ignored]) {
    const cmp = await compareToMain(main, abs, rel);
    if (cmp.vsMain === "same") { identical++; continue; }
    entries.push({ path: rel, bytes: cmp.bytes, dir: rel.endsWith("/"), vsMain: cmp.vsMain });
  }
  // Safe-to-rescue first, then by size ascending. Notes are small and unique;
  // build output is large and already-there. Sorting this way is what stops a
  // 708K directory of screenshots hiding behind 22 MB of `dist/` in a list that
  // gets cut at twelve.
  entries.sort((a, b) =>
    Number(a.vsMain === "differs") - Number(b.vsMain === "differs") || a.bytes - b.bytes || a.path.localeCompare(b.path));
  // Asked here rather than at removal time so the dialog can say "this one
  // can't go" while there is still a decision to make about it.
  const blocked = foreignOwned(abs);
  return {
    path: abs, entries: entries.slice(0, LEFTOVERS_MAX),
    more: Math.max(0, entries.length - LEFTOVERS_MAX), skipped, identical,
    ...(blocked ? { blocked } : {}),
  };
}

/**
 * Copy chosen leftovers out of a worktree and into the main checkout, at the
 * same relative path, before the worktree is removed.
 *
 * The main checkout rather than an invented archive directory, because that is
 * where these files already live: this repo's `.specs/` in the main checkout
 * holds 157 of exactly these notes, and the worktree's three are simply the
 * ones that never made it back. A rescue folder would be a second place to
 * look for the same thing.
 *
 * Refuses to overwrite. That is the whole safety property: a "rescue" that
 * clobbers the main checkout's `tmp/` or `dist/` with the dying worktree's
 * version is the exact accident this feature exists to prevent, and it would
 * happen silently. Callers that genuinely want that must delete the target
 * themselves; there is no force flag, on purpose.
 *
 * Every path is re-derived from the worktree root here rather than trusted from
 * the request, so `../` in a relative path lands outside and is rejected rather
 * than reaching into the filesystem.
 */
export async function rescueLeftovers(rootIn: string, pathIn: unknown, relsIn: unknown): Promise<GitActionResult & { copied?: string[]; skipped?: { path: string; why: string }[] }> {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  const abs = safeAbs(pathIn); if (!abs) return { ok: false, error: "invalid path" };
  if (!worktreeList(root).some((w) => w.path === abs)) return { ok: false, error: "not a worktree of this repository" };
  const main = mainCheckout(root);
  if (main === abs) return { ok: false, error: "that is the main checkout — nothing to rescue it into" };
  if (!Array.isArray(relsIn)) return { ok: false, error: "no paths given" };
  const rels = relsIn.filter((r): r is string => typeof r === "string" && !!r).slice(0, 500);

  const copied: string[] = [];
  const skipped: { path: string; why: string }[] = [];
  for (const rel of rels) {
    const clean = rel.endsWith("/") ? rel.slice(0, -1) : rel;
    const from = resolve(abs, clean);
    const to = resolve(main, clean);
    // Both ends have to stay inside their tree. `resolve` has already collapsed
    // any `..`, so this catches it wherever it appeared in the string.
    if (from !== abs && !from.startsWith(abs + sep)) { skipped.push({ path: rel, why: "outside the worktree" }); continue; }
    if (to !== main && !to.startsWith(main + sep)) { skipped.push({ path: rel, why: "outside the main checkout" }); continue; }
    if (existsSync(to)) { skipped.push({ path: rel, why: "already exists in the main checkout" }); continue; }
    if (!existsSync(from)) { skipped.push({ path: rel, why: "no longer in the worktree" }); continue; }
    try {
      mkdirSync(dirname(to), { recursive: true });
      // `cp -R` rather than a hand-rolled walk: it is one spawn for a file or a
      // whole tree, and it preserves what a copy of somebody's notes should
      // preserve. `-n` is a second refusal to clobber behind the check above.
      const p = Bun.spawnSync(["cp", "-Rn", from, to], { stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) { skipped.push({ path: rel, why: p.stderr?.toString().trim() || "copy failed" }); continue; }
      // Look, rather than believe the exit code. `cp -n` returns 0 when it
      // declines to overwrite, and a caller about to delete the original needs
      // "it is there" to mean the file is there. Five screenshots were reported
      // copied, were not on disk, and the checkout holding them was removed
      // straight after — the cause is still unknown, so this closes the hole
      // the cause can come through.
      if (!existsSync(to)) { skipped.push({ path: rel, why: "copy reported success but nothing arrived" }); continue; }
      copied.push(rel);
    } catch (e) { skipped.push({ path: rel, why: String(e) }); }
  }
  return { ok: skipped.length === 0, copied, skipped, ...(skipped.length ? { error: `${skipped.length} of ${rels.length} not copied` } : {}) };
}

/**
 * Put back the administrative entry `git worktree remove` deletes first.
 *
 * Its removal is not atomic: the registration under `.git/worktrees/<name>`
 * goes before the files do, so a removal that fails partway — a root-owned
 * cache it cannot unlink — leaves a full directory that is no longer a worktree
 * of anything. `git worktree repair` does not help: it relinks a worktree that
 * MOVED, and refuses here because the directory it would point at is gone.
 *
 * Rebuilding it by hand is three small files and a `reset`, which is what git
 * itself writes. The reset restores the index from HEAD without touching the
 * working tree, so tracked files that survived stay exactly as they are and the
 * ones the failed removal did delete show up as deletions to restore, rather
 * than as a checkout nobody can read.
 */
function restoreRegistration(root: string, abs: string, branch: string): boolean {
  try {
    const dotgit = join(abs, ".git");
    if (!existsSync(dotgit)) return false;
    // The name git used, read back out of the worktree's own .git pointer, so
    // this cannot invent a different one.
    const ref = readFileSync(dotgit, "utf8").replace(/^gitdir:\s*/, "").trim();
    const name = basename(ref);
    if (!name) return false;
    const admin = join(gitDir(root) ?? join(root, ".git"), "worktrees", name);
    if (existsSync(admin)) return false; // still registered — nothing to undo
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, "gitdir"), `${dotgit}\n`);
    writeFileSync(join(admin, "commondir"), "../..\n");
    writeFileSync(join(admin, "HEAD"), branch && branch !== "(detached)" ? `ref: refs/heads/${branch}\n` : "");
    git(abs, ["reset", "-q"]);
    return true;
  } catch { return false; }
}

/**
 * Hand a worktree's files back to the user, through the system's own auth
 * dialog, so the removal it blocks can proceed.
 *
 * Three deliberate limits, because this is the only place in the app that
 * reaches root:
 *
 *   1. `pkexec`, not `sudo`. The password prompt is the desktop's, it shows the
 *      exact command being elevated, and this process never sees, stores or
 *      transports the password. An input of our own asking for a sudo password
 *      is the thing not to build, whatever it would save.
 *   2. `chown` and nothing else. Never `rm` as root. Root's job is to give the
 *      files back; the deletion still happens as the user afterwards, subject
 *      to every check that already exists. The worst outcome of a bug here is
 *      that a directory the user owns becomes a directory the user owns.
 *   3. The path is not taken from the caller. It has to match a worktree this
 *      repository currently reports, so a crafted request cannot point root at
 *      an arbitrary directory. Arguments go as an array — there is no shell to
 *      inject into.
 */
export function fixWorktreeOwnership(rootIn: string, pathIn: unknown): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  const abs = safeAbs(pathIn); if (!abs) return { ok: false, error: "invalid path" };
  // Only a path git itself vouches for, and never the checkout we are in.
  if (abs === root) return { ok: false, error: "that is the main checkout" };
  if (!worktreeList(root).some((w) => w.path === abs)) return { ok: false, error: "not a worktree of this repository" };
  if (!foreignOwned(abs)) return { ok: true, output: "already yours" };

  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const gid = typeof process.getgid === "function" ? process.getgid() : -1;
  if (uid < 0 || gid < 0) return { ok: false, error: "no user to hand ownership to on this platform" };

  const p = Bun.spawnSync(["pkexec", "chown", "-R", `${uid}:${gid}`, "--", abs], { stdout: "pipe", stderr: "pipe" });
  const err = p.stderr?.toString().trim() ?? "";
  if (p.exitCode === 126 || /dismissed|not authorized/i.test(err)) return { ok: false, error: "cancelled" };
  if (p.exitCode !== 0) return { ok: false, error: err || `pkexec exited ${p.exitCode}` };
  // Verified, not assumed: pkexec can succeed while chown skips something.
  const left = foreignOwned(abs);
  return left
    ? { ok: false, error: `still ${left.count}${left.more ? "+" : ""} files owned by ${left.owners.join(", ")}` }
    : { ok: true, output: "ownership restored" };
}

export function removeWorktree(rootIn: string, pathIn: unknown, force: boolean): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  const abs = safeAbs(pathIn); if (!abs) return { ok: false, error: "invalid path" };
  if (abs === root) return { ok: false, error: "can't remove the current worktree" };

  // Refuse rather than start something that cannot finish. Git deletes the
  // registration before the files, so "try it and see" is not free: the failure
  // mode is a directory that is no longer a worktree, missing some of its
  // tracked files, with the undeletable ones still sitting there.
  const blocked = foreignOwned(abs);
  if (blocked) {
    const what = blocked.paths.map((p) => `${basename(abs)}/${p}`).join(" ");
    return {
      ok: false,
      error: `${blocked.count}${blocked.more ? "+" : ""} files here belong to ${blocked.owners.join(", ")} — a container wrote them. `
        + `Nothing can delete them as you, and a partial removal would leave this directory orphaned.\n\n`
        + `Fix it first:\n  sudo chown -R "$(id -un):$(id -gn)" ${what}`,
    };
  }

  // The branch, captured while the worktree is still registered — it is what
  // the registration has to be rebuilt from if the removal fails anyway.
  const branch = worktreeList(root).find((w) => w.path === abs)?.branch ?? "";
  const r = run(root, force ? ["worktree", "remove", "--force", abs] : ["worktree", "remove", abs]);
  if (!r.ok && existsSync(abs) && restoreRegistration(root, abs, branch)) {
    return { ...r, error: `${r.error ?? "worktree remove failed"} — the worktree is still registered; nothing was left orphaned` };
  }
  return r;
}

export function checkout(rootIn: string, name: string): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  if (!validRef(name)) return { ok: false, error: "invalid branch name" };
  return run(root, ["checkout", name, "--"]); // -- so a name matching a tracked path can't silently revert that file
}
export function createBranch(rootIn: string, name: string): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  if (!validRef(name)) return { ok: false, error: "invalid branch name" };
  return run(root, ["checkout", "-b", name]); // create + switch
}
export function deleteBranch(rootIn: string, name: string, force: boolean): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  if (!validRef(name)) return { ok: false, error: "invalid branch name" };
  return run(root, ["branch", force ? "-D" : "-d", name]);
}

export function log(rootIn: unknown, limit = 100): GitCommit[] {
  const root = repoRoot(rootIn);
  if (!root) return [];
  const n = Math.max(1, Math.min(500, limit | 0));
  const fmt = `%H${US}%h${US}%s${US}%an${US}%ar${US}%D`;
  const r = git(root, ["log", `-n${n}`, `--pretty=format:${fmt}`]);
  const out: GitCommit[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const [hash, shortHash, subject, author, date, refs] = line.split(US);
    out.push({ hash, shortHash, subject: subject || "", author: author || "", date: date || "", refs: refs || "" });
  }
  return out;
}

/** The diff a single commit introduced (vs its first parent), as FileChanges. */
export function commitDiff(rootIn: unknown, hash: string): GitFileChange[] {
  const root = repoRoot(rootIn);
  if (!root || !validHash(hash)) return [];
  // vs first parent (matches the comment) + UTF-8 paths.
  const r = git(root, ["-c", "core.quotePath=false", "show", hash, "--no-color", "--first-parent", "--format=", "--unified=3"]);
  return parseDiff(root, r.stdout, false);
}

/** Configured remotes, with a branch count each so the list says something
 *  before you drill into it. `remote -v` lists fetch and push separately, and
 *  they differ on a fork setup (push to yours, fetch from upstream). */
export function remotes(rootIn: unknown): GitRemote[] {
  const root = repoRoot(rootIn);
  if (!root) return [];
  const counts = new Map<string, number>();
  for (const line of git(root, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"]).stdout.split("\n")) {
    const name = line.split("/")[0];
    // Count `origin/x`, never `origin` on its own.
    //
    // That bare line IS `refs/remotes/origin/HEAD`: `%(refname:short)` shortens
    // a remote's HEAD all the way down to the remote's name, so the obvious
    // guard — skipping refs that end in `/HEAD` — silently matches nothing.
    // It is a pointer at another ref in this same list, and remoteBranches()
    // drops it, so counting it made the tab claim 790 over a list of 789.
    if (name && line.includes("/") && !line.endsWith("/HEAD")) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const byName = new Map<string, GitRemote>();
  for (const line of git(root, ["remote", "-v"]).stdout.split("\n")) {
    // "origin\tgit@host:owner/repo.git (fetch)"
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!m) continue;
    const [, name, url, kind] = m;
    const cur = byName.get(name) ?? { name, fetchUrl: "", pushUrl: "", branches: counts.get(name) ?? 0 };
    if (kind === "fetch") cur.fetchUrl = url; else cur.pushUrl = url;
    byName.set(name, cur);
  }
  return [...byName.values()];
}

/**
 * The branches on one remote, newest first, each marked with whether you
 * already have it.
 *
 * Read from `refs/remotes/<remote>/*` — the last fetch's answer, not a live
 * call to the server. That is the honest thing to show: every other number in
 * this panel (ahead, behind, gone) is measured against exactly these refs, and
 * a list that quietly went and asked the network would disagree with all of
 * them.
 *
 * Sent whole rather than paged. 800 refs is one `for-each-ref` and ~100KB of
 * JSON; paging it server-side would mean a round trip per keystroke of the
 * search box, for a list the client can filter in a frame. The rendering side
 * is where the cost actually was, and useIncremental already handles that.
 *
 * `origin/HEAD` is dropped: it is a symbolic pointer at another row in this
 * same list, not a branch of its own.
 */
export function remoteBranches(rootIn: unknown, remoteIn: unknown, limit = 3000): { ok: boolean; remote: string; branches: GitRemoteBranch[]; error?: string } {
  const root = repoRoot(rootIn);
  if (!root) return { ok: false, remote: "", branches: [], error: "not a git repository root" };
  const remote = typeof remoteIn === "string" && remoteIn ? remoteIn : (remotes(root)[0]?.name ?? "");
  if (!remote) return { ok: true, remote: "", branches: [] };
  if (!validRef(remote) || remote.includes("/")) return { ok: false, remote: "", branches: [], error: "invalid remote" };

  // What you already have, so the list can answer "do I have this one" without
  // a call per row: local heads, what each one tracks, and which checkout has
  // it out.
  const localTracks = new Map<string, string>(); // local branch -> its upstream
  for (const line of git(root, ["for-each-ref", `--format=%(refname:short)${US}%(upstream:short)`, "refs/heads"]).stdout.split("\n")) {
    if (!line) continue;
    const [name, upstream] = line.split(US);
    if (name) localTracks.set(name, upstream || "");
  }
  const checkedOut = new Map<string, string>(); // branch -> worktree path
  for (const w of worktreeList(root)) if (w.branch && w.branch !== "(detached)") checkedOut.set(w.branch, w.path);

  const n = Math.max(1, Math.min(10_000, limit | 0));
  const fmt = `%(refname:short)${US}%(objectname:short)${US}%(contents:subject)${US}%(authorname)${US}%(committerdate:relative)`;
  const r = git(root, ["-c", "core.quotePath=false", "for-each-ref", "--sort=-committerdate", `--count=${n}`, `refs/remotes/${remote}`, `--format=${fmt}`]);
  const branches: GitRemoteBranch[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const [ref, hash, subject, author, date] = line.split(US);
    if (!ref || !ref.startsWith(remote + "/")) continue;
    const name = ref.slice(remote.length + 1);
    if (!name || name === "HEAD") continue;
    const upstream = localTracks.get(name);
    branches.push({
      name, ref, hash: hash || "", subject: subject || "", author: author || "", date: date || "",
      local: upstream !== undefined,
      tracking: upstream === ref,
      ...(checkedOut.has(name) ? { worktree: checkedOut.get(name)! } : {}),
    });
  }
  return { ok: true, remote, branches };
}

/**
 * Make a remote branch local: a branch of the same name, tracking it.
 *
 * `switch` decides whether this checkout moves onto it. Both exist because both
 * are wanted — "let me look at this PR" wants the switch, and "grab it, I'll
 * open it in a worktree later" must not yank the working tree out from under
 * an agent that is mid-edit.
 *
 * Refuses when the local name is taken rather than silently reusing it: the
 * existing branch may be a *different* branch that happens to share a name, and
 * the difference between checking that out and checking out the remote's
 * version is somebody's afternoon.
 */
export function trackRemoteBranch(rootIn: unknown, refIn: unknown, opts: { switch?: boolean } = {}): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  const ref = typeof refIn === "string" ? refIn : "";
  if (!validRef(ref) || !ref.includes("/")) return { ok: false, error: "invalid remote branch" };
  // The remote prefix has to be a real remote, or "origin/feature/x" and a
  // local branch literally called that are indistinguishable.
  const remote = ref.slice(0, ref.indexOf("/"));
  if (!remotes(root).some((r) => r.name === remote)) return { ok: false, error: `no remote called ${remote}` };
  const name = ref.slice(remote.length + 1);
  if (!name || name === "HEAD" || !validRef(name)) return { ok: false, error: "invalid branch name" };
  if (git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/${ref}`]).code !== 0) {
    return { ok: false, error: `${ref} is not here — fetch first` };
  }
  if (git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).code === 0) {
    return { ok: false, error: `you already have a local ${name} — check it out from the Branches tab` };
  }
  return opts.switch
    ? run(root, ["switch", "-c", name, "--track", ref])
    : run(root, ["branch", "--track", name, ref]);
}

/** Tags, newest first. `creatordate` rather than `taggerdate` so lightweight
 *  tags — which have no tagger — sort by their commit instead of sorting last. */
export function tags(rootIn: unknown, limit = 300): GitTag[] {
  const root = repoRoot(rootIn);
  if (!root) return [];
  const fmt = `%(refname:short)${US}%(objecttype)${US}%(contents:subject)${US}%(creatordate:relative)${US}%(objectname:short)`;
  const r = git(root, ["for-each-ref", "--sort=-creatordate", `--count=${Math.max(1, Math.min(1000, limit | 0))}`, "refs/tags", `--format=${fmt}`]);
  const out: GitTag[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const [name, type, subject, date, hash] = line.split(US);
    out.push({ name, subject: subject || "", date: date || "", hash: hash || "", annotated: type === "tag" });
  }
  return out;
}

/**
 * Where HEAD has been — the trail that makes a bad reset or rebase recoverable.
 *
 * The action is split out from the message because it's the useful column: a
 * list of "commit / rebase (finish) / reset" tells you what happened at a
 * glance, and it's how you find the commit you were on before things went
 * wrong. `%gs` is "reset: moving to HEAD~3", so the action is everything up to
 * the first colon.
 */
export function reflog(rootIn: unknown, limit = 200): GitReflogEntry[] {
  const root = repoRoot(rootIn);
  if (!root) return [];
  const n = Math.max(1, Math.min(1000, limit | 0));
  const fmt = `%gD${US}%h${US}%gs${US}%ar`;
  const r = git(root, ["reflog", `-n${n}`, `--pretty=format:${fmt}`]);
  const out: GitReflogEntry[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const [ref, shortHash, gs, date] = line.split(US);
    const at = (gs || "").indexOf(":");
    out.push({
      ref: ref || "", shortHash: shortHash || "", date: date || "",
      action: at === -1 ? (gs || "") : gs.slice(0, at),
      subject: at === -1 ? "" : gs.slice(at + 1).trim(),
    });
  }
  return out;
}

export function stashList(rootIn: unknown): GitStash[] {
  const root = repoRoot(rootIn);
  if (!root) return [];
  const r = git(root, ["stash", "list", `--format=%gd${US}%gs`]);
  const out: GitStash[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const [ref, message] = line.split(US);
    const m = ref.match(/stash@\{(\d+)\}/);
    out.push({ index: m ? Number(m[1]) : out.length, ref, message: message || "" });
  }
  return out;
}
export function stashPush(rootIn: string, message: string): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  const args = ["stash", "push", "--include-untracked"];
  if (message && message.trim()) args.push("-m", message.trim());
  return run(root, args);
}
function stashOp(rootIn: string, op: "apply" | "pop" | "drop", index: number): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  if (!Number.isInteger(index) || index < 0 || index > 999) return { ok: false, error: "invalid stash index" };
  return run(root, ["stash", op, `stash@{${index}}`]);
}
export const stashApply = (r: string, i: number) => stashOp(r, "apply", i);
export const stashPop = (r: string, i: number) => stashOp(r, "pop", i);
export const stashDrop = (r: string, i: number) => stashOp(r, "drop", i);

// --- interactive hunk staging (lazygit's signature) --------------------------
function gitApplyStdin(root: string, args: string[], patch: string): { code: number; stderr: string } {
  try {
    const proc = Bun.spawnSync(["git", "-C", root, ...args], { stdin: new TextEncoder().encode(patch), stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    return { code: proc.exitCode ?? 1, stderr: proc.stderr?.toString() ?? "" };
  } catch (e) { return { code: 1, stderr: String(e) }; }
}

type HunkIn = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };

/** Stage / unstage / discard a single hunk by re-applying a one-hunk patch. */
export function applyHunk(rootIn: string, pathAbs: unknown, staged: boolean, action: "stage" | "unstage" | "discard", hunk: HunkIn): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  const abs = safeAbs(pathAbs); if (!abs) return { ok: false, error: "invalid path" };
  const rel = relative(root, abs);
  if (!inRepo(root, rel)) return { ok: false, error: "path escapes repo" };
  if (!hunk || !Array.isArray(hunk.lines) || !hunk.lines.length) return { ok: false, error: "invalid hunk" };
  // Every line must be a real diff body line (context/add/del/no-newline) — this
  // stops a crafted request smuggling extra `diff --git`/`@@`/`---` headers into
  // the reconstructed patch to retarget other files.
  for (const l of hunk.lines) if (typeof l !== "string" || !l.length || !" +-\\".includes(l[0])) return { ok: false, error: "invalid hunk line" };
  const nums = [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines];
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return { ok: false, error: "invalid hunk header" };

  const patch =
    `diff --git a/${rel} b/${rel}\n--- a/${rel}\n+++ b/${rel}\n` +
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n` +
    hunk.lines.join("\n") + "\n";

  // stage: apply to index; unstage: reverse-apply the staged hunk from index;
  // discard: reverse-apply the working-tree hunk.
  const args =
    action === "stage" ? ["apply", "--cached", "--recount"]
      : action === "unstage" ? ["apply", "--cached", "--reverse", "--recount"]
      : action === "discard" ? ["apply", "--reverse", "--recount"]
      : null;
  if (!args) return { ok: false, error: "invalid action" };
  void staged;
  const r = gitApplyStdin(root, args, patch);
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || "git apply failed (the hunk may no longer apply cleanly)" };
  return { ok: true, output: `${action}d hunk` };
}


/* ------------------------------------------------- conflicts, block by block */

/**
 * One `<<<<<<< / ======= / >>>>>>>` region, and the file around it.
 *
 * Whole-file `ours`/`theirs` covers a lockfile or a generated migration, but it
 * is the wrong tool the moment a file has two unrelated conflicts — taking one
 * side wholesale to fix the first silently discards your work in the second.
 * That is the failure this exists to prevent: not a finer-grained version of
 * the same feature, but the case where the existing one loses code.
 */

const C_START = /^<<<<<<< ?(.*)$/;
const C_BASE = /^\|\|\|\|\|\|\| ?(.*)$/;
const C_MID = /^=======\s*$/;
const C_END = /^>>>>>>> ?(.*)$/;

/**
 * Parse a conflicted file into blocks and the text between them.
 *
 * Returns segments rather than only the blocks so that resolving is a rebuild
 * rather than an edit: reassembling from the parts cannot drift from what was
 * shown, whereas patching the original by line number can if anything touched
 * the file in between.
 */
function splitConflicts(text: string): { segments: (string | ConflictBlock)[]; blocks: ConflictBlock[] } {
  const lines = text.split("\n");
  const segments: (string | ConflictBlock)[] = [];
  const blocks: ConflictBlock[] = [];
  let plain: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = C_START.exec(lines[i]!);
    if (!m) { plain.push(lines[i]!); continue; }

    const ours: string[] = [], theirs: string[] = [];
    let base: string[] | undefined;
    let side: "ours" | "base" | "theirs" = "ours";
    let theirLabel = "";
    const startLine = i + 1;
    let closed = false;

    for (i++; i < lines.length; i++) {
      const l = lines[i]!;
      if (C_BASE.test(l)) { side = "base"; base = []; continue; }
      if (C_MID.test(l)) { side = "theirs"; continue; }
      const e = C_END.exec(l);
      if (e) { theirLabel = e[1] ?? ""; closed = true; break; }
      (side === "ours" ? ours : side === "base" ? base! : theirs).push(l);
    }

    // An unterminated marker is not a conflict, it is a file that happens to
    // contain the characters — a diff pasted into a README, or this source
    // file. Kept as ordinary text instead of swallowing the rest of the
    // document into a block nobody can resolve.
    if (!closed) {
      plain.push(lines[startLine - 1]!);
      for (const l of ours) plain.push(l);
      if (base) { plain.push("|||||||"); for (const l of base) plain.push(l); }
      if (side === "theirs") plain.push("=======");
      for (const l of theirs) plain.push(l);
      continue;
    }

    const block: ConflictBlock = {
      index: blocks.length, line: startLine, ours, theirs,
      ...(base ? { base } : {}),
      ourLabel: m[1] || "ours", theirLabel: theirLabel || "theirs",
    };
    segments.push(plain.join("\n"));
    plain = [];
    segments.push(block);
    blocks.push(block);
  }
  segments.push(plain.join("\n"));
  return { segments, blocks };
}

export function conflictBlocks(rootIn: unknown, relIn: unknown): {
  ok: boolean; blocks: ConflictBlock[]; error?: string;
} {
  const root = repoRoot(rootIn); if (!root) return { ok: false, blocks: [], error: "not a git repository root" };
  const rels = validRels(root, [relIn]);
  if (!rels?.length) return { ok: false, blocks: [], error: "invalid path" };
  let text: string;
  try { text = readFileSync(join(root, rels[0]!), "utf8"); }
  catch { return { ok: false, blocks: [], error: "cannot read that file" }; }
  // A binary file has no lines to choose between, so whole-file is the only
  // resolution — saying so beats rendering its bytes as a diff.
  if (text.includes("\u0000")) return { ok: false, blocks: [], error: "binary file — resolve it whole" };
  return { ok: true, blocks: splitConflicts(text).blocks };
}


/**
 * Write one decision per block, then stage the file.
 *
 * The choice count must match what is in the file. A client holding a stale
 * parse would otherwise apply choice N to a block that is no longer the Nth —
 * resolving the wrong conflict with the wrong side, and looking like it worked.
 * Refusing costs a reload; guessing costs code.
 */
export function resolveBlocks(rootIn: unknown, relIn: unknown, choicesIn: unknown): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  const rels = validRels(root, [relIn]);
  if (!rels?.length) return { ok: false, error: "invalid path" };
  if (!Array.isArray(choicesIn)) return { ok: false, error: "choices must be a list" };
  const allowed = new Set(["ours", "theirs", "both", "theirs-first"]);
  if (!choicesIn.every((c) => typeof c === "string" && allowed.has(c))) return { ok: false, error: "unknown choice" };
  const choices = choicesIn as BlockChoice[];

  const abs = join(root, rels[0]!);
  let text: string;
  try { text = readFileSync(abs, "utf8"); } catch { return { ok: false, error: "cannot read that file" }; }
  const { segments, blocks } = splitConflicts(text);
  if (blocks.length !== choices.length) {
    return { ok: false, error: `the file has ${blocks.length} conflicts, not ${choices.length} — reload it` };
  }
  if (!blocks.length) return { ok: false, error: "no conflicts left in that file" };

  const out = segments.map((seg) => {
    if (typeof seg === "string") return seg;
    const c = choices[seg.index]!;
    const lines = c === "ours" ? seg.ours
      : c === "theirs" ? seg.theirs
      : c === "both" ? [...seg.ours, ...seg.theirs]
      : [...seg.theirs, ...seg.ours];
    return lines.join("\n");
  }).join("\n");

  try { writeFileSync(abs, out); } catch { return { ok: false, error: "cannot write that file" }; }
  return run(root, ["add", "--", rels[0]!]);
}
