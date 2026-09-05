/*
 * Which checkout a container came out of.
 *
 * This is the answer to "why isn't my change showing up" on a machine with
 * twenty worktrees, so the two ways to get it wrong both matter: claiming a
 * container is yours when it is a sibling's, and claiming a sibling's when it
 * is yours. The prefix test is where that happens — `~/code/orbit` and
 * `~/code/orbit-1042` are different checkouts whose paths share a prefix, and
 * every worktree on this machine is named exactly like that.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetBranchCacheForTest, branchOfCheckout, ownerOf } from "../src/dockerowner.ts";

const made: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "agx-owner-"));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  __resetBranchCacheForTest();
});

describe("matching a working_dir to a checkout", () => {
  const family = ["/home/dev/code/orbit", "/home/dev/code/orbit-1042", "/home/dev/code/orbit-landing"];

  test("the stack's directory is inside the checkout that owns it", () => {
    const o = ownerOf("/home/dev/code/orbit-1042/compose", family, "/home/dev/code/orbit-1042");
    expect(o).toMatchObject({ worktree: "orbit-1042", foreign: false, path: "/home/dev/code/orbit-1042" });
  });

  /* The bug this whole function exists to avoid: `startsWith` puts
     orbit-1042 inside orbit, and then every sibling worktree's containers get
     reported as the open project's. */
  test("a sibling whose name shares a prefix is NOT inside it", () => {
    const o = ownerOf("/home/dev/code/orbit-1042/compose", family, "/home/dev/code/orbit");
    expect(o!.worktree).toBe("orbit-1042");
    expect(o!.foreign).toBe(true);
  });

  test("the narrower root wins when two contain it", () => {
    // A monorepo package can be a legitimate, deliberately narrow project root.
    const nested = [...family, "/home/dev/code/orbit/packages/api"];
    expect(ownerOf("/home/dev/code/orbit/packages/api/compose", nested, null)!.worktree).toBe("api");
  });

  test("a directory nobody knows is named, not guessed", () => {
    const o = ownerOf("/opt/somebody-elses-stack", family, "/home/dev/code/orbit");
    expect(o).toMatchObject({ worktree: "somebody-elses-stack", branch: null, foreign: true });
  });

  test("no label at all means no owner", () => {
    expect(ownerOf(null, family, "/home/dev/code/orbit")).toBe(null);
    expect(ownerOf("", family, "/home/dev/code/orbit")).toBe(null);
    // Old compose versions wrote relative values; a relative path cannot be
    // matched against absolute roots without inventing a base for it.
    expect(ownerOf("compose", family, "/home/dev/code/orbit")).toBe(null);
  });

  test("with no project open, nothing is foreign", () => {
    expect(ownerOf("/home/dev/code/orbit-1042/compose", family, null)!.foreign).toBe(false);
  });
});

describe("reading the branch without spawning git", () => {
  test("a plain checkout", () => {
    const d = tmp();
    mkdirSync(join(d, ".git"), { recursive: true });
    writeFileSync(join(d, ".git/HEAD"), "ref: refs/heads/feat/docker-cockpit\n");
    expect(branchOfCheckout(d)).toBe("feat/docker-cockpit");
  });

  /* A linked worktree's `.git` is a file pointing at its own gitdir. Reading
     the main repo's HEAD instead would report one branch for every worktree —
     which is the same as reporting nothing, only harder to notice. */
  test("a linked worktree follows its gitdir file", () => {
    const d = tmp();
    const gitdir = join(d, "gitdirs", "wt");
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/feat/bench\n");
    mkdirSync(join(d, "tree"), { recursive: true });
    writeFileSync(join(d, "tree/.git"), `gitdir: ${gitdir}\n`);
    expect(branchOfCheckout(join(d, "tree"))).toBe("feat/bench");
  });

  test("a relative gitdir is resolved against the checkout", () => {
    const d = tmp();
    mkdirSync(join(d, "wt"), { recursive: true });
    mkdirSync(join(d, "store"), { recursive: true });
    writeFileSync(join(d, "store/HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(d, "wt/.git"), "gitdir: ../store\n");
    expect(branchOfCheckout(join(d, "wt"))).toBe("main");
  });

  test("a detached HEAD has no branch, and that is not an error", () => {
    const d = tmp();
    mkdirSync(join(d, ".git"), { recursive: true });
    writeFileSync(join(d, ".git/HEAD"), "9f2c1e4d5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c0d\n");
    expect(branchOfCheckout(d)).toBe(null);
  });

  test("neither does a directory that is not a checkout", () => {
    expect(branchOfCheckout(tmp())).toBe(null);
    expect(branchOfCheckout("/nowhere/at/all")).toBe(null);
  });

  test("the answer is cached, so twelve containers from one tree read it once", () => {
    const d = tmp();
    mkdirSync(join(d, ".git"), { recursive: true });
    writeFileSync(join(d, ".git/HEAD"), "ref: refs/heads/first\n");
    expect(branchOfCheckout(d)).toBe("first");
    writeFileSync(join(d, ".git/HEAD"), "ref: refs/heads/second\n");
    expect(branchOfCheckout(d)).toBe("first");      // within the window
    __resetBranchCacheForTest();
    expect(branchOfCheckout(d)).toBe("second");     // and it does move on
  });
});
