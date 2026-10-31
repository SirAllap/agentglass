/*
 * The merge was pushed and GitHub said MERGEABLE, with a head that contains
 * the base — and the panel said "2 files conflict" and "commits ahead of what
 * GitHub has". Its merge ran against a remote-tracking ref that was not where
 * GitHub's head was: the pull ref fetch failed, and the push had been made
 * outside any session that could tell the app. GitHub's head SHA is what the
 * merge is tried against when the caller has it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { conflictPreview } = await import("../src/gitwork.ts");

let dir = "";
let clone = "";

const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t.test" };
const run = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env }).exitCode;
const out = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env }).stdout.toString().trim();
const write = (repo: string, name: string, body: string) => { writeFileSync(join(repo, name), body); run(repo, "add", name); };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-ghhead-"));
  const origin = join(dir, "origin.git");
  clone = join(dir, "work");
  const seed = join(dir, "seed");
  mkdirSync(seed, { recursive: true });
  run(seed, "init", "-q", "-b", "main");
  write(seed, "urls.py", "a\nb\nc\n");
  write(seed, "views.py", "x\ny\nz\n");
  run(seed, "commit", "-qm", "base");
  run(seed, "checkout", "-q", "-b", "feature");
  write(seed, "urls.py", "a\nFEATURE\nc\n");
  write(seed, "views.py", "x\nFEATURE\nz\n");
  run(seed, "commit", "-qm", "feature");
  run(seed, "checkout", "-q", "main");
  write(seed, "urls.py", "a\nMAIN\nc\n");
  write(seed, "views.py", "x\nMAIN\nz\n");
  run(seed, "commit", "-qm", "main moves");
  run(dir, "clone", "-q", "--bare", seed, origin);
  run(dir, "clone", "-q", origin, clone);
  run(clone, "checkout", "-q", "-b", "feature", "origin/feature");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Merge main in, push it, then put the remote-tracking ref back where it was
 *  before the push — what a push made outside the app leaves behind. Returns
 *  the head GitHub has. */
function pushedThenStale(): string {
  const old = out(clone, "rev-parse", "origin/feature");
  run(clone, "merge", "-q", "origin/main", "-X", "ours", "-m", "merge main");
  run(clone, "push", "-q", "origin", "feature");
  const pushed = out(clone, "rev-parse", "feature");
  run(clone, "update-ref", "refs/remotes/origin/feature", old);
  return pushed;
}

describe("a merge pushed outside the app", () => {
  it("is judged against GitHub's head: no conflict, nothing unpushed", async () => {
    const githubHead = pushedThenStale();
    // 530 has no refs/pull/530/head on this origin, so the ref fetch fails and
    // the stale remote-tracking ref is all the disk has.
    const v = await conflictPreview(clone, "main", "feature", 530, githubHead);
    expect(v.conflicts).toEqual([]);
    expect(v.resolvedLocally).toBeUndefined();
    expect(v.headSha).toBe(githubHead);
  });

  it("without GitHub's head, the stale ref still claims both", async () => {
    pushedThenStale();
    const v = await conflictPreview(clone, "main", "feature", 530);
    expect(v.conflicts.length).toBe(2);
    expect(v.resolvedLocally?.ahead).toBeGreaterThan(0);
  });

  it("fetches GitHub's head by SHA when no ref brought it down", async () => {
    // Cloned before the push, so the pushed commit is not on this disk.
    const other = join(dir, "other");
    run(dir, "clone", "-q", join(dir, "origin.git"), other);
    const githubHead = pushedThenStale();
    expect(run(other, "cat-file", "-e", `${githubHead}^{commit}`)).not.toBe(0);
    const v = await conflictPreview(other, "main", "feature", 530, githubHead);
    expect(v.headSha).toBe(githubHead);
    expect(v.conflicts).toEqual([]);
  });
});
