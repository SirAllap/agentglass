/*
 * The git block of the finder's info rail: one file's status, size of change,
 * branch and last commit — from a real repository, because a mocked git would
 * agree with whatever the parser assumed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileGitFacts, statusOf } from "../src/fileGit.ts";
import { story } from "./story.ts";

// The open project and, beside it, a checkout outside it; the finder may read both.
const parent = mkdtempSync(join(tmpdir(), "agx-filegit-"));
const dir = join(parent, "orbit");
const elsewhere = join(parent, "elsewhere");
mkdirSync(dir); mkdirSync(elsewhere);
const wasRoots = process.env.AGENTGLASS_DISK_ROOTS;
const wasRoot = process.env.AGENTGLASS_ROOT;
process.env.AGENTGLASS_DISK_ROOTS = parent;
process.env.AGENTGLASS_ROOT = dir;
afterAll(() => {
  rmSync(parent, { recursive: true, force: true });
  if (wasRoots === undefined) delete process.env.AGENTGLASS_DISK_ROOTS; else process.env.AGENTGLASS_DISK_ROOTS = wasRoots;
  if (wasRoot === undefined) delete process.env.AGENTGLASS_ROOT; else process.env.AGENTGLASS_ROOT = wasRoot;
});
const gitIn = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};
const sh = (...a: string[]) => gitIn(dir, ...a);

sh("init", "-q", "-b", "main");
writeFileSync(join(dir, "retry.py"), "a = 1\nb = 2\n");
writeFileSync(join(dir, "-dash.md"), "x\n");
sh("add", "."); sh("commit", "-q", "-m", "tune backoff for staging queue");

const step = story();

describe("fileGitFacts", () => {
  step("a committed, untouched file is clean and carries its last commit", async () => {
    const r = await fileGitFacts(join(dir, "retry.py"), true);
    expect(r).toMatchObject({ ok: true, repo: true, status: "clean", branch: "main" });
    // the path a person would say: the checkout's folder, then the path in it
    expect(r.path).toBe(`${dir.slice(dir.lastIndexOf("/") + 1)}/retry.py`);
    expect(r.commit?.subject).toBe("tune backoff for staging queue");
    expect(r.commit?.hash).toMatch(/^[0-9a-f]{7,}$/);
  });
  step("an edit is modified with its +/- against HEAD", async () => {
    writeFileSync(join(dir, "retry.py"), "a = 1\nb = 3\nc = 4\n");
    const r = await fileGitFacts(join(dir, "retry.py"), true);
    expect(r.status).toBe("modified");
    expect([r.added, r.removed]).toEqual([2, 1]);
  });
  step("a new file is untracked and has no commit", async () => {
    writeFileSync(join(dir, "new.txt"), "n\n");
    const r = await fileGitFacts(join(dir, "new.txt"), true);
    expect(r.status).toBe("untracked");
    expect(r.commit).toBeUndefined();
  });
  step("a name starting with a dash is a path, not an option", async () => {
    expect(await fileGitFacts(join(dir, "-dash.md"), true)).toMatchObject({ ok: true, repo: true, status: "clean" });
  });
  step("outside the readable places it refuses, and says nothing about git", async () => {
    const r = await fileGitFacts("/etc/passwd", false);
    expect(r.ok).toBe(false);
    expect(r.repo).toBe(false);
  });
  step("a checkout outside the open project gets no git facts at all", async () => {
    gitIn(elsewhere, "init", "-q", "-b", "main");
    writeFileSync(join(elsewhere, "notes.md"), "n\n");
    gitIn(elsewhere, "add", "."); gitIn(elsewhere, "commit", "-q", "-m", "c");
    expect(await fileGitFacts(join(elsewhere, "notes.md"), true)).toEqual({ ok: true, repo: false });
  });
  step("a clean filter named by a repository's own config never runs, even inside the project", async () => {
    // An extracted archive: a .git/config that defines a filter and attributes
    // that apply it, with stat data stale so status has to re-hash the file.
    const demo = join(dir, "vendor", "demo");
    mkdirSync(demo, { recursive: true });
    gitIn(demo, "init", "-q", "-b", "main");
    writeFileSync(join(demo, "README.md"), "hello\n");
    gitIn(demo, "add", "."); gitIn(demo, "commit", "-q", "-m", "c");
    const marker = join(parent, "filter-ran");
    gitIn(demo, "config", "filter.x.clean", `sh -c 'echo ran >> ${marker}; cat'`);
    gitIn(demo, "config", "filter.x.process", `sh -c 'echo ran >> ${marker}'`);
    writeFileSync(join(demo, ".git", "info", "attributes"), "* filter=x\n");
    utimesSync(join(demo, "README.md"), new Date(2001, 0, 1), new Date(2001, 0, 1));
    const r = await fileGitFacts(join(demo, "README.md"), true);
    expect(r).toMatchObject({ ok: true, repo: true, status: "clean" });
    expect(existsSync(marker)).toBe(false);
  });
  step("a name that looks like pathspec magic is that file and nothing else", async () => {
    // With magic, `:(exclude)…` would ask about every OTHER file, and the
    // first of them (the modified retry.py) would answer for this one.
    writeFileSync(join(dir, "retry.py"), "a = 1\nb = 5\n");
    writeFileSync(join(dir, ":(exclude)zz.txt"), "z\n");
    expect((await fileGitFacts(join(dir, ":(exclude)zz.txt"), true)).status).toBe("untracked");
  });
  step("the server's thread keeps turning while git answers", async () => {
    // A timer queued before the call fires before it returns only if the git
    // calls are awaited; synchronous spawns would hold the loop throughout.
    let turned = false;
    setTimeout(() => { turned = true; }, 0);
    await fileGitFacts(join(dir, "retry.py"), true);
    expect(turned).toBe(true);
  });
  step("statusOf maps porcelain codes", () => {
    expect(["??", " M", "A ", "D ", "R ", "UU", "!!", "  "].map(statusOf))
      .toEqual(["untracked", "modified", "added", "deleted", "renamed", "conflict", "ignored", "clean"]);
  });
});
