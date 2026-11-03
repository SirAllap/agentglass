/*
 * Amend the last commit, and soft/mixed reset: the refusals and the effects,
 * against real git. Amend rewrites the tip, so it must refuse when the tip is
 * already on a remote, when HEAD is detached, and mid-operation; a soft reset
 * keeps what the dropped commit changed staged, a mixed one keeps it unstaged,
 * and neither touches the files.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identify } from "./gitIdentity.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-amend-reset-")));
process.env.AGENTGLASS_ROOT = dir;
const { amendCommit, amendInfo, resetTo, stage } = await import("../src/gitwork.ts");
afterAll(() => Bun.spawnSync(["rm", "-rf", dir]));

let repo = "";
const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
const out = (...args: string[]) => git(...args).stdout.toString().trim();

/** feature branch with three commits, none pushed. */
function build(): void {
  repo = join(dir, `orbit-${Math.random().toString(36).slice(2)}`);
  Bun.spawnSync(["mkdir", "-p", repo]);
  git("init", "-q", "-b", "feature", ".");
  identify(repo);
  for (const [f, c, m] of [["a.txt", "seed\n", "seed"], ["a.txt", "one\n", "feat one"], ["b.txt", "two\n", "feat two\n\nwhy two"]] as const) {
    writeFileSync(join(repo, f), c);
    git("add", "-A"); git("commit", "-qm", m);
  }
}

/** Push the branch to a bare local origin, so the tip is on a remote. */
function pushToOrigin(): void {
  const bare = join(dir, `origin-${Math.random().toString(36).slice(2)}.git`);
  Bun.spawnSync(["git", "init", "-q", "--bare", bare]);
  git("remote", "add", "origin", bare);
  git("push", "-q", "-u", "origin", "feature");
}

describe("amend", () => {
  beforeEach(build);

  it("amendInfo hands back the tip's title and body to prefill", () => {
    const i = amendInfo(repo);
    expect(i).toMatchObject({ ok: true, title: "feat two", body: "why two" });
    expect(i.refusal).toBeUndefined();
  });

  it("rewrites the tip with the staged file and the new message", () => {
    const before = out("rev-parse", "HEAD");
    writeFileSync(join(repo, "c.txt", ), "three\n");
    expect(stage(repo, ["c.txt"]).ok).toBe(true);
    expect(amendCommit(repo, "feat two and three", "").ok).toBe(true);
    expect(out("rev-parse", "HEAD")).not.toBe(before);
    expect(out("log", "-1", "--format=%s")).toBe("feat two and three");
    expect(out("show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["b.txt", "c.txt"]);
    expect(out("rev-list", "--count", "HEAD")).toBe("3");
  });

  it("refuses when the tip is already on a remote, and moves nothing", () => {
    pushToOrigin();
    writeFileSync(join(repo, "c.txt"), "three\n");
    stage(repo, ["c.txt"]);
    const before = out("rev-parse", "HEAD");
    const r = amendCommit(repo, "reworded", "");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("already on a remote");
    expect(out("rev-parse", "HEAD")).toBe(before);
    expect(amendInfo(repo).refusal).toContain("already on a remote");
  });

  it("allows it again once the branch has a new local commit on top of the pushed one", () => {
    pushToOrigin();
    writeFileSync(join(repo, "c.txt"), "three\n");
    git("add", "-A"); git("commit", "-qm", "feat three");
    expect(amendInfo(repo).refusal).toBeUndefined();
  });

  it("refuses on a detached HEAD", () => {
    git("checkout", "-q", "--detach");
    writeFileSync(join(repo, "c.txt"), "three\n");
    stage(repo, ["c.txt"]);
    const r = amendCommit(repo, "reworded", "");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not on a branch");
  });

  it("refuses mid-merge, naming the state", () => {
    git("checkout", "-qb", "other", "HEAD~1");
    writeFileSync(join(repo, "b.txt"), "other\n");
    git("add", "-A"); git("commit", "-qm", "other b");
    git("merge", "feature");
    expect(out("status", "--porcelain")).toContain("b.txt");
    const r = amendCommit(repo, "reworded", "");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("merging");
  });
});

describe("reset soft and mixed", () => {
  beforeEach(build);
  const prev = () => out("rev-parse", "HEAD~1");

  it("soft moves the branch, keeps the dropped change staged and the files intact", () => {
    expect(resetTo(repo, prev(), "soft").ok).toBe(true);
    expect(out("log", "-1", "--format=%s")).toBe("feat one");
    expect(out("diff", "--cached", "--name-only")).toBe("b.txt");
    expect(out("diff", "--name-only")).toBe("");
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("two\n");
  });

  it("mixed moves the branch, keeps the dropped change unstaged and the files intact", () => {
    expect(resetTo(repo, prev(), "mixed").ok).toBe(true);
    expect(out("log", "-1", "--format=%s")).toBe("feat one");
    expect(out("diff", "--cached", "--name-only")).toBe("");
    expect(out("status", "--porcelain")).toBe("?? b.txt");
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("two\n");
  });
});
