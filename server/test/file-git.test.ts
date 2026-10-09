/*
 * The git block of the finder's info rail: one file's status, size of change,
 * branch and last commit — from a real repository, because a mocked git would
 * agree with whatever the parser assumed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileGitFacts, statusOf } from "../src/fileGit.ts";
import { story } from "./story.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-filegit-"));
const wasRoots = process.env.AGENTGLASS_DISK_ROOTS;
process.env.AGENTGLASS_DISK_ROOTS = dir;
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (wasRoots === undefined) delete process.env.AGENTGLASS_DISK_ROOTS; else process.env.AGENTGLASS_DISK_ROOTS = wasRoots;
});
const sh = (...a: string[]) => {
  const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};

sh("init", "-q", "-b", "main");
writeFileSync(join(dir, "retry.py"), "a = 1\nb = 2\n");
writeFileSync(join(dir, "-dash.md"), "x\n");
sh("add", "."); sh("commit", "-q", "-m", "tune backoff for staging queue");

const step = story();

describe("fileGitFacts", () => {
  step("a committed, untouched file is clean and carries its last commit", () => {
    const r = fileGitFacts(join(dir, "retry.py"), true);
    expect(r).toMatchObject({ ok: true, repo: true, status: "clean", branch: "main" });
    // the path a person would say: the checkout's folder, then the path in it
    expect(r.path).toBe(`${dir.slice(dir.lastIndexOf("/") + 1)}/retry.py`);
    expect(r.commit?.subject).toBe("tune backoff for staging queue");
    expect(r.commit?.hash).toMatch(/^[0-9a-f]{7,}$/);
  });
  step("an edit is modified with its +/- against HEAD", () => {
    writeFileSync(join(dir, "retry.py"), "a = 1\nb = 3\nc = 4\n");
    const r = fileGitFacts(join(dir, "retry.py"), true);
    expect(r.status).toBe("modified");
    expect([r.added, r.removed]).toEqual([2, 1]);
  });
  step("a new file is untracked and has no commit", () => {
    writeFileSync(join(dir, "new.txt"), "n\n");
    const r = fileGitFacts(join(dir, "new.txt"), true);
    expect(r.status).toBe("untracked");
    expect(r.commit).toBeUndefined();
  });
  step("a name starting with a dash is a path, not an option", () => {
    expect(fileGitFacts(join(dir, "-dash.md"), true)).toMatchObject({ ok: true, repo: true, status: "clean" });
  });
  step("outside the readable places it refuses, and says nothing about git", () => {
    const r = fileGitFacts("/etc/passwd", false);
    expect(r.ok).toBe(false);
    expect(r.repo).toBe(false);
  });
  step("statusOf maps porcelain codes", () => {
    expect(["??", " M", "A ", "D ", "R ", "UU", "!!", "  "].map(statusOf))
      .toEqual(["untracked", "modified", "added", "deleted", "renamed", "conflict", "ignored", "clean"]);
  });
});
