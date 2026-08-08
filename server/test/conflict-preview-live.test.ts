/*
 * The panel said "merging is blocked" about a conflict that was already gone.
 *
 * Reported with both halves of the evidence: a terminal where the merge had
 * been resolved, committed and pushed, and a pull request page still showing
 * the red banner. Two separate things were true.
 *
 * One, the answer was cached for a minute and the minute had not passed. A
 * minute is right for a pull request nobody is touching and much too long for
 * the one you are working in — and the thing that changed is a ref on this
 * disk, which costs a rev-parse to read. So the clock is now the ceiling and
 * the local branch is the trigger.
 *
 * Two, before the push, GitHub was CORRECT: the merge commit existed only
 * here. The panel had no way to say so, and repeated GitHub's verdict while
 * standing on the disk that disagreed with it. `resolvedLocally` is that fact,
 * and it is the one that turns an unactionable red banner into "push this".
 *
 * Real repositories throughout: a merge conflict is not a thing to mock.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { conflictPreview } = await import("../src/gitwork.ts");

let dir = "";
let origin = "";
let clone = "";

const run = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t.test",
      GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t.test",
    },
  });
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout) };
};

const write = (repo: string, name: string, body: string) => {
  writeFileSync(join(repo, name), body);
  run(repo, "add", name);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-cpl-"));
  origin = join(dir, "origin.git");
  clone = join(dir, "work");

  // A bare origin with a base branch and a feature branch that conflicts on
  // one file — the shape of the pull request this came from.
  const seed = join(dir, "seed");
  mkdirSync(seed, { recursive: true });
  run(seed, "init", "-q", "-b", "main");
  write(seed, "urls.py", "a\nb\nc\n");
  run(seed, "commit", "-qm", "base");

  run(seed, "checkout", "-q", "-b", "feature");
  write(seed, "urls.py", "a\nFEATURE\nc\n");
  run(seed, "commit", "-qm", "feature");

  run(seed, "checkout", "-q", "main");
  write(seed, "urls.py", "a\nMAIN\nc\n");
  run(seed, "commit", "-qm", "main moves");

  run(dir, "clone", "-q", "--bare", seed, origin);
  run(dir, "clone", "-q", origin, clone);
  run(clone, "checkout", "-q", "-b", "feature", "origin/feature");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("what would conflict", () => {
  it("names the file, from git rather than from GitHub", async () => {
    const r = await conflictPreview(clone, "main", "feature");
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual(["urls.py"]);
    expect(r.resolvedLocally).toBeUndefined();
  });

  it("notices when you have already merged the base in, here", async () => {
    // Exactly what happened: resolve in a worktree, commit, do not push.
    await conflictPreview(clone, "main", "feature"); // warm the cache first
    run(clone, "merge", "--no-commit", "origin/main");
    write(clone, "urls.py", "a\nMAIN\nFEATURE\nc\n");
    run(clone, "commit", "-qm", "merge main into feature");

    const r = await conflictPreview(clone, "main", "feature");
    expect(r.resolvedLocally?.branch).toBe("feature");
    /*
     * Two, not one: the merge commit AND the base commit it brought in. That
     * is what `git push` would send and what GitHub would receive, so it is
     * the honest number for a line that says "ahead of what GitHub has" — the
     * count of merges you performed would be a different and less useful fact.
     */
    expect(r.resolvedLocally?.ahead).toBe(2);
  });

  it("stops saying so once it is pushed", async () => {
    run(clone, "merge", "--no-commit", "origin/main");
    write(clone, "urls.py", "a\nMAIN\nFEATURE\nc\n");
    run(clone, "commit", "-qm", "merge main into feature");
    run(clone, "push", "-q", "origin", "feature");

    const r = await conflictPreview(clone, "main", "feature");
    // Pushed, so there is nothing left to conflict about and nothing to push.
    expect(r.conflicts).toEqual([]);
    expect(r.clean).toBe(true);
  });
});

describe("how quickly it notices", () => {
  it("does not wait out its own cache when the branch has moved", async () => {
    /*
     * The bug. The first answer is cached for a minute; the resolution happens
     * a few seconds later; the panel keeps showing the old verdict. A test that
     * slept for the TTL would be measuring the clock, so this measures the
     * thing that makes the clock unnecessary: the local branch moved, so the
     * cached answer is not reused.
     */
    const before = await conflictPreview(clone, "main", "feature");
    expect(before.conflicts).toEqual(["urls.py"]);

    run(clone, "merge", "--no-commit", "origin/main");
    write(clone, "urls.py", "a\nMAIN\nFEATURE\nc\n");
    run(clone, "commit", "-qm", "merge main into feature");
    run(clone, "push", "-q", "origin", "feature");

    // Same call, well inside the sixty seconds. It has to answer with the
    // world as it is now.
    const after = await conflictPreview(clone, "main", "feature");
    expect(after.conflicts).toEqual([]);
    expect(after.clean).toBe(true);
  });

  it("still uses the cache when nothing has moved", async () => {
    // The cache is not being thrown away — a pull request nobody is touching
    // must not fetch on every poll. Same tip, same answer object.
    const a = await conflictPreview(clone, "main", "feature");
    const b = await conflictPreview(clone, "main", "feature");
    expect(b).toBe(a);
  });
});
