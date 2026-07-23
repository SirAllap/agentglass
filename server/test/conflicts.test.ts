import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A real conflict, produced the way one actually happens: two branches editing
 * the same line, merged. Nothing here is worth testing against a fake — the
 * whole feature is about what git does when it stops.
 */
let repo: string, gw: typeof import("../src/gitwork.ts");
const run = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "agx-conflict-"));
  process.env.AGENTGLASS_ROOT = repo;
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.email", "t@example.com");
  run(repo, "config", "user.name", "t");
  const commit = (body: string, msg: string) => {
    writeFileSync(join(repo, "shared.txt"), body);
    run(repo, "add", "-A");
    run(repo, "commit", "-qm", msg);
  };
  commit("original\n", "base");
  run(repo, "checkout", "-q", "-b", "feature");
  commit("from the feature branch\n", "feature edit");
  run(repo, "checkout", "-q", "main");
  commit("from main\n", "main edit");
  gw = await import("../src/gitwork.ts");
});

afterAll(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* fine */ } });

describe("merge conflicts", () => {
  it("reports nothing to resolve on a clean tree", () => {
    const c = gw.conflicts(repo);
    expect(c.state).toBe("clean");
    expect(c.files).toEqual([]);
  });

  it("names the conflicted files once a merge stops", () => {
    const r = run(repo, "merge", "--no-edit", "feature");
    expect(r.status).not.toBe(0); // it really did conflict
    const c = gw.conflicts(repo);
    expect(c.state).toBe("merging");
    expect(c.files).toEqual([join(repo, "shared.txt")]);
  });

  it("refuses to continue while anything is still conflicted", () => {
    const r = gw.mergeContinue(repo);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/still conflicted/i);
  });

  it("takes one side wholesale and stages it", () => {
    const r = gw.resolveWith(repo, "shared.txt", "theirs");
    expect(r.ok).toBe(true);
    expect(readFileSync(join(repo, "shared.txt"), "utf8")).toBe("from the feature branch\n");
    // Resolved *and* staged: an unstaged resolution still blocks the commit.
    expect(gw.conflicts(repo).files).toEqual([]);
  });

  it("completes the merge once everything is resolved", () => {
    const r = gw.mergeContinue(repo);
    expect(r.ok).toBe(true);
    expect(gw.conflicts(repo).state).toBe("clean");
  });

  it("aborts a merge and leaves the tree as it was", () => {
    const before = readFileSync(join(repo, "shared.txt"), "utf8");
    run(repo, "checkout", "-q", "-b", "second", "HEAD~1");
    writeFileSync(join(repo, "shared.txt"), "a third opinion\n");
    run(repo, "commit", "-qam", "third");
    run(repo, "checkout", "-q", "main");
    expect(run(repo, "merge", "--no-edit", "second").status).not.toBe(0);
    expect(gw.conflicts(repo).state).toBe("merging");

    const r = gw.mergeAbort(repo);
    expect(r.ok).toBe(true);
    expect(gw.conflicts(repo).state).toBe("clean");
    expect(readFileSync(join(repo, "shared.txt"), "utf8")).toBe(before);
  });
});
