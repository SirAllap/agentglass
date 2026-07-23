// Minimal, safe git adapter for the commit composer.
//
// Design note: agentglass observes *telemetry* (the agent's structuredPatch),
// which is a historical snapshot. To commit safely we do NOT commit that
// snapshot — we read the repo's LIVE working-tree status and commit exactly the
// paths the user selects, as they are on disk right now. The telemetry file
// list is only the entry point. This sidesteps the drift problem entirely.
//
// Safety: every git call is execFile-style (arg array, never a shell string),
// scoped with `-C <root>`; commit paths are validated to stay inside the repo
// root; and the whole feature can be killed with AGENTGLASS_COMMIT_DISABLED=1.

import { resolve, dirname, relative, sep } from "node:path";
// readFileSync: /etc/wsl.conf, for the Windows drive translation below.
import { readFileSync, statSync } from "node:fs";
import { inScope } from "./config.ts";
import { record } from "./gitlog.ts";
import { currentLabel, resumedAs } from "./loopwatch.ts";
import { withSpawnSlot } from "./spawnpool.ts";
import type { GitFileStatus, RepoStatus, CommitResult, GitCapability } from "../../shared/types.ts";

export const COMMIT_ENABLED = process.env.AGENTGLASS_COMMIT_DISABLED !== "1";

type GitResult = { code: number; stdout: string; stderr: string };

export function git(cwd: string, args: string[]): GitResult {
  const t0 = performance.now();
  try {
    // A hung git call (index.lock contention, a repo on a stalled mount) would
    // otherwise freeze the whole single-threaded server indefinitely.
    const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    const r = {
      code: proc.exitCode ?? 1,
      stdout: proc.stdout?.toString() ?? "",
      stderr: proc.stderr?.toString() ?? "",
    };
    record(cwd, args, r.code, performance.now() - t0, r.stderr);
    return r;
  } catch (e) {
    record(cwd, args, 1, performance.now() - t0, String(e));
    return { code: 1, stdout: "", stderr: String(e) };
  }
}

/** Same call, awaited instead of blocking. Sequential spawnSync is fine for one
 *  repo, but the repo picker asks every repo on the machine at once — run those
 *  concurrently or the panel waits for the sum of them. */
export async function gitAsync(cwd: string, args: string[]): Promise<GitResult> {
  // Queued behind the process cap — see spawnpool. A sweep of eighteen
  // checkouts is eighteen of these, and several sweeps can overlap.
  return withSpawnSlot(() => runGit(cwd, args));
}

/**
 * Is `git` even here?
 *
 * The whole file assumes it is, and `Bun.spawn` THROWS on a missing binary
 * rather than returning exit 127 — so without this probe, a machine with no git
 * turns every call above into a caught `{ code: 1 }`, and the panels invent a
 * cause: the repo picker shows an empty "no repos found", and the terminal and
 * chat reject a perfectly good directory with "invalid or non-repo directory"
 * (blaming the folder for a tool that isn't installed). This is the same
 * first-class-state treatment `ghCapability` already gives the PR panel: "git
 * is not installed" is something the user can act on, not an error to bury.
 *
 * `Bun.which` is cached for the process — a binary does not appear mid-session,
 * and the repo picker asks on every mount.
 */
let gitBinCache: string | null | undefined;
export function gitBin(): string | null {
  // PATH passed explicitly: bare `Bun.which("git")` resolves against a PATH
  // captured at process start and ignores later changes to process.env.PATH,
  // which both hides a genuinely stripped environment and makes this untestable.
  if (gitBinCache === undefined) gitBinCache = Bun.which("git", { PATH: process.env.PATH ?? "" });
  return gitBinCache;
}

let gitCapCache: { at: number; cap: GitCapability } | null = null;
const GIT_CAP_TTL_MS = 60_000;

export function gitCapability(): GitCapability {
  if (gitCapCache && Date.now() - gitCapCache.at < GIT_CAP_TTL_MS) return gitCapCache.cap;
  const bin = gitBin();
  let cap: GitCapability;
  if (!bin) {
    cap = { available: false, reason: "git is not installed — the source-control, terminal and pull-request panels need it" };
  } else {
    let version: string | undefined;
    try {
      // Not through git()/record(): a capability probe must not land in the git
      // activity log. `git --version` needs no repo and cannot hang meaningfully.
      const r = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "ignore", timeout: 5_000 });
      version = r.exitCode === 0 ? (r.stdout?.toString().trim().replace(/^git version /, "") || undefined) : undefined;
    } catch { /* vanished between which and spawn — treat as present, callers still guard */ }
    cap = { available: true, version };
  }
  gitCapCache = { at: Date.now(), cap };
  return cap;
}

/** Test seam: forget the probe so a test can flip PATH and re-ask. */
export function __resetGitCapForTest(): void {
  gitBinCache = undefined;
  gitCapCache = null;
}

/**
 * How long one `git` may run before it is killed.
 *
 * A backstop against "never", not a policy on how fast git ought to be. It has
 * to clear the slowest thing that legitimately comes through here — a PR fetch
 * on a large repo over a slow link — because killing real work would be a worse
 * bug than the one this closes. Anything past two minutes is not slow, it is
 * stuck.
 *
 * Read per call rather than fixed at import, for the reason spawnpool's limit()
 * gives: a module constant is decided by whichever file imports this first,
 * which in a test run is never the file doing the overriding.
 */
const gitTimeoutMs = () => Number(process.env.AGENTGLASS_GIT_TIMEOUT_SECONDS ?? 120) * 1000;

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  const t0 = performance.now();
  // Whose work this is, read while we are still standing inside the caller —
  // everything after the await belongs to them, however many other requests
  // arrive in the meantime. See loopwatch.
  const owner = currentLabel();
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      // A git that never returns used to cost one hung request: bad, bounded,
      // survivable. Now that every spawn takes a slot from the shared pool it
      // costs a slot as well, and a slot that is never handed back is gone for
      // the life of the process — enough of them and nothing in the app can run
      // git again. That is the freeze the pool was built to prevent, reached
      // from the other side.
      timeout: gitTimeoutMs(),
      // The three the auto-fetch already sets, for the reason it documents
      // (gitwork.ts): a repo whose credentials expired otherwise sits on a
      // password prompt that no one is there to answer. Not hypothetical on
      // this path — prs.ts fetches PR refs from the network through here.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS_REQUIRE: "never" },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // Everything after this line is synchronous parsing of what git said, on
    // behalf of whoever asked.
    resumedAs(owner);
    // A git killed mid-flight says nothing on stderr, and prs.ts puts stderr's
    // first line in front of the user verbatim — an empty one reads as a bug in
    // us rather than as a remote that never answered.
    const err = proc.signalCode && !stderr.trim()
      ? `git ${args[0] ?? ""} gave up after ${gitTimeoutMs() / 1000}s — killed with ${proc.signalCode}`
      : stderr;
    record(cwd, args, code ?? 1, performance.now() - t0, err);
    return { code: code ?? 1, stdout, stderr: err };
  } catch (e) {
    record(cwd, args, 1, performance.now() - t0, String(e));
    return { code: 1, stdout: "", stderr: String(e) };
  }
}

// Windows-side Claude Code records Windows cwds (`C:\Users\...`) in its
// transcripts. On a posix host that string isn't absolute, so resolve() would
// treat it as relative to the server's own cwd and git would then attribute
// every such session to whatever repo the server runs from. Map drive-letter
// paths onto the WSL automount (`/mnt/c/...` by default; /etc/wsl.conf's
// [automount] root can move it) before any path or git logic sees them.
const WINDOWS_DRIVE = /^([A-Za-z]):[\\/]/;
const AUTOMOUNT_ROOT = (() => {
  if (process.platform === "win32") return null; // native Windows resolves C:\ itself
  let root = "/mnt/";
  try {
    const automount = readFileSync("/etc/wsl.conf", "utf8").match(/\[automount\]([^[]*)/)?.[1] ?? "";
    const custom = automount.match(/^\s*root\s*=\s*(\S+)/m)?.[1];
    if (custom) root = custom.endsWith("/") ? custom : custom + "/";
  } catch { /* not WSL or no config — the conventional mount root still beats a relative path */ }
  return root;
})();

function fromWindowsPath(p: string): string {
  const drive = p.match(WINDOWS_DRIVE);
  if (!drive || !AUTOMOUNT_ROOT) return p;
  return AUTOMOUNT_ROOT + drive[1]!.toLowerCase() + "/" + p.slice(3).replaceAll("\\", "/");
}

export function safeAbs(p: unknown): string | null {
  if (typeof p !== "string" || !p || p.includes("\0")) return null;
  const abs = resolve(fromWindowsPath(p));
  // A translated drive path must stay inside the mount it maps to: `\` became
  // a real separator, so `..` in a Windows-recorded path can now climb out —
  // and safeAbs also sees request-supplied paths, so fail closed. Clamp to the
  // drive's own mount (C: → <automount>/c), not the automount base, or
  // `C:\..\d\...` could hop drives while staying under it.
  const drive = p.match(WINDOWS_DRIVE);
  if (drive && AUTOMOUNT_ROOT) {
    const mount = AUTOMOUNT_ROOT + drive[1]!.toLowerCase();
    if (abs !== mount && !abs.startsWith(mount + "/")) return null;
  }
  return abs;
}

/** Resolve the git top-level for a file/dir path (a real path from telemetry). */
export function repoRootOf(anchor: string): string | null {
  const abs = safeAbs(anchor);
  if (!abs) return null;
  let dir = abs;
  try { if (!statSync(abs).isDirectory()) dir = dirname(abs); } catch { dir = dirname(abs); }
  const r = git(dir, ["rev-parse", "--show-toplevel"]);
  if (r.code !== 0) return null;
  return r.stdout.trim() || null;
}

/**
 * Awaited twin of {@link repoRootOf}, for the one caller that runs on the poll.
 *
 * `statusForPaths` is asked on every /git/status poll while the in-browser
 * terminal rides the same single thread, so its `rev-parse` must not be a
 * synchronous spawn holding the loop between keystrokes. The sync version above
 * stays for the on-demand callers — a chat send, a PR lookup, the repo-picker
 * sweep — which run once off the poll and where a queued spawn would only add
 * latency to a call nobody is typing behind.
 */
export async function repoRootOfAsync(anchor: string): Promise<string | null> {
  const abs = safeAbs(anchor);
  if (!abs) return null;
  let dir = abs;
  try { if (!statSync(abs).isDirectory()) dir = dirname(abs); } catch { dir = dirname(abs); }
  const r = await gitAsync(dir, ["rev-parse", "--show-toplevel"]);
  if (r.code !== 0) return null;
  return r.stdout.trim() || null;
}

/**
 * The *project* a telemetry path belongs to — the main repo root.
 *
 * Two things `--show-toplevel` gets wrong when labeling projects:
 *  - a linked worktree resolves to the worktree directory, so every branch
 *    checkout shows up as its own project;
 *  - a path under a worktree that has since been removed can't be resolved by
 *    git at all, which is the common case for historical transcripts.
 * Stripping at `/.worktrees/` handles both without needing the directory to
 * still exist; `--git-common-dir` then folds any nested subdirectory
 * (`repo/apps/client/src`) up to the repo that owns it.
 */
export function projectRootOf(anchor: string): string | null {
  const abs = safeAbs(anchor);
  if (!abs) return null;
  const wt = abs.indexOf("/.worktrees/");
  const base = wt === -1 ? abs : abs.slice(0, wt);
  let dir = base;
  try { if (!statSync(base).isDirectory()) dir = dirname(base); } catch { dir = dirname(base); }
  const r = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (r.code === 0) {
    const common = r.stdout.trim();
    if (common.endsWith("/.git")) return dirname(common);
    if (common) return common;
  }
  // Not a repo (or gone): the worktree strip is still a better answer than the
  // raw path, but a plain non-repo directory has no project to roll up to.
  return wt === -1 ? null : base;
}

// Awaited: this reads on the /git/status and /git/tree hot paths (via
// statusForPaths and branchInfo), both on a poll the PTY shares the loop with —
// so the rev-parse goes through the pool rather than blocking between keystrokes.
export async function currentBranch(root: string): Promise<string> {
  const b = (await gitAsync(root, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  if (b && b !== "HEAD") return b;
  // "HEAD" from --abbrev-ref is two different states: a real detached HEAD, and
  // an unborn branch — a freshly `git init`'d repo (or `checkout --orphan`) that
  // has a branch name but no commit yet. symbolic-ref tells them apart: it
  // resolves the branch name while unborn and fails only when truly detached, so
  // a brand-new repo shows "main", not "(detached)".
  const sym = await gitAsync(root, ["symbolic-ref", "--short", "HEAD"]);
  const name = sym.stdout.trim();
  return sym.code === 0 && name ? name : "(detached)";
}

function statusLabel(x: string, y: string): GitFileStatus["status"] {
  if (x === "?" && y === "?") return "untracked";
  const c = x !== " " ? x : y;
  const m: Record<string, GitFileStatus["status"]> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", U: "unmerged", T: "type-changed" };
  return m[c] ?? "modified";
}

/** Parse `git status --porcelain=v1 -z` into per-file staged/unstaged flags. */
async function parseStatus(root: string): Promise<GitFileStatus[]> {
  const r = await gitAsync(root, ["status", "--porcelain=v1", "-z"]);
  if (r.code !== 0) return [];
  const parts = r.stdout.split("\0");
  const files: GitFileStatus[] = [];
  for (let i = 0; i < parts.length; i++) {
    const tok = parts[i];
    if (!tok || tok.length < 3) continue;
    const x = tok[0], y = tok[1];
    const path = tok.slice(3);
    if (x === "R" || x === "C") i++; // rename/copy: the original path is the next \0 token — skip it
    files.push({
      path,
      code: x + y,
      staged: x !== " " && x !== "?",
      unstaged: y !== " ",
      status: statusLabel(x, y),
    });
  }
  return files;
}

/**
 * Live status of every repo touched by the given file paths, grouped by root.
 *
 * Awaited throughout — this used to be a chain of synchronous `git()` spawns
 * (one rev-parse per path, then a status and a branch read per root) and it was
 * the last thing on the /git/status poll still freezing the loop the terminal
 * rides. Every read now goes through the shared pool, and the independent ones
 * run concurrently so the endpoint's wall clock stays one status' worth rather
 * than the sum of them.
 */
export async function statusForPaths(paths: string[]): Promise<RepoStatus[]> {
  const byRoot = new Map<string, Set<string>>();
  // The rev-parse per path, off the loop and all at once — duplicates (many
  // paths in one repo) still collapse to one root key below.
  const resolved = await Promise.all(paths.map(async (p) => ({ root: await repoRootOfAsync(p), abs: safeAbs(p) })));
  for (const { root, abs } of resolved) {
    if (!root || !abs) continue;
    if (!byRoot.has(root)) byRoot.set(root, new Set());
    byRoot.get(root)!.add(relative(root, abs));
  }
  // Each root is a status read and a branch read; run the two together, and the
  // roots together, so nothing waits on the sum of the others.
  return Promise.all([...byRoot].map(async ([root, suggested]) => {
    const [files, branch] = await Promise.all([parseStatus(root), currentBranch(root)]);
    const dirty = new Set(files.map((f) => f.path));
    return {
      root,
      branch,
      files,
      suggested: [...suggested].filter((rel) => dirty.has(rel)),
    };
  }));
}

function summarize(out: string): string {
  const m = out.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
  if (!m) return "committed";
  return `${m[1]} file${m[1] === "1" ? "" : "s"}${m[2] ? `, +${m[2]}` : ""}${m[3] ? `, −${m[3]}` : ""}`;
}

/**
 * The source paths of any staged renames whose target is being committed.
 *
 * A staged rename is a deletion of the old path plus an addition of the new one.
 * `git status` reports it as one `R old -> new` entry and the composer only ever
 * surfaces the new path, so a pathspec-limited `git commit -- new` records the
 * addition but leaves the old path's deletion behind — HEAD then carries both
 * files and an orphaned staged deletion. Pulling in the source path lets the
 * whole rename land in one commit. Copies (`C`) keep their source, so they are
 * left out.
 */
function renameSources(root: string, targets: Set<string>): string[] {
  const r = git(root, ["status", "--porcelain=v1", "-z"]);
  if (r.code !== 0) return [];
  const parts = r.stdout.split("\0");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const tok = parts[i];
    if (!tok || tok.length < 3) continue;
    const x = tok[0];
    const newPath = tok.slice(3);
    if (x === "R" || x === "C") {
      const oldPath = parts[++i]; // porcelain -z puts the source in the next \0 token
      if (x === "R" && oldPath && targets.has(newPath)) out.push(oldPath);
    }
  }
  return out;
}

/** Stage the selected paths and commit exactly them (ignoring anything else the
 *  user may have staged), scoped to a validated repo root. */
export function commit(root: string, files: string[], title: string, body: string): CommitResult {
  if (!COMMIT_ENABLED) return { ok: false, error: "commit is disabled (AGENTGLASS_COMMIT_DISABLED=1)" };
  const absRoot = safeAbs(root);
  if (!absRoot) return { ok: false, error: "invalid repo path" };
  const top = git(absRoot, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || top.stdout.trim() !== absRoot) return { ok: false, error: "not a git repository root" };
  // The same boundary gitwork's guard() applies to staging, discarding and the
  // Source Control panel's own commit. This is the older commit-composer path
  // and it was the one mutating git endpoint that never checked: a cockpit
  // opened for one project could still commit into any repo on the machine.
  if (!inScope(absRoot)) return { ok: false, error: "outside the open project — open the parent folder to work across repos" };
  if (!title.trim()) return { ok: false, error: "commit title required" };

  const rels = (Array.isArray(files) ? files : []).map((f) => String(f)).filter(Boolean);
  if (!rels.length) return { ok: false, error: "no files selected" };
  // A selected rename target drags its source path into the *commit* pathspec,
  // or the deletion half of the rename never lands and HEAD keeps both files.
  // The source is not re-added: a staged rename already holds the deletion in
  // the index, and `git add` of a path that no longer exists in the tree would
  // fail. git reports the source, so it is repo-relative, but it goes through
  // the same escape check as the selected paths.
  const sources = renameSources(absRoot, new Set(rels));
  const commitPaths = [...new Set([...rels, ...sources])];
  for (const rel of commitPaths) {
    if (rel.includes("\0")) return { ok: false, error: "invalid file path" };
    const abs = resolve(absRoot, rel);
    if (abs !== absRoot && !abs.startsWith(absRoot + sep)) return { ok: false, error: `path escapes repo: ${rel}` };
  }

  const add = git(absRoot, ["add", "--", ...rels]);
  if (add.code !== 0) return { ok: false, error: add.stderr.trim() || "git add failed" };

  const args = ["commit", "-m", title.trim()];
  if (body && body.trim()) args.push("-m", body.trim());
  args.push("--", ...commitPaths);
  const c = git(absRoot, args);
  if (c.code !== 0) return { ok: false, error: c.stderr.trim() || c.stdout.trim() || "git commit failed" };

  const sha = git(absRoot, ["rev-parse", "HEAD"]).stdout.trim();
  return { ok: true, sha, shortSha: sha.slice(0, 8), summary: summarize(c.stdout) };
}
