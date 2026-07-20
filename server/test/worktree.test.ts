// Linked worktrees are the project, not a dozen projects.
//
// The layout under test is the one people actually use: sibling checkouts next
// to the repo, `~/code/orbit-WEB-1042` beside `~/code/orbit`. No prefix test
// can relate those two paths, which is what made the app contradict itself —
// the git panel listed a worktree as part of the open project while the
// terminal, git writes and chat all refused to run in it as "outside the open
// project". These pin both halves: the worktree is inside the scope, and the
// things that merely *look* like it still aren't.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// realpath, because git writes the resolved path into the worktree's `.git`
// file: on macOS `tmpdir()` is the symlink /var/folders/… and git records
// /private/var/folders/…, so every path comparison below would fail.
const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-worktree-")));
const PROJECT = join(dir, "orbit");
const WORKTREE = join(dir, "orbit-WEB-1042");
const SIBLING = join(dir, "orbit-backup"); // a plain directory that shares the prefix
const SUBMODULE = join(dir, "vendor-lib");

process.env.XDG_CONFIG_HOME = dir; // never inherit the developer's own scope
process.env.AGENTGLASS_DB = join(dir, "w.db");

/** A real repo with a real linked worktree — `git worktree list` is the only
 *  authority for the family, so a fake one would pin nothing. */
function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

let wt: typeof import("../src/worktree.ts");
let cfg: typeof import("../src/config.ts");

beforeAll(async () => {
  mkdirSync(PROJECT, { recursive: true });
  mkdirSync(SIBLING, { recursive: true });
  mkdirSync(SUBMODULE, { recursive: true });
  git(PROJECT, "init", "-q", "-b", "main");
  git(PROJECT, "config", "user.email", "t@example.com");
  git(PROJECT, "config", "user.name", "t");
  writeFileSync(join(PROJECT, "README"), "x\n");
  git(PROJECT, "add", "-A");
  git(PROJECT, "commit", "-qm", "init");
  git(PROJECT, "worktree", "add", "-q", "-b", "WEB-1042", WORKTREE);
  // A submodule's `.git` is also a *file*, pointing at `.git/modules/<name>` —
  // the one shape that must NOT be mistaken for a worktree, because it really
  // is a different repository.
  writeFileSync(join(SUBMODULE, ".git"), `gitdir: ${PROJECT}/.git/modules/vendor-lib\n`);

  wt = await import("../src/worktree.ts");
  cfg = await import("../src/config.ts");
});

describe("worktreeParent", () => {
  test("a linked worktree points back at its project", () => {
    expect(wt.worktreeParent(WORKTREE)).toBe(PROJECT);
  });

  test("the main checkout is not a worktree of anything", () => {
    // Its `.git` is a directory — the whole detection in one assertion.
    expect(wt.worktreeParent(PROJECT)).toBe(null);
  });

  test("a submodule is a different repo, not a worktree", () => {
    expect(wt.worktreeParent(SUBMODULE)).toBe(null);
  });

  test("a plain directory answers null rather than throwing", () => {
    expect(wt.worktreeParent(SIBLING)).toBe(null);
    expect(wt.worktreeParent(join(dir, "does-not-exist"))).toBe(null);
  });

  test("the bare-clone layout resolves to the project too", () => {
    // `git clone --bare .bare` plus sibling checkouts is the other common way
    // to live in worktrees, and its git dir isn't called `.git`. Matching on
    // `/.git/worktrees/` left these users with the unfolded picker.
    const proj = join(dir, "bare-style");
    const check = join(proj, "main");
    mkdirSync(check, { recursive: true });
    writeFileSync(join(check, ".git"), `gitdir: ${proj}/.bare/worktrees/main\n`);
    expect(wt.worktreeParent(check)).toBe(proj);
  });

  test("a relative gitdir resolves against the worktree", () => {
    // `worktree.useRelativePaths` (git ≥ 2.48) and `git worktree repair` both
    // write relative paths.
    const rel = join(dir, "rel-wt");
    mkdirSync(rel, { recursive: true });
    writeFileSync(join(rel, ".git"), "gitdir: ../orbit/.git/worktrees/rel-wt\n");
    expect(wt.worktreeParent(rel)).toBe(PROJECT);
  });
});

describe("worktreeFamily", () => {
  test("every checkout, asked from the project", () => {
    const fam = wt.worktreeFamily(PROJECT);
    expect(fam).toContain(PROJECT);
    expect(fam).toContain(WORKTREE);
  });

  test("every checkout, asked from the worktree", () => {
    // The symmetry is what lets a user open either one as their project.
    const fam = wt.worktreeFamily(WORKTREE);
    expect(fam).toContain(PROJECT);
    expect(fam).toContain(WORKTREE);
  });

  test("a subdirectory does not inherit the family", () => {
    // `git -C` walks upward, so this is the case that would silently widen a
    // deliberately narrow monorepo-subdir scope to the entire repo.
    const sub = join(PROJECT, "packages", "api");
    mkdirSync(sub, { recursive: true });
    expect(wt.worktreeFamily(sub)).toEqual([sub]);
  });

  test("a non-repo is its own family", () => {
    expect(wt.worktreeFamily(SIBLING)).toEqual([SIBLING]);
  });
});

describe("inScope with worktrees", () => {
  test("a linked worktree is inside the project", () => {
    // The bug this whole change exists for: the terminal, git writes and chat
    // all refused here.
    expect(cfg.inScope(WORKTREE, PROJECT)).toBe(true);
    expect(cfg.inScope(join(WORKTREE, "src", "app.ts"), PROJECT)).toBe(true);
  });

  test("the project is inside a worktree-scoped cockpit", () => {
    expect(cfg.inScope(PROJECT, WORKTREE)).toBe(true);
  });

  test("a sibling that merely shares the prefix is still out", () => {
    // `orbit-backup` looks exactly like a worktree by name and is not one. The
    // family is decided by git, never by the path.
    expect(cfg.inScope(SIBLING, PROJECT)).toBe(false);
  });

  test("an unrelated path is still out", () => {
    expect(cfg.inScope("/etc", PROJECT)).toBe(false);
    expect(cfg.inScope(dir, PROJECT)).toBe(false);
  });
});
