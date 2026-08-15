/*
 * Submodules — the three-source read (gitlink + .gitmodules + status), and
 * the write ops: add, update, sync, deinit, remove. Fixture: a nested repo
 * added via the engine itself. Local-path URLs need protocol.file.allow,
 * which the fixture sets on every git call that touches a submodule URL.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identify } from "./gitIdentity.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-submod-")));
process.env.AGENTGLASS_ROOT = dir;
// protocol.file.allow is only honored from system/global config — never write
// that into the real user's ~/.gitconfig, so give the test run its own.
process.env.GIT_CONFIG_GLOBAL = join(dir, ".gitconfig");
const {
  submodules, submoduleAdd, submoduleUpdate, submoduleSync, submoduleDeinit, submoduleRemove, commitStaged,
} = await import("../src/gitwork.ts");

let repo = "";
let libPath = "";

const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
const gitAny = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd });

function commit(cwd: string, file: string, msg: string): void {
  writeFileSync(join(cwd, file), msg + "\n");
  gitAny(cwd, "add", "-A");
  gitAny(cwd, "commit", "-qm", msg);
}

function build(): void {
  repo = join(dir, `r-${Math.random().toString(36).slice(2)}`);
  libPath = join(dir, `lib-${Math.random().toString(36).slice(2)}`);
  Bun.spawnSync(["mkdir", "-p", repo]);
  git("init", "-q", "-b", "main", ".");
  identify(repo);
  // Local-path submodule URLs need this, or git 2.38+ refuses the clone.
  git("config", "--global", "protocol.file.allow", "always");
  commit(repo, "a.txt", "first");
  Bun.spawnSync(["mkdir", "-p", libPath]);
  gitAny(libPath, "init", "-q", "-b", "main", ".");
  identify(libPath);
  commit(libPath, "x.txt", "lib init");
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("submodules", () => {
  beforeEach(build);

  it("adds a submodule and reads it back", () => {
    const r = submoduleAdd(repo, libPath, "vendor/lib");
    expect(r.ok).toBe(true);
    expect(submodules(repo).some((s) => s.path === "vendor/lib")).toBe(true);
    const s = submodules(repo)[0];
    expect(s.url).toBe(libPath);
    expect(s.status).toBe("clean");
    expect(s.sha).toHaveLength(40);
    expect(existsSync(join(repo, "vendor", "lib", "x.txt"))).toBe(true);
  });

  it("flags a submodule whose checkout moved on as modified", () => {
    submoduleAdd(repo, libPath, "lib");
    commit(join(repo, "lib"), "x.txt", "nested change");
    const s = submodules(repo)[0];
    expect(s.status).toBe("modified");
  });

  it("update re-checks a deinitialized submodule back out", async () => {
    submoduleAdd(repo, libPath, "lib");
    const pin = submodules(repo)[0].sha;
    expect(submoduleDeinit(repo, "lib").ok).toBe(true);
    expect(existsSync(join(repo, "lib", "x.txt"))).toBe(false);
    expect(submodules(repo)[0].status).toBe("uninitialized");
    const r = await submoduleUpdate(repo, "lib");
    expect(r.ok).toBe(true);
    const back = submodules(repo)[0];
    expect(back.status).toBe("clean");
    expect(back.sha).toBe(pin);
    expect(existsSync(join(repo, "lib", "x.txt"))).toBe(true);
  });

  it("sync re-writes the checkout URL", async () => {
    submoduleAdd(repo, libPath, "lib");
    // Move the nested repo, point .gitmodules at the new location.
    const moved = libPath + "-moved";
    Bun.spawnSync(["mv", libPath, moved]);
    const url = moved;
    git("config", "-f", ".gitmodules", "submodule.lib.url", url);
    expect(submoduleSync(repo, "lib").ok).toBe(true);
    expect(gitAny(join(repo, "lib"), "config", "--get", "remote.origin.url").stdout.toString().trim()).toBe(url);
  });

  it("remove deletes the gitlink, the checkout and the .gitmodules section", () => {
    submoduleAdd(repo, libPath, "lib");
    expect(submoduleRemove(repo, "lib").ok).toBe(true);
    expect(submodules(repo)).toHaveLength(0);
    expect(existsSync(join(repo, "lib"))).toBe(false);
    expect(existsSync(join(repo, ".gitmodules"))).toBe(false);
    // The add was staged but never committed, so the removal leaves the tree
    // exactly where it started — clean, nothing staged.
    expect(git("status", "--porcelain").stdout.toString().trim()).toBe("");
  });

  it("remove keeps .gitmodules when other submodules remain", () => {
    submoduleAdd(repo, libPath, "lib");
    commit(repo, "b.txt", "second");
    const lib2 = join(dir, `lib2-${Math.random().toString(36).slice(2)}`);
    Bun.spawnSync(["mkdir", "-p", lib2]);
    gitAny(lib2, "init", "-q", "-b", "main", ".");
    identify(lib2);
    commit(lib2, "y.txt", "lib2 init");
    expect(submoduleAdd(repo, lib2, "vendor2").ok).toBe(true);
    expect(submoduleRemove(repo, "lib").ok).toBe(true);
    expect(submodules(repo).map((s) => s.path)).toEqual(["vendor2"]);
    expect(existsSync(join(repo, ".gitmodules"))).toBe(true);
  });

  it("refuses a second add at an existing path", () => {
    submoduleAdd(repo, libPath, "lib");
    expect(submoduleAdd(repo, libPath, "lib").ok).toBe(false);
  });

  it("commit still works next to submodules", () => {
    submoduleAdd(repo, libPath, "lib");
    writeFileSync(join(repo, "c.txt"), "third\n");
    git("add", "-A");
    expect(commitStaged(repo, "third", "").ok).toBe(true);
  });
});
