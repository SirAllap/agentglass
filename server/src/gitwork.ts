// Live git working-tree adapter — the backend for agentglass's lazygit-style
// Source Control panel. Everything reads the repo on disk RIGHT NOW (never the
// telemetry snapshot). All git calls are arg-array spawns scoped with `-C root`
// (never a shell string); paths are validated to stay inside the repo root; and
// every mutating op is gated by AGENTGLASS_GIT_WRITE_DISABLED=1.

import { resolve, basename, relative, dirname, sep, join } from "node:path";
import { statSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { git, gitAsync, safeAbs, repoRootOf, currentBranch } from "./git.ts";
import { configuredRepoDirs, workspaceRoot, inScope } from "./config.ts";
import { worktreeParent, gitDir } from "./worktree.ts";
import type {
  GitFileChange, GitBranchInfo, WorkingTree, GitRepoRef, GitActionResult, DiffHunk, GitFileStatus,
  GitBranch, GitCommit, GitStash, GitWorktree, GitGraphLine, GitTreeState,
  GitRemote, GitTag, GitReflogEntry,
} from "../../shared/types.ts";

export const GIT_WRITE_ENABLED = process.env.AGENTGLASS_GIT_WRITE_DISABLED !== "1";
const UNTRACKED_MAX_BYTES = 512 * 1024; // don't inline-diff huge new files

/** Validate that `root` is the top-level of a git repo; return the abs root. */
function repoRoot(root: unknown): string | null {
  const abs = safeAbs(root);
  if (!abs) return null;
  const top = git(abs, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return null;
  const t = top.stdout.trim();
  return t || null;
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
function untracked(root: string): GitFileChange[] {
  const r = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
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

function branchInfo(root: string): GitBranchInfo {
  const name = currentBranch(root);
  const detached = name === "(detached)";
  const upstream = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).stdout.trim() || null;
  let ahead = 0, behind = 0;
  if (upstream) {
    const c = git(root, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]).stdout.trim().split(/\s+/);
    behind = Number(c[0]) || 0;
    ahead = Number(c[1]) || 0;
  }
  return { name, upstream, ahead, behind, detached, state: treeState(root) };
}

/** Full working-tree state for one repo. */
export function workingTree(rootIn: unknown): WorkingTree {
  const root = repoRoot(rootIn);
  if (!root) {
    return { root: String(rootIn ?? ""), branch: { name: "", upstream: null, ahead: 0, behind: 0, detached: false }, staged: [], unstaged: [], clean: true, writeEnabled: GIT_WRITE_ENABLED, error: "not a git repository" };
  }
  const staged = parseDiff(root, git(root, ["-c", "core.quotePath=false", "diff", "--cached"]).stdout, true);
  const unstaged = [...parseDiff(root, git(root, ["-c", "core.quotePath=false", "diff"]).stdout, false), ...untracked(root)];
  return {
    root, branch: branchInfo(root), staged, unstaged,
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
async function repoRef(root: string): Promise<GitRepoRef | null> {
  const r = await gitAsync(root, ["status", "--porcelain=v1", "--branch"]);
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
    ...(parent ? { worktreeOf: parent } : {}),
  };
}

// Opening git, terminal and chat each asks for the same list, and a user
// flipping between panels asks again seconds later. The answer is a directory
// sweep plus a git call per repo, so it's worth holding briefly — short enough
// that a branch switch or a new file shows up almost immediately.
const REPO_CACHE_MS = 5_000;
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
}

export async function discoverRepos(paths: string[], knownRoots: string[] = [], opts: { ignoreScope?: boolean } = {}): Promise<GitRepoRef[]> {
  // The workspace is part of the key: switching projects at runtime must not
  // serve the old scope's answer for the next five seconds.
  const key = [opts.ignoreScope ? "*" : workspaceRoot() ?? "", ...knownRoots].join("\\0");
  const hit = repoCache.get(key);
  if (hit && Date.now() - hit.at < REPO_CACHE_MS) return hit.repos;
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
      ? [self, ...worktrees(self).map((w) => w.path).filter((p) => p && p !== self)]
      : reposUnder(only1);
    const refs = await Promise.all(found.map((r) => repoRef(r)));
    const scoped = refs.filter((r): r is GitRepoRef => !!r);
    // The project itself first, then its worktrees. Dirtiest-first is the right
    // order among peers, but it shouldn't bury the main checkout behind a
    // worktree that happens to have more edits open — the dropdown is read as
    // "the project, and the branches I have checked out beside it".
    scoped.sort((a, b) =>
      Number(!!a.worktreeOf) - Number(!!b.worktreeOf) || b.dirty - a.dirty || a.name.localeCompare(b.name));
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
  const bases = only.length ? only : codeRootsOf(knownRoots);
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
  // Families stay together, dirtiest family first, the project ahead of its own
  // worktrees. Sorting the flat list by dirty count alone scatters a repo's
  // checkouts through the dropdown, so `orbit` and `orbit-WEB-1042` end up
  // pages apart — the one arrangement that makes a worktree look like an
  // unrelated project, which is the confusion this whole change is about.
  const family = (r: GitRepoRef) => r.worktreeOf ?? r.root;
  const rank = new Map<string, { dirty: number; name: string }>();
  for (const r of scoped) {
    const f = family(r);
    const cur = rank.get(f);
    // The family's name comes from the project itself, not from whichever
    // worktree happens to sort first.
    if (!cur || (!r.worktreeOf && cur.name !== r.name) || r.dirty > cur.dirty) {
      rank.set(f, { dirty: Math.max(cur?.dirty ?? 0, r.dirty), name: r.worktreeOf ? cur?.name ?? r.name : r.name });
    }
  }
  scoped.sort((a, b) => {
    const fa = family(a), fb = family(b);
    if (fa !== fb) {
      const ra = rank.get(fa)!, rb = rank.get(fb)!;
      return rb.dirty - ra.dirty || ra.name.localeCompare(rb.name);
    }
    return Number(!!a.worktreeOf) - Number(!!b.worktreeOf) || b.dirty - a.dirty || a.name.localeCompare(b.name);
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
    const proc = Bun.spawn(["git", "-C", root, "fetch", "--all", "--prune", "--quiet"], {
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS_REQUIRE: "never" },
    });
    const timer = setTimeout(() => proc.kill(), 20_000);
    await proc.exited;
    clearTimeout(timer);
    // A fetch moves origin/*, which is exactly what "merged into the trunk" is
    // measured against.
    invalidateMerged(root);
  } catch {
    // Offline, no remote, no credentials — all ordinary. The counts simply stay
    // where they were, which is the same as the old behaviour.
  } finally {
    fetching = false;
  }
}

export function startAutoFetch(): void {
  if (AUTO_FETCH_MS <= 0) return; // AGENTGLASS_AUTOFETCH_SECONDS=0 turns it off
  setInterval(autoFetchOnce, AUTO_FETCH_MS).unref?.();
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
 * Four spawns per branch, so this can't run over every branch of a big repo on
 * a 2.5s poll. The branches anyone is actually trying to delete are the recent
 * ones, so probe those and leave the tail to the ancestry answer. A branch past
 * the cap reads as unmerged, which is the safe direction to be wrong in: it
 * keeps its confirmation prompt instead of losing it.
 */
const SQUASH_PROBE_MAX = 20;

/** How long a completed squash sweep is trusted. Far longer than the ancestry
 *  TTL because it costs ~5 spawns per branch: re-running it every 30s burns a
 *  second of CPU to learn nothing, and anything that could change the answer
 *  calls invalidateMerged() anyway. */
const SQUASH_TTL_MS = 5 * 60_000;
/** Keys whose sweep has finished, and when. Separate from mergedCache so the
 *  cheap ancestry answer can keep refreshing on its own clock. */
const squashAt = new Map<string, number>();
/** Keys with a sweep in flight, so a burst of polls starts one, not ten. */
const squashRunning = new Set<string>();

function mergedInto(root: string, ref: string): Set<string> {
  // \u0000 rather than a raw NUL byte: written literally it makes the whole
  // file `data` to grep, which then skips it silently — you get no matches
  // and no warning. Same separator, same keys, still greppable.
  const key = `${root}\u0000${ref}`;
  const hit = mergedCache.get(key);
  if (hit && Date.now() - hit.at < MERGED_TTL_MS) return hit.set;
  const r = git(root, ["for-each-ref", "--merged", ref, "refs/heads", "--format=%(refname:short)"]);
  const set = new Set(r.stdout.split("\n").filter(Boolean));
  mergedCache.set(key, { at: Date.now(), set });
  sweepSquashed(root, ref, key, set);
  return set;
}

/**
 * Recover the squash merges ancestry can't see — off the request path.
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
 * place, so the next poll serves the fuller answer with no extra request.
 *
 * Newest first: that's the order for-each-ref gives with this sort, and the
 * order that spends the probe budget where deletes actually happen.
 */
function sweepSquashed(root: string, ref: string, key: string, set: Set<string>): void {
  if (squashRunning.has(key)) return;
  const done = squashAt.get(key);
  if (done && Date.now() - done < SQUASH_TTL_MS) return;
  squashRunning.add(key);

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
  let all: string[] = [];
  const step = () => {
    try {
      if (!all.length) {
        all = git(root, ["for-each-ref", "--sort=-committerdate", "refs/heads", "--format=%(refname:short)"])
          .stdout.split("\n").filter(Boolean);
      }
      while (idx < all.length) {
        const name = all[idx++]!;
        if (set.has(name)) continue;
        if (probes++ >= SQUASH_PROBE_MAX) { idx = all.length; break; }
        // Mutates the Set the cache entry already holds, so the next read sees
        // the fuller answer without another sweep.
        if (isSquashMerged(root, ref, name)) set.add(name);
        setTimeout(step, 0); // one probe per turn of the loop
        return;
      }
      squashAt.set(key, Date.now());
      squashRunning.delete(key);
    } catch {
      // A failed sweep just leaves the ancestry answer standing.
      squashRunning.delete(key);
    }
  };
  setTimeout(step, 0);
}


/** Drop the cache after anything that can change what's merged, so the panel
 *  reflects your own action immediately rather than up to a TTL later. */
export function invalidateMerged(root?: string): void {
  // Both maps, always. The sweep stamp has a far longer TTL than the ancestry
  // entry, so clearing only the latter would hand the rebuilt entry a "swept
  // recently" mark and skip the squash pass for minutes — exactly the window
  // after a merge, when the answer has just changed.
  if (!root) { mergedCache.clear(); squashAt.clear(); return; }
  for (const k of mergedCache.keys()) if (k.startsWith(`${root}\u0000`)) mergedCache.delete(k);
  for (const k of squashAt.keys()) if (k.startsWith(`${root}\u0000`)) squashAt.delete(k);
}


export function branches(rootIn: unknown): { current: string; branches: GitBranch[]; trunk: string | null } {
  const root = repoRoot(rootIn);
  if (!root) return { current: "", branches: [], trunk: null };
  const fmt = `%(refname:short)${US}%(HEAD)${US}%(upstream:short)${US}%(upstream:track)${US}%(committerdate:relative)${US}%(contents:subject)`;
  const r = git(root, ["for-each-ref", "--sort=-committerdate", "refs/heads", `--format=${fmt}`]);
  const trunk = defaultBranch(root);
  const merged = trunk ? mergedInto(root, trunk) : null;
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

/** `git log --graph` rendered to rows: the graph glyphs plus commit fields
 *  (graph-only connector rows carry just `graph`). */
export function logGraph(rootIn: unknown, limit = 400): { lines: GitGraphLine[] } {
  const root = repoRoot(rootIn);
  if (!root) return { lines: [] };
  const n = Math.max(1, Math.min(2000, limit | 0));
  // NUL can't go in an argv string (execve truncates at it), so use the same
  // \x1f unit-separator the branch code uses — safe in args, absent from commits.
  const fmt = `${US}%h${US}%an${US}%ar${US}%s${US}%D`;
  const r = git(root, ["-c", "core.quotePath=false", "log", "--graph", "--all", "--date=relative", `-n${n}`, `--format=${fmt}`]);
  const lines: GitGraphLine[] = [];
  for (const raw of r.stdout.split("\n")) {
    if (!raw) continue;
    const i = raw.indexOf(US);
    if (i === -1) { lines.push({ graph: raw }); continue; }
    const [hash, author, date, subject, refs] = raw.slice(i + 1).split(US);
    lines.push({ graph: raw.slice(0, i), hash, author, date, subject, refs });
  }
  return { lines };
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
export function baseOf(root: string, branch: string): string | null {
  if (!branch || branch === "(detached)") return null;
  const cfg = git(root, ["config", "--get", `branch.${branch}.agentglassbase`]).stdout.trim();
  if (cfg && validRef(cfg) && git(root, ["rev-parse", "--verify", "--quiet", cfg]).code === 0) return cfg;
  const trunk = defaultBranch(root);
  // A branch is not its own base; the trunk checkout simply has none.
  if (!trunk || trunk === branch || trunk.replace(/^origin\//, "") === branch) return null;
  return trunk;
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
export function behindBase(root: string, branch: string, base: string): number {
  const key = `${root}\u0000${branch}\u0000${base}`;
  const hit = behindCache.get(key);
  if (hit && Date.now() - hit.at < BEHIND_TTL_MS) return hit.n;
  const r = git(root, ["rev-list", "--count", `${branch}..${base}`]);
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
export function syncFromBase(dirIn: unknown, baseIn?: unknown): GitActionResult {
  const dir = repoRoot(dirIn); if (!dir) return { ok: false, error: "not a git repository root" };
  const g = guard(dir); if (g) return g;
  const branch = currentBranch(dir);
  if (!branch || branch === "(detached)") return { ok: false, error: "this checkout is not on a branch" };
  const base = typeof baseIn === "string" && baseIn ? baseIn : baseOf(dir, branch);
  if (!base) return { ok: false, error: "no base branch is known for this checkout" };
  if (!validRef(base)) return { ok: false, error: "invalid base" };
  // Refuse on a dirty tree rather than merging over uncommitted work: git would
  // usually stop anyway, but "usually" is not a promise worth making with
  // somebody's changes.
  if (git(dir, ["status", "--porcelain"]).stdout.trim()) return { ok: false, error: "commit or stash your changes first" };
  return run(dir, ["merge", "--no-edit", base]);
}

export function worktrees(rootIn: unknown): GitWorktree[] {
  const root = repoRoot(rootIn);
  if (!root) return [];
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
  // How far each checkout has drifted from what it was branched off. One
  // rev-list per worktree, cached, and only for the ones on a real branch.
  for (const w of out) {
    const base = w.branch === "(detached)" ? null : baseOf(root, w.branch);
    w.base = base;
    w.behindBase = base ? behindBase(root, w.branch, base) : 0;
  }
  return out;
}
export function addWorktree(rootIn: string, pathIn: unknown, branch: string, newBranch: boolean): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  const abs = safeAbs(pathIn); if (!abs) return { ok: false, error: "invalid path" };
  // Confine the checkout to the repo's own .worktrees/. safeAbs alone accepts
  // any absolute path, which let a caller plant a full checkout anywhere it
  // could write — a served web root, an autostart dir. A worktree belongs under
  // its repo; nothing legitimate needs it elsewhere.
  const wtBase = resolve(root, ".worktrees");
  if (abs !== wtBase && !abs.startsWith(wtBase + sep)) {
    return { ok: false, error: "worktree path must be under <repo>/.worktrees/" };
  }
  if (!validRef(branch)) return { ok: false, error: "invalid branch name" };
  return run(root, newBranch ? ["worktree", "add", "-b", branch, abs] : ["worktree", "add", abs, branch]);
}
export function removeWorktree(rootIn: string, pathIn: unknown, force: boolean): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  const abs = safeAbs(pathIn); if (!abs) return { ok: false, error: "invalid path" };
  if (abs === root) return { ok: false, error: "can't remove the current worktree" };
  return run(root, force ? ["worktree", "remove", "--force", abs] : ["worktree", "remove", abs]);
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
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
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
