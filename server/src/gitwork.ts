// Live git working-tree adapter — the backend for agentglass's lazygit-style
// Source Control panel. Everything reads the repo on disk RIGHT NOW (never the
// telemetry snapshot). All git calls are arg-array spawns scoped with `-C root`
// (never a shell string); paths are validated to stay inside the repo root; and
// every mutating op is gated by AGENTGLASS_GIT_WRITE_DISABLED=1.

import { resolve, basename, relative, dirname, sep } from "node:path";
import { statSync, readFileSync, readdirSync } from "node:fs";
import { git, gitAsync, safeAbs, repoRootOf, currentBranch } from "./git.ts";
import { configuredRepoDirs, workspaceRoot, inScope } from "./config.ts";
import type {
  GitFileChange, GitBranchInfo, WorkingTree, GitRepoRef, GitActionResult, DiffHunk, GitFileStatus,
  GitBranch, GitCommit, GitStash, GitWorktree, GitGraphLine,
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
  return { name, upstream, ahead, behind, detached };
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
 *  process count for data already in hand. ahead/behind stays 0 here; the
 *  header computes the real values for the selected repo via workingTree(). */
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
  return { root, name: basename(root), branch, dirty: lines.length - (head ? 1 : 0), ahead: 0, behind: 0 };
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
    scoped.sort((a, b) => b.dirty - a.dirty || a.name.localeCompare(b.name));
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
  // One git call per repo, all of them at once. `--branch` prepends a `##`
  // header naming the branch, which is the other thing the dropdown shows —
  // asking separately doubled the process count for data already in hand.
  // ahead/behind stays 0 here; the header computes the real values for the
  // selected repo via workingTree().
  const out = (await Promise.all([...roots].map((r) => repoRef(r)))).filter((r): r is GitRepoRef => !!r);
  const scoped = only.length ? within(out, only) : out;
  scoped.sort((a, b) => b.dirty - a.dirty || a.name.localeCompare(b.name));
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

function run(root: string, args: string[]): GitActionResult {
  const r = git(root, args);
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
export function fetch(rootIn: string): GitActionResult {
  const root = repoRoot(rootIn); if (!root) return { ok: false, error: "not a git repository root" };
  const g = guard(root); if (g) return g;
  return run(root, ["fetch", "--all", "--prune"]);
}

// --- branches / log / stash --------------------------------------------------
const US = "\x1f"; // field separator
const validRef = (n: string) => typeof n === "string" && /^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]+$/.test(n) && !n.endsWith("/") && !n.endsWith(".lock");
const validHash = (h: string) => typeof h === "string" && /^[0-9a-fA-F]{4,40}$/.test(h);

export function branches(rootIn: unknown): { current: string; branches: GitBranch[] } {
  const root = repoRoot(rootIn);
  if (!root) return { current: "", branches: [] };
  const fmt = `%(refname:short)${US}%(HEAD)${US}%(upstream:short)${US}%(upstream:track)${US}%(committerdate:relative)${US}%(contents:subject)`;
  const r = git(root, ["for-each-ref", "--sort=-committerdate", "refs/heads", `--format=${fmt}`]);
  const list: GitBranch[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const [name, head, upstream, track, date, subject] = line.split(US);
    list.push({ name, current: head === "*", upstream: upstream || null, track: track || "", date: date || "", subject: subject || "" });
  }
  return { current: currentBranch(root), branches: list };
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
