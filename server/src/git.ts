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
import type { GitFileStatus, RepoStatus, CommitResult } from "../../shared/types.ts";

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
  const t0 = performance.now();
  // Whose work this is, read while we are still standing inside the caller —
  // everything after the await belongs to them, however many other requests
  // arrive in the meantime. See loopwatch.
  const owner = currentLabel();
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // Everything after this line is synchronous parsing of what git said, on
    // behalf of whoever asked.
    resumedAs(owner);
    record(cwd, args, code ?? 1, performance.now() - t0, stderr);
    return { code: code ?? 1, stdout, stderr };
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

export function currentBranch(root: string): string {
  const b = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  return !b || b === "HEAD" ? "(detached)" : b;
}

function statusLabel(x: string, y: string): GitFileStatus["status"] {
  if (x === "?" && y === "?") return "untracked";
  const c = x !== " " ? x : y;
  const m: Record<string, GitFileStatus["status"]> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", U: "unmerged", T: "type-changed" };
  return m[c] ?? "modified";
}

/** Parse `git status --porcelain=v1 -z` into per-file staged/unstaged flags. */
function parseStatus(root: string): GitFileStatus[] {
  const r = git(root, ["status", "--porcelain=v1", "-z"]);
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

/** Live status of every repo touched by the given file paths, grouped by root. */
export function statusForPaths(paths: string[]): RepoStatus[] {
  const byRoot = new Map<string, Set<string>>();
  for (const p of paths) {
    const root = repoRootOf(p);
    const abs = safeAbs(p);
    if (!root || !abs) continue;
    if (!byRoot.has(root)) byRoot.set(root, new Set());
    byRoot.get(root)!.add(relative(root, abs));
  }
  const out: RepoStatus[] = [];
  for (const [root, suggested] of byRoot) {
    const files = parseStatus(root);
    const dirty = new Set(files.map((f) => f.path));
    out.push({
      root,
      branch: currentBranch(root),
      files,
      suggested: [...suggested].filter((rel) => dirty.has(rel)),
    });
  }
  return out;
}

function summarize(out: string): string {
  const m = out.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
  if (!m) return "committed";
  return `${m[1]} file${m[1] === "1" ? "" : "s"}${m[2] ? `, +${m[2]}` : ""}${m[3] ? `, −${m[3]}` : ""}`;
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
  for (const rel of rels) {
    if (rel.includes("\0")) return { ok: false, error: "invalid file path" };
    const abs = resolve(absRoot, rel);
    if (abs !== absRoot && !abs.startsWith(absRoot + sep)) return { ok: false, error: `path escapes repo: ${rel}` };
  }

  const add = git(absRoot, ["add", "--", ...rels]);
  if (add.code !== 0) return { ok: false, error: add.stderr.trim() || "git add failed" };

  const args = ["commit", "-m", title.trim()];
  if (body && body.trim()) args.push("-m", body.trim());
  args.push("--", ...rels);
  const c = git(absRoot, args);
  if (c.code !== 0) return { ok: false, error: c.stderr.trim() || c.stdout.trim() || "git commit failed" };

  const sha = git(absRoot, ["rev-parse", "HEAD"]).stdout.trim();
  return { ok: true, sha, shortSha: sha.slice(0, 8), summary: summarize(c.stdout) };
}
