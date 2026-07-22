// `git status` is not a safe answer to "is anything in this worktree?".
//
// The branches panel's bulk delete has to remove a worktree before it can
// delete the branch checked out in it, and `git worktree remove` deletes the
// whole directory — gitignored files included, with no `--force` needed and no
// warning printed. A checkout holding `compose/envs/*.env` and a page of local
// notes reports `status --porcelain` completely empty, so anything that asks
// git "is it clean?" and acts on a yes has already lost that work.
//
// These pin the difference: the ignored file that git hides, the noise that
// would bury it, and the two answers that must never read as "nothing to lose"
// — a path that isn't ours, and a checkout we couldn't read at all.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-leftovers-")));
const REPO = join(dir, "repo");
const WT = join(dir, "repo-feature");   // has ignored work in it
const BARE = join(dir, "repo-empty");   // nothing but rebuildable noise
const GHOST = join(dir, "repo-ghost");  // removed from under git

process.env.XDG_CONFIG_HOME = dir; // never inherit the developer's own scope
process.env.AGENTGLASS_DB = join(dir, "l.db");

function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

let gw: typeof import("../src/gitwork.ts");

beforeAll(async () => {
  mkdirSync(REPO, { recursive: true });
  git(REPO, "init", "-q", "-b", "main");
  git(REPO, "config", "user.email", "t@example.com");
  git(REPO, "config", "user.name", "t");
  writeFileSync(join(REPO, ".gitignore"), "*.env\n__pycache__/\nnode_modules/\n.mypy_cache/\nnotes-local.md\n");
  writeFileSync(join(REPO, "README"), "x\n");
  git(REPO, "add", "-A");
  git(REPO, "commit", "-q", "-m", "root");

  // The checkout that matters: clean to git, holding real work on disk.
  git(REPO, "branch", "feature");
  git(REPO, "worktree", "add", "-q", WT, "feature");
  writeFileSync(join(WT, "secrets.env"), "API_KEY=real\n");
  writeFileSync(join(WT, "notes-local.md"), "what I found\n");
  mkdirSync(join(WT, "src", "__pycache__"), { recursive: true });
  writeFileSync(join(WT, "src", "__pycache__", "mod.cpython-311.pyc"), "\x00");
  mkdirSync(join(WT, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(WT, "node_modules", "left-pad", "index.js"), "//\n");
  // A directory holding nothing tracked collapses to one line in git's output.
  // `cfg/` alone says nothing about which of these two it is, and they need
  // opposite answers.
  mkdirSync(join(WT, "cfg", "__pycache__"), { recursive: true });
  writeFileSync(join(WT, "cfg", "local.env"), "DB=here\n");
  writeFileSync(join(WT, "cfg", "__pycache__", "c.cpython-311.pyc"), "\x00");

  // Nothing but rebuildable output — the one case that IS safe to remove.
  git(REPO, "branch", "spare");
  git(REPO, "worktree", "add", "-q", BARE, "spare");
  mkdirSync(join(BARE, ".mypy_cache"), { recursive: true });
  writeFileSync(join(BARE, ".mypy_cache", "cache.json"), "{}\n");

  // Still registered with git, directory gone from disk.
  git(REPO, "branch", "ghost");
  git(REPO, "worktree", "add", "-q", GHOST, "ghost");
  rmSync(GHOST, { recursive: true, force: true });

  gw = await import("../src/gitwork.ts");
});

describe("worktreeLeftovers", () => {
  test("names the ignored files git reports as clean", async () => {
    // The premise. If this ever stops holding, the rest of this file is moot
    // and `git status` would be a fine guard on its own.
    expect(git(WT, "status", "--porcelain")).toBe("");

    const r = await gw.worktreeLeftovers(REPO, WT);
    expect(r.error).toBeUndefined();
    expect(r.files).toContain("secrets.env");
    expect(r.files).toContain("notes-local.md");
  });

  test("counts rebuildable output instead of listing it", async () => {
    const r = await gw.worktreeLeftovers(REPO, WT);
    // Four hundred `__pycache__/` lines would bury the one `.env` that matters,
    // and a dialog nobody reads to the end guards nothing.
    expect(r.files.some((f) => f.includes("__pycache__"))).toBe(false);
    expect(r.files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(r.skipped).toBeGreaterThanOrEqual(2);
  });

  test("opens a collapsed directory rather than reporting its name", async () => {
    const r = await gw.worktreeLeftovers(REPO, WT);
    // git prints `cfg/` and stops, because nothing in it is tracked. Listing
    // that verbatim hides the env file and cries wolf about the cache; both
    // halves have to come out.
    expect(r.files).toContain("cfg/local.env");
    expect(r.files).not.toContain("cfg/");
    // `src/` collapses the same way but holds only a cache — it must vanish
    // from the list entirely, not sit in it as an unexplained directory.
    expect(r.files.some((f) => f.startsWith("src"))).toBe(false);
  });

  test("an empty answer means empty — only when it really is", async () => {
    const r = await gw.worktreeLeftovers(REPO, BARE);
    expect(r.error).toBeUndefined();
    expect(r.files).toEqual([]);
    // Reported, so the UI can say "nothing but caches" rather than "empty" —
    // the two look identical in `files` alone.
    expect(r.skipped).toBeGreaterThan(0);
  });

  test("a checkout it cannot read reports an error, not an empty list", async () => {
    const r = await gw.worktreeLeftovers(REPO, GHOST);
    // "Couldn't look" and "nothing there" must never produce the same value:
    // the caller removes on the second and refuses on the first.
    expect(r.error).toBeTruthy();
    expect(r.files).toEqual([]);
  });

  test("refuses a path that is not a worktree of this repo", async () => {
    const r = await gw.worktreeLeftovers(REPO, dir);
    expect(r.error).toBeTruthy();
    expect(r.files).toEqual([]);
  });
});
