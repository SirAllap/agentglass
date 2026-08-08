// What the copy of a pull request's branch on THIS machine looks like, and
// which of those states may be written to.
//
// "Update branch" merges the base into the head on GitHub. The local branch is
// a commit behind the moment it succeeds, and until now nothing said so. The
// second half of that button is allowed to move a local ref forward, so the
// question "is this safe" has to be answered by git rather than by hope —
// against real repositories, because every one of these verdicts is a fact
// about refs, worktrees and a dirty index that a fixture would only assert.
//
// The verdicts, and why each is what it is:
//   absent    no such branch here — nothing to do, and no sentence to show
//   ff        it can be fast-forwarded (checked out or not)
//   diverged  it has commits the remote does not, so no fast-forward exists
//   dirty     checked out with uncommitted work — someone is standing in it
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, realpathSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localHead, fastForwardLocal } from "../src/prs.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-localhead-")));
const ORIGIN = join(dir, "origin.git");
const REPO = join(dir, "repo");

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

beforeAll(() => {
  mkdirSync(ORIGIN);
  git(ORIGIN, "init", "-q", "--bare", "-b", "main");
  git(dir, "clone", "-q", ORIGIN, REPO);
  commit(REPO, "a.txt", "a");
  git(REPO, "push", "-q", "-u", "origin", "main");

  // Three branches, pushed, so each has an upstream to be measured against.
  for (const b of ["behind-one", "diverged-one", "dirty-one"]) {
    git(REPO, "checkout", "-q", "-b", b);
    commit(REPO, `${b}.txt`, b);
    git(REPO, "push", "-q", "-u", "origin", b);
  }
  git(REPO, "checkout", "-q", "main");

  // Someone else moves all three on the remote — this is what `gh pr
  // update-branch` does, from the point of view of this checkout.
  const other = join(dir, "other");
  git(dir, "clone", "-q", ORIGIN, "other");
  for (const b of ["behind-one", "diverged-one", "dirty-one"]) {
    git(other, "checkout", "-q", b);
    commit(other, `${b}-remote.txt`, "from the other side");
    git(other, "push", "-q", "origin", b);
  }
  git(REPO, "fetch", "-q", "origin");

  // And locally: one branch gets a commit that was never pushed, one gets a
  // dirty working tree, and one is left alone.
  git(REPO, "checkout", "-q", "diverged-one");
  commit(REPO, "mine.txt", "not pushed");
  git(REPO, "checkout", "-q", "dirty-one");
  writeFileSync(join(REPO, "dirty-one.txt"), "edited, not committed");
});

describe("the local copy of a branch", () => {
  test("a branch that is not here at all", async () => {
    const st = await localHead(REPO, "no-such-branch");
    expect(st).toMatchObject({ exists: false, sync: "absent" });
  });

  test("behind its remote, checked out nowhere: a fast-forward", async () => {
    // The nice case — the ref can move with no working tree involved.
    const st = await localHead(REPO, "behind-one");
    expect(st.exists).toBe(true);
    expect(st.worktree).toBeUndefined();
    expect(st.ahead).toBe(0);
    expect(st.behind).toBe(1);
    expect(st.sync).toBe("ff");
  });

  test("commits the remote has not got: diverged, and left alone", async () => {
    const st = await localHead(REPO, "diverged-one");
    expect(st.ahead).toBe(1);
    expect(st.behind).toBe(1);
    expect(st.sync).toBe("diverged");
  });

  test("checked out with uncommitted work: dirty, and left alone", async () => {
    const st = await localHead(REPO, "dirty-one");
    expect(st.worktree).toBe(REPO);
    expect(st.dirty).toBe(true);
    expect(st.sync).toBe("dirty");
  });

  test("checked out and clean: still a fast-forward", async () => {
    // Same branch as the dirty case, once the edit is put away — so this pins
    // the difference to the working tree and nothing else.
    git(REPO, "checkout", "-q", "--", "dirty-one.txt");
    const st = await localHead(REPO, "dirty-one");
    expect(st.dirty).toBe(false);
    expect(st.worktree).toBe(REPO);
    expect(st.sync).toBe("ff");
  });

  test("a checkout in the middle of a merge is not somewhere to fast-forward into", async () => {
    // A real conflicted merge, left in progress.
    git(REPO, "checkout", "-q", "-b", "conflicted");
    commit(REPO, "clash.txt", "ours");
    git(REPO, "checkout", "-q", "-b", "conflicted-other", "HEAD~1");
    commit(REPO, "clash.txt", "theirs");
    git(REPO, "checkout", "-q", "conflicted");
    git(REPO, "merge", "conflicted-other");
    const st = await localHead(REPO, "conflicted");
    expect(st.sync).toBe("busy");
    git(REPO, "merge", "--abort");
  });

  test("moving a branch nobody has checked out touches no working tree", async () => {
    // The whole point of the refspec form: `behind-one` is not checked out, so
    // this moves a ref while the checkout stays on whatever it was on.
    const was = git(REPO, "rev-parse", "--abbrev-ref", "HEAD");
    const before = git(REPO, "rev-parse", "behind-one");
    const said = await fastForwardLocal(REPO, await localHead(REPO, "behind-one"));
    expect(said).toContain("moved up too");
    expect(git(REPO, "rev-parse", "behind-one")).not.toBe(before);
    expect(git(REPO, "rev-parse", "behind-one")).toBe(git(REPO, "rev-parse", "origin/behind-one"));
    expect(git(REPO, "rev-parse", "--abbrev-ref", "HEAD")).toBe(was);
    // And it is idempotent: pressing twice is not an error.
    expect(await fastForwardLocal(REPO, await localHead(REPO, "behind-one"))).toContain("moved up too");
  });

  test("moving the branch you are standing in is the pull you would have done", async () => {
    git(REPO, "checkout", "-q", "dirty-one");
    const before = git(REPO, "rev-parse", "HEAD");
    const said = await fastForwardLocal(REPO, await localHead(REPO, "dirty-one"));
    expect(said).toContain("your checkout of dirty-one moved up too");
    expect(git(REPO, "rev-parse", "HEAD")).not.toBe(before);
    expect(git(REPO, "rev-parse", "HEAD")).toBe(git(REPO, "rev-parse", "origin/dirty-one"));
    git(REPO, "checkout", "-q", "main");
  });

  test("it refuses rather than rewriting when there is no fast-forward", async () => {
    // Belt and braces: `diverged-one` never reaches this call in the app,
    // because the verdict stops it. If it ever did, git — not us — is what
    // stands between a stale button and somebody's unpushed commit.
    const before = git(REPO, "rev-parse", "diverged-one");
    const st = await localHead(REPO, "diverged-one");
    const said = await fastForwardLocal(REPO, { ...st, sync: "ff" });
    expect(said).toContain("did not move");
    expect(git(REPO, "rev-parse", "diverged-one")).toBe(before);
  });

  test("a branch with no upstream at all counts as nothing to compare", async () => {
    git(REPO, "checkout", "-q", "-b", "orphan-branch");
    git(REPO, "checkout", "-q", "main");
    const st = await localHead(REPO, "orphan-branch");
    expect(st.exists).toBe(true);
    expect(st.ahead).toBe(0);
    expect(st.behind).toBe(0);
    // Nothing to fast-forward FROM, but the verdict still has to be a safe one:
    // the sync step asks for the upstream again and says so.
    expect(st.sync).toBe("ff");
  });
});
