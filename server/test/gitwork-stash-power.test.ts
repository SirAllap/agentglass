/*
 * Stash power-ups — rename (reflog rewrite), to-branch, partial stash, and
 * apply-overwrite. The rename rewrites `logs/refs/stash` directly because no
 * porcelain can change an existing entry's message; the prefix ("On main: " /
 * "WIP on main: ") is preserved so a row keeps saying which branch it came
 * from.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identify } from "./gitIdentity.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-stashpw-")));
process.env.AGENTGLASS_ROOT = dir;
const {
  stashList, stashPush, stashRename, stashToBranch, stashPartial, stashApplyOverwrite, stashDrop, stashPutBack, workingTree, deleteBranch, renameBranch,
} = await import("../src/gitwork.ts");

let repo = "";
const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd: repo });

function commit(file: string, msg: string): void {
  writeFileSync(join(repo, file), msg + "\n");
  git("add", "-A");
  git("commit", "-qm", msg);
}

function build(): void {
  repo = join(dir, `r-${Math.random().toString(36).slice(2)}`);
  Bun.spawnSync(["mkdir", "-p", repo]);
  git("init", "-q", "-b", "main", ".");
  identify(repo);
  commit("a.txt", "first");
  commit("b.txt", "second");
}

const subjects = async (): Promise<string[]> => (await stashList(repo)).map((s) => s.message);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("stash power-ups", () => {
  beforeEach(build);

  it("renames a stash, keeping the branch prefix", async () => {
    writeFileSync(join(repo, "b.txt"), "dirty\n");
    git("stash", "push", "-q", "-m", "half-done work");
    expect((await stashRename(repo, 0, "better label")).ok).toBe(true);
    expect((await subjects())[0]).toBe("On main: better label");
    // The stash is still applyable — only the message changed.
    expect((await stashApplyOverwrite(repo, 0)).ok).toBe(true);
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("dirty\n");
  });

  it("renames a default stash, keeping the WIP prefix", async () => {
    writeFileSync(join(repo, "b.txt"), "dirty\n");
    git("stash", "push", "-q");
    const before = (await subjects())[0];
    expect(before).toMatch(/^WIP on main: /);
    expect((await stashRename(repo, 0, "my wip")).ok).toBe(true);
    expect((await subjects())[0]).toBe("WIP on main: my wip");
  });

  it("renames an entry by index, not just the top of the stack", async () => {
    writeFileSync(join(repo, "b.txt"), "dirty one\n");
    git("stash", "push", "-q", "-m", "older stash");
    writeFileSync(join(repo, "a.txt"), "newer\n");
    git("stash", "push", "-q", "-m", "newer stash");
    expect((await stashRename(repo, 1, "old one relabeled")).ok).toBe(true);
    expect((await subjects())[0]).toBe("On main: newer stash");
    expect((await subjects())[1]).toBe("On main: old one relabeled");
  });

  it("refuses a blank rename or a bad index", async () => {
    writeFileSync(join(repo, "b.txt"), "dirty\n");
    git("stash", "push", "-q", "-m", "x");
    expect((await stashRename(repo, 0, "   ")).ok).toBe(false);
    expect((await stashRename(repo, 5, "x")).ok).toBe(false);
    expect((await subjects())[0]).toBe("On main: x");
  });

  it("turns a stash into a branch: base + applied + dropped", async () => {
    writeFileSync(join(repo, "b.txt"), "dirty\n");
    git("stash", "push", "-q", "-m", "feature work");
    expect((await stashToBranch(repo, 0, "from-stash")).ok).toBe(true);
    // New branch checked out, with the stash's change applied.
    expect(git("branch", "--show-current").stdout.toString().trim()).toBe("from-stash");
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("dirty\n");
    // And the stash is gone.
    expect(await stashList(repo)).toHaveLength(0);
  });

  it("refuses to branch onto an existing branch", async () => {
    writeFileSync(join(repo, "b.txt"), "dirty\n");
    git("stash", "push", "-q", "-m", "x");
    expect((await stashToBranch(repo, 0, "main")).ok).toBe(false);
    expect(await stashList(repo)).toHaveLength(1);
  });

  it("stashes only the picked paths", async () => {
    writeFileSync(join(repo, "a.txt"), "A changed\n");
    writeFileSync(join(repo, "b.txt"), "B changed\n");
    const r = await stashPartial(repo, ["a.txt"]);
    expect(r.ok).toBe(true);
    // a.txt moved off the tree into the stash; b.txt stayed dirty.
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("first\n");
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("B changed\n");
    expect(await stashList(repo)).toHaveLength(1);
  });

  it("keep-index leaves the picked files in the working tree (staged)", async () => {
    writeFileSync(join(repo, "a.txt"), "A changed\n");
    writeFileSync(join(repo, "b.txt"), "B changed\n");
    expect((await stashPartial(repo, ["a.txt"], true)).ok).toBe(true);
    // "stash & keep": the file stays in the working tree, staged for the
    // commit — the stash holds a copy, the tree holds another.
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("A changed\n");
    const st = git("status", "--porcelain").stdout.toString();
    expect(st).toContain("M  a.txt"); // staged — the kept copy
    expect(st).toContain(" M b.txt"); // still dirty — never picked
    expect((await stashDrop(repo, 0)).ok).toBe(true);
  });

  it("refuses empty path lists", async () => {
    expect((await stashPartial(repo, [])).ok).toBe(false);
    expect((await stashPartial(repo, ["../outside.txt"])).ok).toBe(false);
  });

  it("apply-overwrite replaces a file the working tree has moved on", async () => {
    writeFileSync(join(repo, "a.txt"), "A changed\n");
    git("stash", "push", "-q", "-m", "a-work");
    // The working tree moves on at the same path — a plain apply would refuse.
    writeFileSync(join(repo, "a.txt"), "newer local edit\n");
    expect(git("stash", "apply", "stash@{0}").exitCode).not.toBe(0);
    expect((await stashApplyOverwrite(repo, 0)).ok).toBe(true);
    // The stash's version wins.
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("A changed\n");
  });

  it("apply-overwrite clears untracked files the stash would create", async () => {
    writeFileSync(join(repo, "a.txt"), "A changed\n");
    writeFileSync(join(repo, "new.txt"), "brand new\n");
    git("stash", "push", "-q", "-u", "-m", "with new file");
    writeFileSync(join(repo, "new.txt"), "locally created later\n");
    expect((await stashApplyOverwrite(repo, 0)).ok).toBe(true);
    expect(readFileSync(join(repo, "new.txt"), "utf8")).toBe("brand new\n");
  });
});

describe("stash put back", () => {
  beforeEach(build);
  const rd = (f: string) => readFileSync(join(repo, f), "utf8");

  it("undoes a clashing apply, keeps the stash and the work in progress that was there before", async () => {
    commit("d.txt", "third");
    writeFileSync(join(repo, "a.txt"), "from the stash\n");
    writeFileSync(join(repo, "b.txt"), "also stashed\n");
    git("stash", "push", "-q", "-m", "clash");
    commit("a.txt", "committed meanwhile");
    writeFileSync(join(repo, "d.txt"), "work in progress\n");
    expect(Bun.spawnSync(["git", "stash", "apply"], { cwd: repo }).exitCode).not.toBe(0);
    expect(rd("a.txt")).toContain("<<<<<<<");
    const r = await stashPutBack(repo);
    expect(r.ok).toBe(true);
    expect(rd("a.txt")).toBe("committed meanwhile\n");
    expect(rd("b.txt")).toBe("second\n");
    expect(rd("d.txt")).toBe("work in progress\n");
    expect(git("status", "--porcelain").stdout.toString().trim()).toBe("M d.txt");
    expect(await subjects()).toEqual(["On main: clash"]);
  });

  it("the tree names a file a stash apply left in conflict, so the panel can offer to resolve it", async () => {
    writeFileSync(join(repo, "a.txt"), "mine\n");
    git("stash", "push", "-q", "-m", "clash");
    commit("a.txt", "committed meanwhile");
    expect(Bun.spawnSync(["git", "stash", "apply"], { cwd: repo }).exitCode).not.toBe(0);
    // A conflicted file prints as `diff --cc`; before it was named, the tree said clean.
    const t = await workingTree(repo);
    expect(t.clean).toBe(false);
    expect(t.unstaged.filter((c) => c.status === "unmerged").map((c) => c.file_path)).toEqual([join(repo, "a.txt")]);
  });

  it("refuses when nothing is in conflict", async () => {
    writeFileSync(join(repo, "b.txt"), "staged by hand\n");
    git("add", "b.txt");
    const r = await stashPutBack(repo);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/nothing is in conflict/);
    expect(rd("b.txt")).toBe("staged by hand\n");
  });

  it("refuses a real merge conflict: reset --merge would drop MERGE_HEAD", async () => {
    git("checkout", "-q", "-b", "side");
    commit("a.txt", "side edit");
    git("checkout", "-q", "main");
    commit("a.txt", "main edit");
    expect(git("merge", "side").exitCode).not.toBe(0);
    const r = await stashPutBack(repo);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/in progress/);
    expect(Bun.spawnSync(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: repo }).exitCode).toBe(0);
  });
});

describe("branch delete and rename guards (server)", () => {
  beforeEach(build);
  it("refuses a protected branch and the checked-out one, deletes a plain one", async () => {
    git("branch", "feature/x");
    expect((await deleteBranch(repo, "main", true)).error).toMatch(/protected/);
    expect((await renameBranch(repo, "main", "trunk")).error).toMatch(/protected/);
    git("config", "agx.protectedbranches", "feature/x");
    expect((await deleteBranch(repo, "feature/x", true)).error).toMatch(/protected/);
    git("config", "--unset", "agx.protectedbranches");
    git("checkout", "-q", "-b", "wip");
    expect((await deleteBranch(repo, "wip", true)).error).toMatch(/checked out here/);
    expect((await deleteBranch(repo, "feature/x", true)).ok).toBe(true);
  });
});
