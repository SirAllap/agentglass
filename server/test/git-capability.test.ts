import { afterEach, describe, expect, it } from "bun:test";
import { gitCapability, gitBin, __resetGitCapForTest } from "../src/git.ts";

/**
 * Whether git is on this machine, told apart from "no repos here".
 *
 * The whole git/diff/PR/terminal story assumes git exists, and Bun.spawn
 * *throws* on a missing binary rather than returning 127 — so without this
 * probe the panels silently blame the repo. These drive both answers by
 * flipping PATH, which is exactly what an installer user without git hits.
 */
const realPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = realPath;
  __resetGitCapForTest();
});

describe("git capability", () => {
  it("reports git as available on a machine that has it (the CI runner does)", () => {
    __resetGitCapForTest();
    const cap = gitCapability();
    expect(cap.available).toBe(true);
    // A version string when we could read one; never a reason, since nothing is wrong.
    expect(cap.reason).toBeUndefined();
    expect(typeof gitBin()).toBe("string");
  });

  it("caches within the window, so the repo picker asking on every mount is one probe", () => {
    __resetGitCapForTest();
    const a = gitCapability();
    const b = gitCapability();
    expect(a).toBe(b); // same object identity — served from cache
  });

  it("reports git as MISSING when it is not on PATH, with an actionable reason", () => {
    // The installer-user case: git simply is not installed. Bun.which("git")
    // returns null against an empty PATH.
    process.env.PATH = "";
    __resetGitCapForTest();
    const cap = gitCapability();
    expect(cap.available).toBe(false);
    expect(cap.version).toBeUndefined();
    expect(cap.reason && cap.reason.length).toBeGreaterThan(0);
    expect(gitBin()).toBeNull();
  });

  it("always answers with a shape the client can read", () => {
    __resetGitCapForTest();
    const cap = gitCapability();
    expect(typeof cap.available).toBe("boolean");
    if (!cap.available) expect(typeof cap.reason).toBe("string");
  });
});
