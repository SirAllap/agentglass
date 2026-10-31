/*
 * A session resolved a pull request's conflict, pushed, and the panel went on
 * saying "merging is blocked" and "1 commit ahead of what GitHub has".
 *
 * The preview is cached against the LOCAL branch tip, and a push does not move
 * that: the answer stayed valid for its whole minute. The push itself is the
 * event, so noting it drops the answers; no poll is added.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { conflictPreview } = await import("../src/gitwork.ts");
const { notePush } = await import("../src/pushSeen.ts");

let dir = "";
let clone = "";

const run = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t.test" },
  }).exitCode;

const write = (repo: string, name: string, body: string) => { writeFileSync(join(repo, name), body); run(repo, "add", name); };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-push-"));
  const origin = join(dir, "origin.git");
  clone = join(dir, "work");
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

describe("a push lands", () => {
  it("clears 'resolved here, not pushed' and the conflict at once", async () => {
    // Resolve locally: merge main into feature, keep the feature side.
    run(clone, "fetch", "-q", "origin");
    run(clone, "merge", "-q", "origin/main", "-X", "ours", "-m", "merge main");
    const before = await conflictPreview(clone, "main", "feature");
    expect(before.resolvedLocally?.ahead).toBe(2);

    run(clone, "push", "-q", "origin", "feature");
    // The local tip did not move, so the cache still holds the old answer.
    expect((await conflictPreview(clone, "main", "feature")).resolvedLocally).toBeDefined();

    notePush(clone, "git push origin feature");
    const after = await conflictPreview(clone, "main", "feature");
    expect(after.resolvedLocally).toBeUndefined();
    expect(after.conflicts).toEqual([]);
    expect(after.clean).toBe(true);
  });

  it("is not moved by a dry run or by a command that merely mentions push", async () => {
    run(clone, "fetch", "-q", "origin");
    run(clone, "merge", "-q", "origin/main", "-X", "ours", "-m", "merge main");
    await conflictPreview(clone, "main", "feature");
    run(clone, "push", "-q", "origin", "feature");
    notePush(clone, "git push --dry-run origin feature");
    notePush(clone, 'echo "remember to git push"');
    expect((await conflictPreview(clone, "main", "feature")).resolvedLocally).toBeDefined();
  });
});
