/*
 * "Another git process seems to be running in this repository."
 *
 * Driven against real repositories in a temp directory, because every
 * interesting case here is a filesystem shape: a `.git` that is a file rather
 * than a directory, a lock nested under refs/, a path that looks like it is
 * inside a checkout and is not. None of those can be faked convincingly enough
 * to be worth faking.
 *
 * The one thing that IS stubbed is "is a git running", because the alternative
 * is starting a real git and racing it — see pane-routes.test.ts for what a
 * test that starts a real agent costs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allCheckouts, gitDirOf, gitLocks, removeStaleLock } from "../src/gitlocks.ts";

let boxes: string[] = [];
afterEach(() => { for (const b of boxes) rmSync(b, { recursive: true, force: true }); boxes = []; });

function box(): string {
  const d = mkdtempSync(join(tmpdir(), "agx-locks-"));
  boxes.push(d);
  return d;
}

/** A checkout of the ordinary kind: `.git` is a directory. */
function repo(dir: string, name = "repo"): string {
  const root = join(dir, name);
  mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
  return root;
}

/**
 * A linked worktree, as `git worktree add` really leaves it.
 *
 * THREE files, not one, and the first version of this fixture wrote only the
 * first — which made the expansion tests fail against correct code:
 *
 *   · `<wt>/.git`                          → `gitdir: <common>/worktrees/<name>`
 *   · `<common>/worktrees/<name>/gitdir`   → `<wt>/.git`   (the way back OUT)
 *   · `<common>/worktrees/<name>/commondir`→ `../..`       (to the shared dir)
 *
 * The second is the registry entry, and it is what makes a worktree findable
 * from anywhere but itself. Verified against a real repository before being
 * written down here.
 */
function linked(dir: string, name = "wt"): { root: string; gitDir: string } {
  const main = repo(dir, "main");
  const gitDir = join(main, ".git", "worktrees", name);
  mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, ".git"), `gitdir: ${gitDir}\n`);
  writeFileSync(join(gitDir, "gitdir"), `${join(root, ".git")}\n`);
  writeFileSync(join(gitDir, "commondir"), "../..\n");
  return { root, gitDir };
}

describe("finding the git directory", () => {
  test("an ordinary checkout keeps it in .git", () => {
    const d = box(); const root = repo(d);
    expect(gitDirOf(root)).toBe(join(root, ".git"));
  });

  test("a linked worktree points at its own, not the main repo's", () => {
    // The whole correctness of the module. A linked worktree has its own index
    // and therefore its own index.lock; reading the main repo's .git would
    // report one worktree's lock against every other one and miss the stuck
    // one.
    const d = box(); const { root, gitDir } = linked(d);
    expect(gitDirOf(root)).toBe(gitDir);
  });

  test("a .git pointing nowhere is not a git directory", () => {
    const d = box(); const root = join(d, "moved");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".git"), "gitdir: /nope/does/not/exist\n");
    expect(gitDirOf(root)).toBeNull();
  });

  test("a directory that is not a checkout at all", () => {
    expect(gitDirOf(box())).toBeNull();
  });
});

describe("finding every checkout from any one of them", () => {
  /*
   * The scan was handed the directories agents had actually worked in, which on
   * a real machine was two — while the repository had six linked worktrees
   * registered, and a second repository more than twenty. A panel that looks in
   * a fifteenth of your checkouts and reports an empty list is worse than no
   * panel: "nothing is stuck" is what it says either way.
   *
   * Git keeps the registry on disk (`<common>/worktrees/<name>/gitdir`), so
   * none of this runs git. Measured at full coverage on that machine: 2-4ms for
   * thirty checkouts, against a 2.5s poll.
   */
  test("the main repo brings its worktrees", () => {
    const d = box(); const { root } = linked(d);
    const main = join(d, "main");
    expect(allCheckouts([main]).sort()).toEqual([main, root].sort());
  });

  test("and a worktree brings the main repo AND its siblings", () => {
    // The case that matters most here: an agent may only ever have worked in
    // one worktree, so that is the only path telemetry knows. `commondir` is
    // the way back to everything else.
    const d = box(); const a = linked(d, "wt-a"); const b = linked(d, "wt-b");
    const main = join(d, "main");
    expect(allCheckouts([a.root]).sort()).toEqual([main, a.root, b.root].sort());
  });

  test("a worktree whose directory has been deleted is dropped", () => {
    // `git worktree prune` has not been run yet. A lock in a directory that no
    // longer exists is not something anybody can act on.
    const d = box(); const { root } = linked(d, "gone");
    const main = join(d, "main");
    rmSync(root, { recursive: true, force: true });
    expect(allCheckouts([main])).toEqual([main]);
  });

  test("a path that is not a checkout contributes nothing", () => {
    expect(allCheckouts([box()])).toEqual([]);
  });

  test("the same checkout reached twice appears once", () => {
    const d = box(); const { root } = linked(d);
    const main = join(d, "main");
    expect(allCheckouts([main, root, main]).length).toBe(2);
  });

  test("a lock in a worktree is found when only its sibling was known", () => {
    // End to end: this is the bug the expansion exists for.
    const d = box(); const a = linked(d, "wt-a"); const b = linked(d, "wt-b");
    writeFileSync(join(b.gitDir, "index.lock"), "");
    const r = gitLocks([a.root]);
    expect(r.locks.map((l) => l.repo)).toEqual([b.root]);
  });
});

describe("what is locked", () => {
  test("nothing locked is reported as nothing locked, with a count", () => {
    // An empty list has to be distinguishable from a sweep that never ran.
    const d = box(); const root = repo(d);
    const r = gitLocks([root]);
    expect(r.locks).toEqual([]);
    expect(r.scanned).toBe(1);
  });

  test("an index.lock is found, and called stale when no git is running", () => {
    const d = box(); const root = repo(d);
    writeFileSync(join(root, ".git", "index.lock"), "");
    const r = gitLocks([root]);
    expect(r.locks).toHaveLength(1);
    expect(r.locks[0]!.name).toBe("index.lock");
    expect(r.locks[0]!.repo).toBe(root);
    // No git process is running against a directory that was made a
    // millisecond ago, so this is the honest verdict rather than a lucky one.
    expect(r.locks[0]!.stale).toBe(true);
    expect(r.locks[0]!.heldBy).toBeNull();
  });

  test("a ref lock is found by its path under refs/", () => {
    const d = box(); const root = repo(d);
    writeFileSync(join(root, ".git", "refs", "heads", "main.lock"), "");
    expect(gitLocks([root]).locks[0]!.name).toBe("refs/heads/main.lock");
  });

  test("a linked worktree's lock is attributed to the worktree", () => {
    const d = box(); const { root, gitDir } = linked(d);
    writeFileSync(join(gitDir, "index.lock"), "");
    const r = gitLocks([root]);
    expect(r.locks).toHaveLength(1);
    expect(r.locks[0]!.repo).toBe(root);
  });

  test("the main repo is not blamed for its worktree's lock", () => {
    // Both are scanned together, which is the real situation on this machine:
    // a dozen checkouts of one project. A lock in the worktree must not appear
    // against the main repo as well.
    const d = box(); const { root, gitDir } = linked(d);
    const main = join(d, "main");
    writeFileSync(join(gitDir, "index.lock"), "");
    const r = gitLocks([main, root]);
    expect(r.locks.map((l) => l.repo)).toEqual([root]);
  });

  test("a repository listed twice is scanned once", () => {
    const d = box(); const root = repo(d);
    writeFileSync(join(root, ".git", "index.lock"), "");
    expect(gitLocks([root, root, root]).locks).toHaveLength(1);
  });

  test("a path that is not a checkout is skipped, not an error", () => {
    const d = box();
    expect(gitLocks([join(d, "nothing-here")]).scanned).toBe(0);
  });
});

describe("removing one", () => {
  test("a stale lock goes", () => {
    const d = box(); const root = repo(d);
    const lock = join(root, ".git", "index.lock");
    writeFileSync(lock, "");
    const r = removeStaleLock(lock, [root]);
    expect(r.ok).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  test("a linked worktree's lock is removed, even though its gitdir is inside the main repo's", () => {
    /*
     * The bug this exists for, found on a real worktree rather than here.
     *
     * A linked worktree keeps its git directory INSIDE the main checkout's:
     * `…/main/.git/worktrees/wt`. The first version tested the target path
     * against each root's git directory and took the first match — and the main
     * repo's `.git` is a prefix of every worktree's, so the main repo always
     * won. The lock was then looked for in the main repo, where it is not, and
     * the delete answered "there is no lock there any more" about a file that
     * was plainly still there. The scan, meanwhile, had attributed it perfectly.
     *
     * Both roots are passed here, main first, which is the order that broke it.
     */
    const d = box(); const { root, gitDir } = linked(d);
    const main = join(d, "main");
    const lock = join(gitDir, "index.lock");
    writeFileSync(lock, "");
    const r = removeStaleLock(lock, [main, root]);
    expect(r.ok, r.error).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  test("a path outside every known checkout is refused", () => {
    // This is what stops the route being an arbitrary-file-delete wearing a
    // git-shaped name.
    const d = box(); const root = repo(d);
    const outside = join(d, "elsewhere.lock");
    writeFileSync(outside, "");
    expect(removeStaleLock(outside, [root]).ok).toBe(false);
    expect(existsSync(outside)).toBe(true);
  });

  test("a sibling directory with a shared prefix is outside", () => {
    // `/tmp/x/repo-evil` starts with `/tmp/x/repo` as a *string* and is a
    // different directory. Matching on the string is the classic version of
    // this bug.
    const d = box(); const root = repo(d, "repo");
    const evil = repo(d, "repo-evil");
    const lock = join(evil, ".git", "index.lock");
    writeFileSync(lock, "");
    expect(removeStaleLock(lock, [root]).ok).toBe(false);
    expect(existsSync(lock)).toBe(true);
  });

  test("a file that is not a .lock is refused", () => {
    const d = box(); const root = repo(d);
    const index = join(root, ".git", "index");
    writeFileSync(index, "not a lock");
    expect(removeStaleLock(index, [root]).ok).toBe(false);
    expect(existsSync(index)).toBe(true);
  });

  test("a lock that has already gone says so rather than succeeding", () => {
    // Same answer as a path that was never a lock, and deliberately: from here
    // "it is gone" and "it was never one of ours" are the same fact — there is
    // no lock at that path in any checkout we know — and inventing a second
    // message would be claiming to know which.
    const d = box(); const root = repo(d);
    const r = removeStaleLock(join(root, ".git", "index.lock"), [root]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not a lock");
  });

  test("nonsense in, refusal out", () => {
    for (const bad of [null, undefined, 42, "", {}]) {
      expect(removeStaleLock(bad, ["/tmp"]).ok).toBe(false);
    }
  });

  test("a traversal out of the git directory is refused", () => {
    const d = box(); const root = repo(d);
    const outside = join(d, "escaped.lock");
    writeFileSync(outside, "");
    // Resolved before it is compared, so `..` cannot walk out of the checkout
    // and still look like it is inside one.
    expect(removeStaleLock(join(root, ".git", "..", "..", "escaped.lock"), [root]).ok).toBe(false);
    expect(existsSync(outside)).toBe(true);
  });
});
