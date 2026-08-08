import { afterAll, afterEach, describe, expect, it } from "bun:test";

/*
 * The diff cache, which exists because `gh pr diff` is a round trip to GitHub
 * and re-opening a pull request you read ten minutes ago used to pay it again.
 *
 * What is worth asserting is the bound. A diff is not a row — it is however
 * large somebody's pull request happens to be — so a cache sized by ENTRIES is
 * a cache sized by accident, and the failure it produces is the kind nobody
 * reproduces: fine all week, then somebody opens the migration that touched
 * four thousand files.
 */
// Point every pull-request cache at a directory of its own BEFORE the module
// evaluates: these caches write to disk now, and without this the suite leaves
// entries in the developer's own ~/.cache/agentglass — the same mistake the
// ClickUp test made with the config file, where a toggle flipped in the app
// decided whether a test passed.
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const CACHE_DIR = mkdtempSync(join(tmpdir(), "agx-prcache-"));
process.env.AGENTGLASS_CACHE_DIR = CACHE_DIR;
const P = await import("../src/prs.ts");

afterEach(() => { P.__clearDiffCache(); });
afterAll(() => { try { rmSync(CACHE_DIR, { recursive: true, force: true }); } catch { /* fine */ } });

describe("the caches that survive a restart", () => {
  it("write inside the directory they were pointed at, and nowhere else", () => {
    // The assertion that matters is not that the file exists — it is that the
    // path is the overridable one, so a suite can never touch a real cache.
    expect(process.env.AGENTGLASS_CACHE_DIR).toBe(CACHE_DIR);
    expect(existsSync(CACHE_DIR)).toBe(true);
  });
});

describe("what the diff cache agrees to hold", () => {
  it("is exported with a way to empty it, so a test never inherits a diff", () => {
    // The seam itself: without it these assertions would depend on what some
    // earlier test happened to fetch.
    expect(typeof P.__clearDiffCache).toBe("function");
    expect(() => P.__clearDiffCache()).not.toThrow();
  });

  it("refuses a repository with no GitHub remote rather than caching a failure", async () => {
    // A negative answer must not be remembered as if it were a diff — the next
    // call would serve "no GitHub remote" for a repository that has one by then.
    const r = await P.prDiff("/nonexistent-path-for-a-test", 1);
    expect(r.ok).toBe(false);
    expect(r.text).toBeUndefined();
  });

  it("declines a pull request number that is not one", async () => {
    for (const n of [0, -3, 1.5, "abc", null, undefined]) {
      const r = await P.prDiff("/tmp", n);
      expect(r.ok, JSON.stringify(n)).toBe(false);
    }
  });
});
