/*
 * `workingTree()` lists untracked files with `git ls-files --others
 * --exclude-standard`, which walks every directory not already known to be
 * fully untracked. Left on git's cold path, that walk repeats in full on
 * every poll of an open Source Control panel — the most expensive single
 * thing this app asks of git, asked over and over of the same answer.
 *
 * The fix caches the RESULT in this process rather than asking git to cache
 * it — this app only reads other people's repositories, and it does not get
 * to write `core.untrackedCache` (or anything else) into one. This suite
 * checks the cache actually holds across a repeat call, that it never
 * touches the repo's config, and that our own writes (staging a file here)
 * still show up without a stale answer.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repo: string;
let gw: typeof import("../src/gitwork.ts");

const run = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "agx-untracked-cache-"));
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.email", "t@example.com");
  run(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "tracked.txt"), "one\n");
  run(repo, "add", "-A");
  run(repo, "commit", "-qm", "first");
  writeFileSync(join(repo, "loose.txt"), "new\n");

  process.env.AGENTGLASS_ROOT = repo;
  gw = await import("../src/gitwork.ts");
});

afterAll(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* fine */ } });

describe("untracked file listing", () => {
  it("finds the untracked file, and never writes to the repo's own config", async () => {
    const tree = await gw.workingTree(repo);
    expect(tree.unstaged.map((c) => c.status)).toContain("untracked");
    expect(tree.unstaged.find((c) => c.status === "untracked")?.file_path).toContain("loose.txt");

    const after = run(repo, "config", "--get", "core.untrackedCache").stdout.trim();
    expect(after).not.toBe("true");
  });

  it("holds the cached answer across a repeat poll, and drops it the instant we stage a file ourselves", async () => {
    gw.invalidateRepos(repo); // start from a clean cache, not the previous test's
    writeFileSync(join(repo, "second.txt"), "two\n");
    const before = await gw.workingTree(repo);
    expect(before.unstaged.find((c) => c.file_path.endsWith("second.txt"))).toBeTruthy();

    // A file dropped in by something outside this process (an editor, a
    // terminal) shouldn't appear until the cache's TTL lapses.
    writeFileSync(join(repo, "third.txt"), "three\n");
    const stillCached = await gw.workingTree(repo);
    expect(stillCached.unstaged.find((c) => c.file_path.endsWith("third.txt"))).toBeFalsy();

    // But a mutation this app performs itself invalidates the cache right away.
    gw.stage(repo, ["second.txt"]);
    const afterStage = await gw.workingTree(repo);
    expect(afterStage.staged.find((c) => c.file_path.endsWith("second.txt"))).toBeTruthy();
    expect(afterStage.unstaged.find((c) => c.file_path.endsWith("third.txt"))).toBeTruthy();
  });
});
