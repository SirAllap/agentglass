/*
 * Three gaps in the worker's git deny list (`agents/headless.ts`), each with
 * a real repo built with `git` itself, not a hand-made fixture of what git
 * writes.
 *
 * 1. A linked worktree's own submodules live under its OWN gitdir
 *    (`<common>/worktrees/<id>/modules/<name>`), not the common `modules`
 *    `ownGitRoots` already shuts — that dir has to be denied too.
 * 2. A `.git` file whose `gitdir:` text crosses a symlink before a `..`
 *    names a different real directory than a lexical `path.resolve` of the
 *    same text, so the deny list has to be built from the real one.
 * 3. A FIFO at `.git/index` must not hang `gitlinkPaths`' `spawnSync`.
 */
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { identify } from "./gitIdentity.ts";
import { gitWriteRoots, readRegularFileSync, sweepMountPoints } from "../src/agents/headless.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-headless-git-deny-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "protocol.file.allow=always", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });

function repo(name: string): string {
  const at = join(dir, name);
  mkdirSync(at, { recursive: true });
  git(at, "init", "-q", "-b", "main");
  identify(at);
  writeFileSync(join(at, "a.txt"), "one\n");
  git(at, "add", "-A");
  git(at, "commit", "-qm", "first");
  return at;
}

test("a linked worktree's own submodule git dir is denied", () => {
  const lib = repo("lib-a");
  const main = repo("main-a");
  expect(git(main, "submodule", "add", lib, "vendor/lib").exitCode).toBe(0);
  git(main, "commit", "-qm", "add submodule");
  const wt = join(dir, "wt-a");
  expect(git(main, "worktree", "add", wt, "-b", "side").exitCode).toBe(0);
  expect(git(wt, "submodule", "update", "--init").exitCode).toBe(0);

  const gitdir = git(wt, "rev-parse", "--git-dir").stdout.toString("utf8").trim();
  const absGitdir = realpathSync(resolve(wt, gitdir));

  const { deny } = gitWriteRoots(wt, true, true);
  expect(deny).toContain(join(absGitdir, "modules"));
  expect(deny).toContain(join(wt, "vendor", "lib", ".git"));
});

test("a symlink on the way to a .git file's gitdir is resolved, not collapsed lexically", () => {
  const t = join(dir, "sym-b");
  mkdirSync(join(t, "deep", "x", "hooks"), { recursive: true });
  writeFileSync(join(t, "deep", "x", "config"), "");
  mkdirSync(join(t, "deep", "dir"), { recursive: true });
  symlinkSync(join(t, "deep", "dir"), join(t, "lnk"));
  // The real gitdir is `deep/x`: `lnk` -> `deep/dir`, and `..` from there is
  // `deep`. A lexical `resolve(t, "lnk/../x")` collapses straight to `t/x`,
  // which this repo never had.
  writeFileSync(join(t, ".git"), "gitdir: lnk/../x\n");

  const { deny } = gitWriteRoots(t, false, true);
  expect(deny).toContain(join(t, "deep", "x", "hooks"));
  expect(deny).not.toContain(join(t, "x", "hooks"));
  // The old lexical path must not have been created either — `modulesDeny`
  // used to `mkdir -p` it before finding there was nothing to deny.
  expect(() => realpathSync(join(t, "x"))).toThrow();
});

test("a FIFO at .git/index does not hang the submodule read", () => {
  const main = repo("main-c");
  writeFileSync(join(main, ".gitmodules"), '[submodule "lib"]\n\tpath = lib\n\turl = ../lib-c\n');
  mkdirSync(join(main, "lib"));
  Bun.spawnSync(["rm", "-f", join(main, ".git", "index")]);
  expect(Bun.spawnSync(["mkfifo", join(main, ".git", "index")]).exitCode).toBe(0);

  const started = Date.now();
  const { deny } = gitWriteRoots(main, true, true);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(Array.isArray(deny)).toBe(true);
});

test("a FIFO at .gitmodules does not hang the sync read", () => {
  const main = repo("main-d");
  writeFileSync(join(main, ".gitmodules"), '[submodule "lib"]\n\tpath = lib\n\turl = ../lib-d\n');
  mkdirSync(join(main, "lib"));
  Bun.spawnSync(["rm", "-f", join(main, ".gitmodules")]);
  expect(Bun.spawnSync(["mkfifo", join(main, ".gitmodules")]).exitCode).toBe(0);

  const started = Date.now();
  const { deny } = gitWriteRoots(main, true, true);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(Array.isArray(deny)).toBe(true);
});

test("a linked worktree's gitdir back-pointer is denied, and a FIFO there does not hang", () => {
  const main = repo("main-e");
  const wt = join(dir, "wt-e");
  expect(git(main, "worktree", "add", wt, "-b", "side-e").exitCode).toBe(0);
  const rel = git(wt, "rev-parse", "--git-dir").stdout.toString("utf8").trim();
  const gitdir = realpathSync(resolve(wt, rel));

  const before = gitWriteRoots(wt, true, true);
  expect(before.deny).toContain(join(gitdir, "gitdir"));

  Bun.spawnSync(["rm", "-f", join(gitdir, "gitdir")]);
  expect(Bun.spawnSync(["mkfifo", join(gitdir, "gitdir")]).exitCode).toBe(0);
  const started = Date.now();
  const { allow } = gitWriteRoots(wt, true, true);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(allow).toEqual([]);
});

test("an effective core.hooksPath inside the tree is denied", () => {
  const main = repo("main-f");
  mkdirSync(join(main, ".husky"));
  git(main, "config", "core.hooksPath", ".husky");

  const { deny } = gitWriteRoots(main, true, true);
  expect(deny).toContain(join(main, ".husky"));
});

test("core.hooksPath with a leading ~/ expands to the home dir, like git itself", () => {
  const main = repo("main-g");
  const fakeHome = mkdtempSync(join(tmpdir(), "agx-headless-fakehome-"));
  mkdirSync(join(fakeHome, "escape-hooks"));
  git(main, "config", "core.hooksPath", "~/escape-hooks");
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const { deny } = gitWriteRoots(main, true, true);
    expect(deny).toContain(join(fakeHome, "escape-hooks"));
  } finally {
    process.env.HOME = realHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("readRegularFileSync reads a regular file", () => {
  const f = join(dir, "regular.txt");
  writeFileSync(f, "hello\n");
  expect(readRegularFileSync(f)).toBe("hello\n");
});

test("readRegularFileSync does not hang when the path is a FIFO", () => {
  const f = join(dir, "fifo-direct");
  Bun.spawnSync(["rm", "-f", f]);
  expect(Bun.spawnSync(["mkfifo", f]).exitCode).toBe(0);

  const started = Date.now();
  expect(readRegularFileSync(f)).toBeNull();
  expect(Date.now() - started).toBeLessThan(2000);
});

test("readRegularFileSync refuses a file over the size cap", () => {
  const f = join(dir, "too-big.txt");
  writeFileSync(f, "x".repeat(1024 * 1024 + 1));
  expect(readRegularFileSync(f)).toBeNull();
});

test("core.hooksPath with ~<this account>/ expands to that account's home, like git itself", () => {
  const main = repo("main-h");
  const fakeHome = mkdtempSync(join(tmpdir(), "agx-headless-fakehome-"));
  mkdirSync(join(fakeHome, "own-hooks"));
  git(main, "config", "core.hooksPath", `~${userInfo().username}/own-hooks`);
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const { deny } = gitWriteRoots(main, true, true);
    expect(deny).toContain(join(fakeHome, "own-hooks"));
  } finally {
    process.env.HOME = realHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("core.hooksPath with ~otheruser/ is unresolvable and fails closed onto the shared home parent", () => {
  const main = repo("main-i");
  git(main, "config", "core.hooksPath", "~some-other-account/hooks");
  const fakeHome = mkdtempSync(join(tmpdir(), "agx-headless-fakehome-"));
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const { deny } = gitWriteRoots(main, true, true);
    expect(deny).toContain(dirname(fakeHome));
  } finally {
    process.env.HOME = realHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("a lock file git is writing in the common .git is never a deny entry", () => {
  const main = repo("main-lock");
  const wt = join(dir, "wt-lock");
  expect(git(main, "worktree", "add", wt, "-b", "lock-side").exitCode).toBe(0);
  writeFileSync(join(main, ".git", "config.lock"), "");
  writeFileSync(join(main, ".git", "packed-refs.lock"), "");
  const { deny } = gitWriteRoots(wt, true, true);
  expect(deny.filter((p) => p.endsWith(".lock"))).toEqual([]);
  expect(deny).toContain(join(realpathSync(main), ".git", "config"));
});

test("sweepMountPoints removes the empty read-only lock a sandbox mount point leaves, and only that", () => {
  const main = repo("main-sweep");
  const wt = join(dir, "wt-sweep");
  expect(git(main, "worktree", "add", wt, "-b", "sweep-side").exitCode).toBe(0);
  const mount = join(main, ".git", "config.lock");
  writeFileSync(mount, "", { mode: 0o444 });
  chmodSync(mount, 0o444);
  const live = join(main, ".git", "packed-refs.lock");
  writeFileSync(live, "");
  sweepMountPoints(wt);
  expect(existsSync(mount)).toBe(false);
  expect(existsSync(live)).toBe(true);
  // a writable lock, even empty, is a git process's: kept
  writeFileSync(mount, "");
  sweepMountPoints(wt);
  expect(existsSync(mount)).toBe(true);
});
