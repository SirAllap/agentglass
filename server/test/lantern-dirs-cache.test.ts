/*
 * THE REMEMBERED GIT DIRS OF A CHECKOUT, DROPPED WHEN THE CHECKOUT IS SWAPPED.
 *
 * lantern.ts keeps each path's `--git-dir`/`--git-common-dir` so git is not
 * asked on every poll. A worktree removed and another repository made at the
 * same path used to keep the old answer for the life of the server, so the
 * ref stamps read the wrong repository's HEAD. Now the cached git dir must
 * still exist and the path's own .git must still lead to it.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "agx-dirs-"));
process.env.AGENTGLASS_DB = join(dir, "dirs.db");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
delete process.env.AGENTGLASS_ROOT;

/* A counting git first on PATH, as in lantern-landed-cache.test.ts. */
const binDir = join(dir, "bin");
mkdirSync(binDir);
const logFile = join(dir, "git-calls.log");
writeFileSync(logFile, "");
writeFileSync(join(binDir, "git"), `#!/bin/sh\necho "$@" >> "${logFile}"\nexec /usr/bin/git "$@"\n`);
chmodSync(join(binDir, "git"), 0o755);
const ORIGINAL_PATH = process.env.PATH;
process.env.PATH = `${binDir}:${process.env.PATH}`;

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: "pipe" });
const repoAt = (p: string) => {
  mkdirSync(p, { recursive: true });
  sh("/usr/bin/git init -q -b main", p);
  sh("/usr/bin/git -c user.email=t@t -c user.name=t commit --allow-empty -q -m first", p);
};
const dirsAsked = () => readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes("--git-common-dir")).length;

const repo1 = join(dir, "repo1");
const tree = join(dir, "tree");
let lantern: typeof import("../src/lantern.ts");

beforeAll(async () => {
  lantern = await import("../src/lantern.ts");
  repoAt(repo1);
  sh(`/usr/bin/git worktree add -q -b side ${tree}`, repo1);
});

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("dirsOf's cache", () => {
  test("asks git once while the checkout stays the same", async () => {
    lantern.__resetGitFacts();
    await lantern.__gitFactsFor(tree, "", 0);
    await lantern.__gitFactsFor(tree, "", 60_000);
    expect(dirsAsked()).toBe(1);
  });

  test("asks again when the worktree is replaced by a plain repo at the same path", async () => {
    // rm -rf, not `worktree remove`: repo1's worktree metadata stays, so the old git dir still exists.
    rmSync(tree, { recursive: true, force: true });
    repoAt(tree);
    await lantern.__gitFactsFor(tree, "", 120_000);
    expect(dirsAsked()).toBe(2);
  });

  test("dirsStillHold: a .git file pointing elsewhere, or a gone git dir, does not hold", () => {
    const fake = join(dir, "fake");
    mkdirSync(join(fake, "a"), { recursive: true });
    mkdirSync(join(fake, "b"), { recursive: true });
    mkdirSync(join(fake, "co"), { recursive: true });
    writeFileSync(join(fake, "co", ".git"), `gitdir: ${join(fake, "b")}\n`);
    expect(lantern.dirsStillHold(join(fake, "co"), join(fake, "b"))).toBe(true);
    expect(lantern.dirsStillHold(join(fake, "co"), join(fake, "a"))).toBe(false);
    expect(lantern.dirsStillHold(join(fake, "co"), join(fake, "gone"))).toBe(false);
  });
});
