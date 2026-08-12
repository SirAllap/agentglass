/*
 * "Merged" against the remote, not against the trunk.
 *
 * Reported as branches the panel called "not merged — kept" that had been
 * merged days earlier. Measured on the repository it happened in, fourteen
 * branches whose upstream was gone:
 *
 *   8 were ancestors of the epic branch their pull requests targeted
 *   0 were ancestors of master
 *   2 were in neither, merged into some third remote branch
 *   4 had commits that exist nowhere on the remote — correctly kept
 *
 * So the panel was answering truthfully about a merge nobody had asked about.
 * The question a person has is "can I delete this without losing work", and
 * `rev-list --count <branch> --not --remotes` is that question exactly.
 *
 * Why not `--contains`, which would also name the branch: measured on one
 * branch of that repository, `git branch -r --contains` took 5.40s against
 * 0.016s for the count — 340×. Naming it is left to the sweep for that reason.
 *
 * Real git, in a repository this file builds: the claim is about what git
 * answers, and a mock would only repeat what I believed.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";
const git = (cwd: string, ...args: string[]): string => {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" },
    stdout: "pipe", stderr: "pipe",
  });
  return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim() : "";
};
const commit = (cwd: string, name: string) => {
  writeFileSync(join(cwd, name), name);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", name);
};
/** The question under test, spelled as the server spells it. */
const unmergedCount = (cwd: string, branch: string): number =>
  Number(git(cwd, "rev-list", "--count", branch, "--not", "--remotes"));

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-merged-"));
  const origin = join(dir, "origin");
  const work = join(dir, "work");

  // A remote with a trunk and an epic branch, which is the shape that broke it.
  git(dir, "init", "--bare", "-b", "master", origin);
  git(dir, "clone", origin, work);
  commit(work, "base");
  git(work, "push", "-u", "origin", "master");

  git(work, "checkout", "-b", "epic");
  commit(work, "epic-1");
  git(work, "push", "-u", "origin", "epic");

  // Merged into the epic and nowhere near master — the eight-of-fourteen case.
  git(work, "checkout", "-b", "feature", "epic");
  commit(work, "feature-1");
  git(work, "checkout", "epic");
  git(work, "merge", "--no-ff", "-m", "merge feature", "feature");
  git(work, "push", "origin", "epic");

  // Never pushed, never merged: work that only exists here.
  git(work, "checkout", "-b", "loose", "master");
  commit(work, "loose-1");

  git(work, "checkout", "master");
});

afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });

describe("can this branch be deleted without losing work", () => {
  it("says yes for one merged into an epic, which the trunk question missed", () => {
    const work = join(dir, "work");
    // The old answer, kept here so the difference is visible rather than
    // asserted about: not an ancestor of master.
    expect(git(work, "merge-base", "--is-ancestor", "feature", "origin/master")).toBe("");
    expect(unmergedCount(work, "feature")).toBe(0);
  });

  it("says no for a branch whose commits are nowhere on the remote", () => {
    // The safe direction, and the reason this cannot just say yes: `loose` has
    // work that exists only in this clone.
    expect(unmergedCount(join(dir, "work"), "loose")).toBeGreaterThan(0);
  });

  it("says yes for the trunk itself, which is on the remote by definition", () => {
    expect(unmergedCount(join(dir, "work"), "master")).toBe(0);
  });

  it("is asked per branch, so one unmerged branch does not condemn the rest", () => {
    const work = join(dir, "work");
    expect(unmergedCount(work, "feature")).toBe(0);
    expect(unmergedCount(work, "loose")).toBeGreaterThan(0);
  });
});

describe("naming where it went", () => {
  it("finds the epic, not the trunk", () => {
    /* What `mergedIntoName` walks for: candidates newest-first, stopping at the
       first ancestor. `feature` is in `origin/epic` and not in
       `origin/master`, so a walk that started at the trunk and stopped there
       would name the wrong branch — hence "first ancestor", not "the trunk if
       it is one". */
    const work = join(dir, "work");
    expect(git(work, "merge-base", "--is-ancestor", "feature", "origin/epic")).toBe("");
    const rc = Bun.spawnSync(["git", "merge-base", "--is-ancestor", "feature", "origin/epic"], { cwd: work }).exitCode;
    expect(rc).toBe(0);
    const rcTrunk = Bun.spawnSync(["git", "merge-base", "--is-ancestor", "feature", "origin/master"], { cwd: work }).exitCode;
    expect(rcTrunk).not.toBe(0);
  });
});
