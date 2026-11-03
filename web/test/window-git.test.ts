/*
 * Which branch a window is on: the deepest worktree that holds its directory.
 */
import { describe, expect, test } from "bun:test";
import { branchAt } from "../src/lib/windowGit.ts";

const trees = [
  { path: "/code/acme-orbit", branch: "main" },
  { path: "/code/acme-orbit-wt/feat-x", branch: "feat/x" },
  { path: "/code/acme-orbit/vendor/lib", branch: "(detached)" },
];

describe("branchAt", () => {
  test("a directory inside the repo takes the repo's branch", () => {
    expect(branchAt(trees, "/code/acme-orbit/server")).toBe("main");
  });
  test("a linked worktree wins for its own directory", () => {
    expect(branchAt(trees, "/code/acme-orbit-wt/feat-x/web")).toBe("feat/x");
  });
  test("a sibling path that only shares a prefix is not inside", () => {
    expect(branchAt(trees, "/code/acme-orbit-two")).toBeNull();
  });
  test("a detached worktree names no branch and falls back to the parent", () => {
    expect(branchAt(trees, "/code/acme-orbit/vendor/lib/src")).toBe("main");
  });
});
