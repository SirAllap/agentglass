import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { identify } from "./gitIdentity.ts";

// All gitwork tests share one skeleton: a scratch repo outside the real tree,
// a GIT_CONFIG_GLOBAL pointing at a temp config so nothing on this machine can
// leak in, and guard() resolved against the scratch root via AGENTGLASS_ROOT.
async function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "agx-blame-"));
  process.env.AGENTGLASS_ROOT = dir;
  const config = join(dir, ".gitconfig");
  writeFileSync(config, `[user]\n\temail = t@t\n\tname = T\n[init]\n\tdefaultBranch = main\n`);
  process.env.GIT_CONFIG_GLOBAL = config;
  const repo = join(dir, "repo");
  Bun.spawnSync(["mkdir", "-p", repo]);
  const git = (args: string[], cwd?: string) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: cwd ?? repo, env: process.env });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  // Use a bare repo so pushes work hermetically without touching real remotes.
  const remote = join(dir, "remote.git");
  git(["init", "-q", "--bare", "--initial-branch=main", remote]);
  writeFileSync(join(dir, "setup.sh"), "touch");
  await Bun.sleep(0);
  return { dir, repo, remote, git };
}

describe("blame", () => {
  let repo: string;
  let git: (args: string[], cwd?: string) => { code: number; out: string; err: string };
  beforeEach(async () => {
    const r = await makeRepo();
    repo = r.repo;
    git = r.git;
    git(["init", "-q"]);
    git(["remote", "add", "origin", r.remote]);
    identify(repo);
  });
  afterEach(() => {
    rmSync(process.env.AGENTGLASS_ROOT!, { recursive: true, force: true });
    delete process.env.AGENTGLASS_ROOT;
    delete process.env.GIT_CONFIG_GLOBAL;
  });

  test("blames across two commits", async () => {
    writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
    git(["add", "a.txt"]);
    git(["commit", "-q", "-m", "seed"]);
    writeFileSync(join(repo, "a.txt"), "one\ntwo\nchanged\nfour\n");
    git(["add", "a.txt"]);
    git(["commit", "-q", "-m", "tweak"]);
    const m = await import("../src/gitwork.ts");
    const res = m.blameFile(repo, "a.txt", "");
    expect(res.ok).toBe(true);
    expect(res.lines?.length).toBe(4);
    // Lines 1-2 from the first commit, 3-4 from the second, in final-line order.
    expect(res.lines![0]).toMatchObject({ line: 1, content: "one", subject: "seed" });
    expect(res.lines![1]).toMatchObject({ line: 2, content: "two", subject: "seed" });
    expect(res.lines![2]).toMatchObject({ line: 3, content: "changed", subject: "tweak" });
    expect(res.lines![3]).toMatchObject({ line: 4, content: "four", subject: "tweak" });
    expect(res.lines![0].sha).not.toBe("");
    expect(res.lines![0].sha.length).toBe(40);
    expect(res.lines![0].author).toBe("T");
  });

  test("uncommitted edits blame as 'local'", async () => {
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(["add", "a.txt"]);
    git(["commit", "-q", "-m", "seed"]);
    writeFileSync(join(repo, "a.txt"), "one\nbrand new\n");
    const m = await import("../src/gitwork.ts");
    const res = m.blameFile(repo, "a.txt", "");
    expect(res.ok).toBe(true);
    expect(res.lines!.length).toBe(2);
    expect(res.lines![0].sha).not.toBe("");
    expect(res.lines![1]).toMatchObject({ line: 2, sha: "", content: "brand new", subject: "" });
  });

  test("blames a past revision", async () => {
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(["add", "a.txt"]);
    git(["commit", "-q", "-m", "seed"]);
    writeFileSync(join(repo, "a.txt"), "one\nsecond\n");
    git(["add", "a.txt"]);
    git(["commit", "-q", "-m", "tweak"]);
    const m = await import("../src/gitwork.ts");
    const res = m.blameFile(repo, "a.txt", "HEAD~1");
    expect(res.ok).toBe(true);
    expect(res.lines!.length).toBe(1);
    expect(res.lines![0]).toMatchObject({ line: 1, content: "one", subject: "seed" });
  });

  test("missing file errors", async () => {
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(["add", "a.txt"]);
    git(["commit", "-q", "-m", "seed"]);
    const m = await import("../src/gitwork.ts");
    const res = m.blameFile(repo, "nope.txt", "");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not in HEAD");
  });

  test("file history follows renames", async () => {
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(["add", "a.txt"]);
    git(["commit", "-q", "-m", "seed"]);
    git(["mv", "a.txt", "b.txt"]);
    git(["commit", "-q", "-m", "renamed"]);
    const m = await import("../src/gitwork.ts");
    const res = m.fileHistory(repo, "b.txt");
    expect(res.ok).toBe(true);
    expect(res.entries?.length).toBe(2);
    expect(res.entries![0]).toMatchObject({ subject: "renamed", author: "T" });
    expect(res.entries![1]).toMatchObject({ subject: "seed" });
    expect(res.entries![0].fullHash.length).toBe(40);
  });

  test("history of a file that never existed is empty", async () => {
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(["add", "a.txt"]);
    git(["commit", "-q", "-m", "seed"]);
    const m = await import("../src/gitwork.ts");
    const res = m.fileHistory(repo, "nope.txt");
    expect(res.ok).toBe(true);
    expect(res.entries?.length ?? 0).toBe(0);
  });

  test("endpoints resolve and validate", async () => {
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(["add", "a.txt"]);
    git(["commit", "-q", "-m", "seed"]);
    const m = await import("../src/gitwork.ts");
    expect(m.blameFile("/nope", "a.txt", "")).toEqual({ ok: false, error: "not a git repository root" });
    expect(m.fileHistory(repo, "../escape")).toEqual({ ok: false, error: "invalid path" });
    expect(readFileSync(join(process.env.AGENTGLASS_ROOT!, "setup.sh"), "utf8")).toBe("touch");
  });
});
