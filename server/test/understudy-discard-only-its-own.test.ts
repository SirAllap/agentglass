/*
 * The route that deletes a directory may only delete one it made.
 *
 * `discardRun` finishes with `rm(path, { recursive: true, force: true })`, and
 * the path arrived in the request body. Nothing looked at it. So any directory
 * on the machine was a valid argument to a route whose entire job is deleting
 * one, and same-origin was the only thing in the way — no bug needed, just a
 * request.
 *
 * A worktree this server cut is the only thing this feature creates and the
 * only thing it may destroy.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
const route = (() => {
  const from = src.indexOf('pathname === "/understudy/work/discard"');
  const next = src.indexOf("if (pathname ===", from + 20);
  return src.slice(from, next === -1 ? from + 2500 : next);
})();

describe("a path in a request body is not permission to delete it", () => {
  test("the worktree has to belong to a recorded run", () => {
    expect(route).toContain("Work.runOwning(");
    expect(route).toContain("not a worktree this made");
  });

  test("and the repository used is the one on the row, not the one asked for", () => {
    /*
     * Checking the worktree and then passing the caller's `repo` through would
     * prove nothing: git is run WITH THAT CWD, so the pair has to be the pair
     * this server wrote.
     */
    expect(route).toContain("Loop.discardRun(owner.worktree, owner.repo");
    expect(route).not.toContain("String(wb.repo");
  });

  test("a run still in flight cannot have its ground removed", () => {
    // Deleting the worktree of a live run pulls the floor out from under an
    // agent mid-edit, and the row goes on claiming to work in a directory
    // that is gone.
    expect(route).toContain('owner.state === "running"');
  });
});

describe("the ownership test itself", () => {
  test("an exact match, so `..` cannot walk out of a prefix", async () => {
    const W = await import("../src/understudy-work.ts");
    // Nothing recorded means nothing owned — including paths that merely look
    // like they sit under a real one.
    expect(W.runOwning("/tmp/definitely-not-a-run")).toBe(null);
    expect(W.runOwning("")).toBe(null);
    expect(W.runOwning("   ")).toBe(null);
  });

  test("the check is a string comparison, not a filesystem question", async () => {
    /*
     * A realpath or a prefix check can be answered by a symlink somebody else
     * controls. The recorded value is what this server wrote when it cut the
     * worktree, and comparing against it needs no disk at all.
     */
    const work = await Bun.file(new URL("../src/understudy-work.ts", import.meta.url)).text();
    const fn = work.slice(work.indexOf("export function runOwning("));
    expect(fn).toContain("r.worktree === path");
    expect(fn).not.toContain("realpath");
    expect(fn).not.toContain("startsWith");
  });

  test("a directory that exists but was never a run is still refused", async () => {
    const W = await import("../src/understudy-work.ts");
    const real = mkdtempSync(join(tmpdir(), "agx-notmine-"));
    writeFileSync(join(real, "something.txt"), "somebody's work\n");
    expect(existsSync(real)).toBe(true);
    expect(W.runOwning(real), "existing is not owning").toBe(null);
  });
});
