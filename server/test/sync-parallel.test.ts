// "Update branch & pull" on several pull requests of one repository at once.
//
// GitHub merges the base into each head on its own; the only local half is
// the fast-forward of a checkout, and that half has to keep two promises:
//   - a pull request's sync moves ITS branch and nothing else — never the
//     checkout of another pull request, never the branch another one is on;
//   - two syncs that reach the SAME checkout take turns instead of fighting
//     over its index.
// Real repositories, because both promises are facts about refs and worktrees.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, realpathSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localHead, fastForwardLocal } from "../src/prs.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-syncpar-")));
const ORIGIN = join(dir, "origin.git");
const REPO = join(dir, "repo");
const WT = { "pr-a": join(dir, "wt-a"), "pr-b": join(dir, "wt-b") } as const;

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  return new TextDecoder().decode(r.stdout).trim();
}

const commit = (cwd: string, file: string, body: string) => {
  writeFileSync(join(cwd, file), body);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `add ${file}`);
};

const BRANCHES = ["pr-a", "pr-b", "pr-c"];

beforeAll(() => {
  mkdirSync(ORIGIN);
  git(ORIGIN, "init", "-q", "--bare", "-b", "main");
  git(dir, "clone", "-q", ORIGIN, REPO);
  commit(REPO, "base.txt", "base");
  git(REPO, "push", "-q", "-u", "origin", "main");
  for (const b of BRANCHES) {
    git(REPO, "checkout", "-q", "-b", b, "main");
    commit(REPO, `${b}.txt`, b);
    git(REPO, "push", "-q", "-u", "origin", b);
  }
  git(REPO, "checkout", "-q", "main");
  // pr-a and pr-b are checked out in worktrees of their own; pr-c nowhere.
  git(REPO, "worktree", "add", "-q", WT["pr-a"], "pr-a");
  git(REPO, "worktree", "add", "-q", WT["pr-b"], "pr-b");

  // "The base merged into each head on GitHub": a commit per branch, each with
  // its own file, so what a checkout received says whose merge it was.
  const other = join(dir, "other");
  git(dir, "clone", "-q", ORIGIN, "other");
  for (const b of BRANCHES) {
    git(other, "checkout", "-q", b);
    commit(other, `${b}-merged-base.txt`, `base merged into ${b}`);
    git(other, "push", "-q", "origin", b);
  }
}, 30_000);

const head = (cwd: string, ref = "HEAD") => git(cwd, "rev-parse", ref);
const syncOne = async (b: string) => fastForwardLocal(REPO, await localHead(REPO, b));

describe("two pull requests of one repository, synced together", () => {
  test("each branch receives only its own base merge", async () => {
    // Fetch once so the remote-tracking refs are what GitHub has now.
    git(REPO, "fetch", "-q", "origin");
    const said = await Promise.all(BRANCHES.map(syncOne));
    for (const s of said) expect(s).toContain("moved up too");

    for (const b of BRANCHES) {
      expect(head(REPO, b)).toBe(head(REPO, `origin/${b}`));
      // Its own merge is in it, and nobody else's.
      const files = git(REPO, "ls-tree", "-r", "--name-only", b).split("\n");
      expect(files).toContain(`${b}-merged-base.txt`);
      for (const other of BRANCHES.filter((o) => o !== b)) {
        expect(files).not.toContain(`${other}-merged-base.txt`);
        expect(files).not.toContain(`${other}.txt`);
      }
    }
  }, 30_000);

  test("each checkout ends at its own head and shows only its own files", () => {
    for (const b of ["pr-a", "pr-b"] as const) {
      expect(head(WT[b])).toBe(head(REPO, `origin/${b}`));
      expect(existsSync(join(WT[b], `${b}-merged-base.txt`))).toBe(true);
    }
    expect(existsSync(join(WT["pr-a"], "pr-b-merged-base.txt"))).toBe(false);
    expect(existsSync(join(WT["pr-b"], "pr-a-merged-base.txt"))).toBe(false);
    // The main checkout was never a party to any of it.
    expect(git(REPO, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });
});

describe("two syncs that reach the same checkout", () => {
  test("take turns: every one of them finishes without an index fight", async () => {
    const other = join(dir, "other");
    // Give the checkout something real to move: many files in one commit.
    for (let i = 0; i < 300; i++) writeFileSync(join(other, `bulk-${i}.txt`), String(i));
    git(other, "checkout", "-q", "pr-a");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "bulk");
    git(other, "push", "-q", "origin", "pr-a");
    git(REPO, "fetch", "-q", "origin");

    const st = await localHead(REPO, "pr-a");
    expect(st.worktree).toBe(WT["pr-a"]);
    const said = await Promise.all([1, 2, 3, 4].map(() => fastForwardLocal(REPO, st)));
    for (const s of said) expect(s).toContain("moved up too");
    expect(head(WT["pr-a"])).toBe(head(REPO, "origin/pr-a"));
  }, 30_000);
});
