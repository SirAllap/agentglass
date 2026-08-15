/*
 * The interactive-rebase engine: enumerate `base..HEAD` as steps, then run the
 * edited plan through `sequence.editor` as one sequencer run.
 *
 * The things this has to get right are the things a rebase -i gets wrong when
 * driven from a web request:
 *
 *  1. The plan is validated BEFORE anything moves — every commit in `base..HEAD`
 *     appears exactly once, and nothing else does. A stale list cannot silently
 *     drop or invent commits.
 *  2. Reword goes through `exec git commit --amend`, not git's own `reword`,
 *     which would open an editor nobody can drive.
 *  3. A conflict pauses the run as `rebasing` — the shared continue/abort
 *     machinery finishes or abandons it, exactly as it does for cherry-picks.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identify } from "./gitIdentity.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-rebase-")));
process.env.AGENTGLASS_ROOT = dir;
const { rebaseSteps, runRebase, conflicts, resolveWith, mergeContinue, mergeAbort } =
  await import("../src/gitwork.ts");

let repo = "";
const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd: repo });

const subject = (ref = "HEAD") => git("log", "-1", "--format=%s", ref).stdout.toString().trim();
const hash = (ref = "HEAD") => git("rev-parse", ref).stdout.toString().trim();
const at = (ref: string, f: string) => git("show", `${ref}:${f}`).stdout.toString();

/** main: seed, then three commits where "feat one" and "feat two" both touch
 *  a.txt — so reordering those two is a genuine conflict, while every other
 *  edit replays cleanly. base = the seed commit (HEAD~3). */
function build(): void {
  repo = join(dir, `r-${Math.random().toString(36).slice(2)}`);
  Bun.spawnSync(["mkdir", "-p", repo]);
  git("init", "-q", "-b", "main", ".");
  identify(repo);
  writeFileSync(join(repo, "a.txt"), "seed\n");
  git("add", "-A"); git("commit", "-qm", "seed");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "-A"); git("commit", "-qm", "feat one");
  writeFileSync(join(repo, "a.txt"), "two\n");
  writeFileSync(join(repo, "b.txt"), "two\n");
  git("add", "-A"); git("commit", "-qm", "feat two");
  writeFileSync(join(repo, "c.txt"), "three\n");
  git("add", "-A"); git("commit", "-qm", "feat three");
}
const base = () => hash("HEAD~3");
const stepsOf = () => rebaseSteps(repo, base()).steps!;

describe("rebaseSteps", () => {
  beforeEach(build);

  it("enumerates base..HEAD oldest first", () => {
    const r = rebaseSteps(repo, base());
    expect(r.ok).toBe(true);
    expect(r.steps!.map((s) => s.subject)).toEqual(["feat one", "feat two", "feat three"]);
    expect(r.steps!.every((s) => s.action === "pick")).toBe(true);
  });

  it("refuses a base that is not an ancestor", () => {
    git("checkout", "-q", "-b", "side", "HEAD~1");
    writeFileSync(join(repo, "d.txt"), "side\n");
    git("add", "-A"); git("commit", "-qm", "side work");
    const side = hash("HEAD");
    git("checkout", "-q", "main");
    const r = rebaseSteps(repo, side);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not an ancestor");
  });
});

describe("runRebase", () => {
  beforeEach(build);

  it("reorders — the plan's order is the result's order", () => {
    const s = stepsOf();
    const r = runRebase(repo, base(), [s[2]!, s[0]!, s[1]!]);
    expect(r.ok).toBe(true);
    // Newest first in the log: two, one, three.
    expect(subject("HEAD")).toBe("feat two");
    expect(subject("HEAD~1")).toBe("feat one");
    expect(subject("HEAD~2")).toBe("feat three");
    // The tree is unchanged by a pure reorder.
    expect(at("HEAD", "b.txt")).toBe("two\n");
    expect(git("status", "--porcelain").stdout.toString().trim()).toBe("");
  });

  it("squash folds two steps into one with their combined tree", () => {
    const b = base();
    const s = stepsOf();
    const r = runRebase(repo, b, [s[0]!, { ...s[1]!, action: "squash" }, s[2]!]);
    expect(r.ok).toBe(true);
    expect(subject("HEAD")).toBe("feat three");
    // The squash keeps the first commit of the group as its message.
    expect(subject("HEAD~1")).toBe("feat one");
    expect(git("rev-list", "--count", b + "..HEAD").stdout.toString().trim()).toBe("2");
    expect(at("HEAD~1", "a.txt")).toBe("two\n");
    expect(at("HEAD~1", "b.txt")).toBe("two\n");
  });

  it("fixup keeps the folded commit's subject", () => {
    const s = stepsOf();
    const r = runRebase(repo, base(), [s[0]!, { ...s[1]!, action: "fixup" }, s[2]!]);
    expect(r.ok).toBe(true);
    expect(subject("HEAD~1")).toBe("feat one"); // the fixup's own message is discarded
    expect(at("HEAD~1", "a.txt")).toBe("two\n");
  });

  it("drop removes the commit and its change", () => {
    const b = base();
    const s = stepsOf();
    const r = runRebase(repo, b, [s[0]!, { ...s[1]!, action: "drop" }, s[2]!]);
    expect(r.ok).toBe(true);
    expect(subject("HEAD")).toBe("feat three");
    expect(git("rev-list", "--count", b + "..HEAD").stdout.toString().trim()).toBe("2");
    expect(git("show", "HEAD~1:b.txt").stdout.toString()).toBe("");
    expect(at("HEAD~1", "a.txt")).toBe("one\n");
  });

  it("reword replaces the message without touching the change", () => {
    const s = stepsOf();
    const r = runRebase(repo, base(), [{ ...s[0]!, action: "reword", newMessage: "renamed one" }, s[1]!, s[2]!]);
    expect(r.ok).toBe(true);
    expect(subject("HEAD~2")).toBe("renamed one");
    expect(at("HEAD~2", "a.txt")).toBe("one\n");
  });

  it("refuses a plan that misses a commit", () => {
    const s = stepsOf();
    const r = runRebase(repo, base(), [s[0]!, s[1]!]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("missing");
  });

  it("refuses a plan that repeats a commit", () => {
    const s = stepsOf();
    const r = runRebase(repo, base(), [s[0]!, s[0]!, s[1]!, s[2]!]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("more than once");
  });

  it("pauses as `rebasing` on a conflict, and continue finishes it", () => {
    // Reordering "feat two" ahead of "feat one" collides on a.txt: two's diff
    // expects one's content and finds the seed's. Continuing replays the next
    // step, which collides again — the rebase stops once per conflicting
    // commit, exactly like any rebase -i.
    const s = stepsOf();
    const r = runRebase(repo, base(), [s[2]!, s[1]!, s[0]!]);
    expect(r.ok).toBe(false);
    expect(conflicts(repo).state).toBe("rebasing");
    expect(resolveWith(repo, "a.txt", "theirs").ok).toBe(true);
    let fin = mergeContinue(repo);
    expect(fin.ok).toBe(true);
    // Stopped again on the next conflicting commit — the run advanced, it did
    // not fail. One more resolution finishes it.
    expect(conflicts(repo).state).toBe("rebasing");
    expect(resolveWith(repo, "a.txt", "theirs").ok).toBe(true);
    fin = mergeContinue(repo);
    expect(fin.ok).toBe(true);
    expect(conflicts(repo).state).toBe("clean");
    expect(subject()).toBe("feat one");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("two\n");
  });

  it("abort restores the branch exactly", () => {
    const s = stepsOf();
    const before = subject();
    runRebase(repo, base(), [s[2]!, s[1]!, s[0]!]);
    expect(conflicts(repo).state).toBe("rebasing");
    expect(mergeAbort(repo).ok).toBe(true);
    expect(subject()).toBe(before);
    expect(git("status", "--porcelain").stdout.toString().trim()).toBe("");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("two\n");
  });
});
