// fixWorktreeOwnership hands a path to `pkexec chown -R`, so the gate that
// decides "this is really a worktree of this repo" is the only thing standing
// between a local user and chowning an arbitrary root-owned directory to
// themselves. A prunable entry — a broken registration whose gitdir points
// nowhere valid — can be fabricated by anyone with write access to the repo to
// name any path, so it must not count as a real worktree here.
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fixWorktreeOwnership } from "../src/gitwork.ts";

let dir = "";
const git = (...a: string[]) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-wtown-"));
  process.env.AGENTGLASS_ROOT = dir;
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(join(dir, "a.txt"), "seed\n");
  git("add", "-A"); git("commit", "-qm", "seed");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("fixWorktreeOwnership gate", () => {
  it("refuses a fabricated prunable worktree, so pkexec can't be aimed at an arbitrary path", () => {
    // Stands in for a root-owned directory the attacker wants chowned to them.
    const target = mkdtempSync(join(tmpdir(), "agx-target-"));
    // The attack: write a worktree registration whose gitdir names `target`.
    // git cannot verify the back-reference (target has no .git pointing here),
    // so it lists the entry as prunable.
    const wt = join(dir, ".git", "worktrees", "evil");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "gitdir"), join(target, ".git") + "\n");
    writeFileSync(join(wt, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(wt, "commondir"), "../..\n");

    // Sanity: git really does surface `target` as a prunable worktree.
    const listed = git("worktree", "list", "--porcelain").stdout;
    expect(listed).toContain(target);
    expect(listed).toContain("prunable");

    const r = fixWorktreeOwnership(dir, target);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not a worktree");

    rmSync(target, { recursive: true, force: true });
  });

  it("still accepts a real, live worktree", () => {
    const wtPath = join(mkdtempSync(join(tmpdir(), "agx-wt-")), "feature");
    expect(git("worktree", "add", "-q", "-b", "feature", wtPath).status).toBe(0);
    // Its files are ours, so the gate passes and there is nothing to chown.
    const r = fixWorktreeOwnership(dir, wtPath);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("already yours");
    rmSync(wtPath, { recursive: true, force: true });
  });
});
