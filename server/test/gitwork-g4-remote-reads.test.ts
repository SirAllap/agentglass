/*
 * Reads the branches/remotes/tags panel needs: which tags a remote holds, the
 * files of a stash, and the worktree actions around locks, submodules and
 * busy checkouts. Fixture: a working repo tracking a bare local remote.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identify } from "./gitIdentity.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-g4-")));
process.env.AGENTGLASS_ROOT = dir;
const { tagsOrigin, stashFiles, stashList, unlockWorktree, removeWorktree, addWorktree, worktreesWithState, submoduleAdd } =
  await import("../src/gitwork.ts");

let repo = "";
let remote = "";
const at = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args], { cwd });
const git = (...args: string[]) => at(repo, ...args);

function build(): void {
  const id = Math.random().toString(36).slice(2);
  repo = join(dir, `orbit-${id}`);
  remote = join(dir, `remote-${id}.git`);
  Bun.spawnSync(["mkdir", "-p", repo]);
  git("init", "-q", "-b", "main", ".");
  identify(repo);
  git("init", "-q", "--bare", remote);
  git("remote", "add", "origin", remote);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  git("push", "-q", "origin", "main");
}

// Local-path submodule URLs need protocol.file.allow, for the server's own git calls too.
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
process.env.GIT_CONFIG_VALUE_0 = "always";

beforeEach(build);
afterAll(() => {
  delete process.env.GIT_CONFIG_COUNT;
  delete process.env.GIT_CONFIG_KEY_0;
  delete process.env.GIT_CONFIG_VALUE_0;
  rmSync(dir, { recursive: true, force: true });
});

const verdict = async (ms?: number) => Object.fromEntries((await tagsOrigin(repo, ms)).map((t) => [t.name, t]));

describe("tagsOrigin", () => {
  it("tells a pushed tag from a local-only one", async () => {
    git("tag", "v1.0");
    git("tag", "v2.0");
    git("push", "-q", "origin", "v1.0");
    const v = await verdict();
    expect(v["v1.0"]).toEqual({ name: "v1.0", onOrigin: "yes", remote: "origin" });
    expect(v["v2.0"]).toEqual({ name: "v2.0", onOrigin: "no" });
  });

  it("an unreachable remote is unknown, never 'no'", async () => {
    git("tag", "v1.0");
    git("remote", "set-url", "origin", join(dir, "gone.git"));
    expect((await verdict())["v1.0"]).toEqual({ name: "v1.0", onOrigin: "unknown" });
  });

  it("one silent remote keeps an unheld tag unknown, but a hit on the other still counts", async () => {
    git("tag", "v1.0");
    git("tag", "v2.0");
    git("push", "-q", "origin", "v1.0");
    git("remote", "add", "mirror", join(dir, "gone.git"));
    const v = await verdict();
    expect(v["v1.0"]).toEqual({ name: "v1.0", onOrigin: "yes", remote: "origin" });
    expect(v["v2.0"].onOrigin).toBe("unknown");
  });

  it("no remotes: every tag unknown", async () => {
    git("tag", "v1.0");
    git("remote", "remove", "origin");
    expect(await tagsOrigin(repo)).toEqual([{ name: "v1.0", onOrigin: "unknown" }]);
  });

  it("a remote past the deadline is unknown", async () => {
    git("tag", "v1.0");
    // A hung server: the ext transport runs a command that sleeps.
    const slow = join(dir, "slow.sh");
    writeFileSync(slow, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    git("remote", "set-url", "origin", "ext::" + slow);
    git("config", "protocol.ext.allow", "always");
    const t0 = Date.now();
    expect((await verdict(300))["v1.0"].onOrigin).toBe("unknown");
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("stashFiles", () => {
  it("lists the files a stash touches with their status", () => {
    writeFileSync(join(repo, "a.txt"), "changed\n");
    writeFileSync(join(repo, "b.txt"), "new\n");
    git("add", "b.txt");
    git("stash", "push", "-q", "-m", "wip");
    const hash = git("rev-parse", "stash@{0}").stdout.toString().trim();
    const files = stashFiles(repo, hash);
    expect(files).toContainEqual({ status: "M", path: "a.txt" });
    expect(files).toContainEqual({ status: "A", path: "b.txt" });
    expect(stashList(repo)).toHaveLength(1);
  });

  it("refuses anything that is not a hash", () => {
    expect(stashFiles(repo, "--output=x.txt")).toEqual([]);
    expect(stashFiles(repo, "HEAD")).toEqual([]);
  });
});

describe("worktree unlock and force remove", () => {
  const sibling = () => `${repo}-feat`;

  it("unlocks a locked worktree so it can be removed", async () => {
    expect(addWorktree(repo, sibling(), "feat", true).ok).toBe(true);
    git("worktree", "lock", sibling());
    expect((await worktreesWithState(repo)).find((w) => w.path === sibling())?.locked).toBe(true);
    expect(removeWorktree(repo, sibling(), false).ok).toBe(false);
    expect(unlockWorktree(repo, sibling()).ok).toBe(true);
    expect((await worktreesWithState(repo)).find((w) => w.path === sibling())?.locked).toBe(false);
    expect(removeWorktree(repo, sibling(), false).ok).toBe(true);
  });

  it("refuses to unlock a path that is not a worktree of this repo", () => {
    const r = unlockWorktree(repo, join(dir, "elsewhere"));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not a worktree");
  });

  it("a worktree with a submodule needs force, and force removes it", () => {
    const lib = join(dir, `lib-${Math.random().toString(36).slice(2)}`);
    Bun.spawnSync(["mkdir", "-p", lib]);
    at(lib, "init", "-q", "-b", "main", ".");
    writeFileSync(join(lib, "x.txt"), "x\n");
    at(lib, "add", "-A");
    at(lib, "commit", "-qm", "lib");
    expect(submoduleAdd(repo, lib, "lib").ok).toBe(true);
    git("commit", "-qm", "add lib");
    expect(addWorktree(repo, sibling(), "feat", true).ok).toBe(true);
    at(sibling(), "submodule", "update", "--init");
    const plain = removeWorktree(repo, sibling(), false);
    expect(plain.ok).toBe(false);
    expect(plain.error).toContain("submodule");
    expect(removeWorktree(repo, sibling(), true).ok).toBe(true);
  });
});

describe("worktree pid", () => {
  const linux = process.platform === "linux";

  (linux ? it : it.skip)("names a process whose cwd is inside the worktree, and only that one", async () => {
    expect(addWorktree(repo, `${repo}-busy`, "busy", true).ok).toBe(true);
    const child = Bun.spawn(["sleep", "30"], { cwd: `${repo}-busy` });
    try {
      const rows = await worktreesWithState(repo);
      const busy = rows.find((w) => w.path === `${repo}-busy`)!;
      expect(busy.pid).toBe(child.pid);
      expect(busy.busy).toBe(true);
      const main = rows.find((w) => w.current)!;
      expect(main.pid).toBeUndefined();
      expect(main.busy).toBeUndefined();
    } finally { child.kill(); await child.exited; }
  });
});
