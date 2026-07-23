// currentBranch used to read "HEAD" from --abbrev-ref as detached, but a fresh
// `git init` reports "HEAD" too — an unborn branch that has a name and no commit.
// The panel then labelled a brand-new repo "(detached)".
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { currentBranch } from "../src/git.ts";

let dir = "";
const git = (...a: string[]) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("currentBranch", () => {
  test("an unborn branch (fresh git init) is named, not detached", async () => {
    dir = mkdtempSync(join(tmpdir(), "agx-branch-"));
    git("init", "-q", "-b", "main");
    expect(await currentBranch(dir)).toBe("main");
  });

  test("a real detached HEAD still reads as detached", async () => {
    dir = mkdtempSync(join(tmpdir(), "agx-branch2-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    writeFileSync(join(dir, "a.txt"), "x\n");
    git("add", "-A"); git("commit", "-qm", "seed");
    git("checkout", "-q", git("rev-parse", "HEAD").stdout.trim()); // detach
    expect(await currentBranch(dir)).toBe("(detached)");
  });

  test("an ordinary branch reads its name", async () => {
    dir = mkdtempSync(join(tmpdir(), "agx-branch3-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    writeFileSync(join(dir, "a.txt"), "x\n");
    git("add", "-A"); git("commit", "-qm", "seed");
    git("checkout", "-q", "-b", "feature");
    expect(await currentBranch(dir)).toBe("feature");
  });
});
