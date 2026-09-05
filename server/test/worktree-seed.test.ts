/*
 * A new worktree gets what git does not carry — from the repository's own
 * `.worktreeinclude`, copied and never linked, never overwriting what git put
 * there, never leaving the repository, never touching what git tracks, and
 * only ever what git ignores.
 *
 * "Never leaving the repository" is judged on the real path: the audit's
 * shape is a repository that tracks `cfg -> ../..` and names
 * `cfg/secret/id_key`, with the worktree cut under `<repo>/.worktrees/x`.
 * Every string check passed and `cpSync` followed the link into the home of
 * whoever cut the worktree. The fixtures below build exactly that.
 */
import { describe, expect, test, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, lstatSync, symlinkSync, realpathSync, readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { includeList, seedWorktree, seedSummary, gitIgnored } from "../src/worktreeseed.ts";

// `git check-ignore` reads the global excludes file; the run must not depend
// on what this machine ignores globally, so git sees no config at all.
const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
beforeAll(() => { process.env.GIT_CONFIG_GLOBAL = "/dev/null"; process.env.GIT_CONFIG_SYSTEM = "/dev/null"; });
afterAll(() => {
  if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.g;
  if (saved.s === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = saved.s;
});

/** `home/repo` is the repository, `home/repo/.worktrees/x` the worktree —
 *  so `../..` from the repository lands in `home`, where the secret lives. */
let home = "", root = "", wt = "";
function gitInit(dir: string, ignore: string): void {
  Bun.spawnSync(["git", "-C", dir, "init", "-q"], { stdout: "ignore", stderr: "ignore" });
  writeFileSync(join(dir, ".gitignore"), ignore);
}
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "agx-seed-home-")));
  root = join(home, "repo");
  wt = join(root, ".worktrees", "x");
  mkdirSync(wt, { recursive: true });
  mkdirSync(join(home, "secret"));
  writeFileSync(join(home, "secret", "id_key"), "PRIVATE");
  gitInit(root, ".env\nlocal/\nmissing.txt\nkeep.txt\ncfg\n.worktrees/\n");
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const EMPTY = { copied: [], missing: [], kept: [], refused: [], tracked: [], linked: [], unignored: [] };

describe("the include list", () => {
  test("drops comments and blanks, normalises, and refuses anything that leaves the repository", () => {
    const { paths, refused } = includeList("# local files\n.env\n./config/local.json/\n\n../../.ssh/id_rsa\n/etc/passwd\n~/.netrc\nC:\\secrets\nnode_modules/.cache\n");
    expect(paths).toEqual([".env", "config/local.json", "node_modules/.cache"]);
    expect(refused).toEqual(["../../.ssh/id_rsa", "/etc/passwd", "~/.netrc", "C:\\secrets"]);
  });
});

describe("seeding", () => {
  test("copies files and directories named, keeps what the worktree already has, notes what the main checkout lacks", () => {
    writeFileSync(join(root, ".worktreeinclude"), ".env\nlocal/\nmissing.txt\nkeep.txt\n");
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    mkdirSync(join(root, "local")); writeFileSync(join(root, "local", "a.json"), "{}");
    writeFileSync(join(root, "keep.txt"), "root's");
    writeFileSync(join(wt, "keep.txt"), "git's");
    const r = seedWorktree(root, wt);
    expect(r.copied).toEqual([".env", "local"]);
    expect(r.kept).toEqual(["keep.txt"]);
    expect(r.missing).toEqual(["missing.txt"]);
    expect(readFileSync(join(wt, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(readFileSync(join(wt, "local", "a.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(wt, "keep.txt"), "utf8"), "git's copy wins").toBe("git's");
    expect(lstatSync(join(wt, ".env")).isSymbolicLink(), "a copy, never a link").toBe(false);
    expect(seedSummary(r)).toBe("seeded .env, local · kept keep.txt · missing in the main checkout: missing.txt");
  });
  test("a tracked path is git's and is not copied; no include file means nothing happens", () => {
    writeFileSync(join(root, ".worktreeinclude"), "README.md\n.env\n");
    writeFileSync(join(root, "README.md"), "tracked");
    writeFileSync(join(root, ".env"), "x");
    const r = seedWorktree(root, wt, (rel) => rel === "README.md");
    expect(r.tracked).toEqual(["README.md"]);
    expect(r.copied).toEqual([".env"]);
    expect(existsSync(join(wt, "README.md"))).toBe(false);
    rmSync(join(root, ".worktreeinclude"));
    const none = seedWorktree(root, mkdtempSync(join(home, "none-")));
    expect(none).toEqual(EMPTY);
  });
  test("every place a worktree is cut seeds it", async () => {
    const gitwork = await Bun.file(new URL("../src/gitwork.ts", import.meta.url)).text();
    expect((gitwork.match(/seedFrom\(root, abs\)/g) ?? []).length, "both verbs in gitwork").toBe(2);
    const loop = await Bun.file(new URL("../src/understudy-loop.ts", import.meta.url)).text();
    expect(loop).toContain("says: seedSummary(seedFrom(repo, path))");
  });
});

describe("the real path, not the spelling", () => {
  test("the audit's shape: `cfg -> ../..` plus `cfg/secret/id_key` copies nothing out of the home directory", () => {
    symlinkSync("../..", join(root, "cfg"));
    writeFileSync(join(root, ".worktreeinclude"), "cfg/secret/id_key\n");
    // Every string check the old code made passes here: the spelling stays
    // inside the repository. Measured: git itself will not answer for a path
    // through a link ("pathspec is beyond a symbolic link", exit 128), so
    // the ignore rule alone would already refuse this — the walk is what
    // names the reason, and what holds if the ignore answer is ever faked.
    expect(gitIgnored(root, "cfg/secret/id_key")).toBe(false);
    const r = seedWorktree(root, wt, () => false, () => true);
    expect(r.linked).toEqual(["cfg/secret/id_key"]);
    expect(r.copied).toEqual([]);
    expect(existsSync(join(wt, "cfg")), "nothing was created under the worktree").toBe(false);
    expect(readdirSync(home).sort()).toEqual(["repo", "secret"]);
    expect(seedSummary(r)).toBe("refused (a symlink, or through one): cfg/secret/id_key");
  });
  test("an entry that is itself a symlink is refused, not reproduced as a pointer back into the main checkout", () => {
    symlinkSync(join(home, "secret", "id_key"), join(root, ".env"));
    writeFileSync(join(root, ".worktreeinclude"), ".env\n");
    const r = seedWorktree(root, wt);
    expect(r.linked).toEqual([".env"]);
    expect(() => lstatSync(join(wt, ".env"))).toThrow();
  });
  test("a link inside a copied directory is left behind and named", () => {
    mkdirSync(join(root, "local"));
    writeFileSync(join(root, "local", "a.json"), "{}");
    symlinkSync(join(home, "secret", "id_key"), join(root, "local", "key"));
    writeFileSync(join(root, ".worktreeinclude"), "local\n");
    const r = seedWorktree(root, wt);
    expect(r.copied).toEqual(["local"]);
    expect(r.linked).toEqual(["local/key"]);
    expect(readdirSync(join(wt, "local"))).toEqual(["a.json"]);
  });
  test("a symlink on the destination side is the same hole from the other direction", () => {
    mkdirSync(join(root, "cfg")); writeFileSync(join(root, "cfg", ".env"), "x");
    mkdirSync(join(home, "elsewhere"));
    symlinkSync(join(home, "elsewhere"), join(wt, "cfg"));
    writeFileSync(join(root, ".worktreeinclude"), "cfg/.env\n");
    const r = seedWorktree(root, wt);
    expect(r.linked).toEqual(["cfg/.env"]);
    expect(readdirSync(join(home, "elsewhere"))).toEqual([]);
  });
  test("a repository reached through an alias still seeds — the comparison is real path to real path", () => {
    symlinkSync(root, join(home, "alias"));
    writeFileSync(join(root, ".worktreeinclude"), ".env\n");
    writeFileSync(join(root, ".env"), "x");
    const r = seedWorktree(join(home, "alias"), wt);
    expect(r.copied).toEqual([".env"]);
    expect(readFileSync(join(wt, ".env"), "utf8")).toBe("x");
  });
  test("an include file that is itself a link is not read", () => {
    writeFileSync(join(home, "evil-include"), ".env\n");
    symlinkSync(join(home, "evil-include"), join(root, ".worktreeinclude"));
    writeFileSync(join(root, ".env"), "x");
    expect(seedWorktree(root, wt)).toEqual(EMPTY);
  });
});

describe("only what git ignores", () => {
  test("an untracked file git would happily track is not copied, and the summary says why", () => {
    writeFileSync(join(root, ".worktreeinclude"), "notes-local\n.env\n");
    writeFileSync(join(root, "notes-local"), "not ignored");
    writeFileSync(join(root, ".env"), "ignored");
    const r = seedWorktree(root, wt);
    expect(r.unignored).toEqual(["notes-local"]);
    expect(r.copied).toEqual([".env"]);
    expect(existsSync(join(wt, "notes-local"))).toBe(false);
    expect(seedSummary(r)).toBe("seeded .env · not ignored by git, not copied: notes-local");
  });
  test("a root that is not a repository at all seeds nothing — git has no word to give", () => {
    const plain = mkdtempSync(join(home, "plain-"));
    writeFileSync(join(plain, ".worktreeinclude"), ".env\n");
    writeFileSync(join(plain, ".env"), "x");
    expect(gitIgnored(plain, ".env")).toBe(false);
    const r = seedWorktree(plain, wt);
    expect(r.unignored).toEqual([".env"]);
    expect(existsSync(join(wt, ".env"))).toBe(false);
  });
  test("the injected answer is what decides, so the copy can be exercised against a fake", () => {
    writeFileSync(join(root, ".worktreeinclude"), "anything\n");
    writeFileSync(join(root, "anything"), "x");
    expect(seedWorktree(root, wt, () => false, () => true).copied).toEqual(["anything"]);
    expect(seedWorktree(root, mkdtempSync(join(home, "wt2-")), () => false, () => false).unignored).toEqual(["anything"]);
  });
});
