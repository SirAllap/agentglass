/*
 * Revert, amend, squash — the three single-commit history editors.
 *
 * These share one shape with cherry-pick: they refuse to start mid-operation,
 * and the revert's conflict path rides the existing revert state machinery
 * (`treeState()` reports `reverting`, `mergeAbort`/`mergeContinue` branch on
 * it). The fixture keeps them testable against real `git` semantics: revert
 * produces a new commit undoing exactly one commit; amend replaces the message
 * (and only ever the tip); squash folds a contiguous run with the tree
 * preserved, and refuses anything that is not contiguous.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identify } from "./gitIdentity.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-history-")));
process.env.AGENTGLASS_ROOT = dir;
const { revertCommit, amendCommit, squashCommits, stage, conflicts, resolveWith, mergeContinue, mergeAbort } =
  await import("../src/gitwork.ts");

let repo = "";
const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd: repo });

const subject = (ref = "HEAD") => git("log", "-1", "--format=%s", ref).stdout.toString().trim();
const read = (f: string) => readFileSync(join(repo, f), "utf8");
const hash = (ref = "HEAD") => git("rev-parse", ref).stdout.toString().trim();
/** The file's content at a ref, as a string. */
const at = (ref: string, f: string) => git("show", `${ref}:${f}`).stdout.toString();
/** Does the file exist at a ref? */
const existsAt = (ref: string, f: string) => git("ls-tree", ref, f).stdout.toString().trim() !== "";

/** main: seed, "one" on a.txt, "two" on b.txt, "three" on c.txt, "four" on
 *  a.txt — four clean commits, with the LAST one re-touching the file the
 *  second one changed, so reverting the second one is a genuine conflict. */
function build(): void {
  repo = join(dir, `r-${Math.random().toString(36).slice(2)}`);
  Bun.spawnSync(["mkdir", "-p", repo]);
  git("init", "-q", "-b", "main", ".");
  identify(repo);
  writeFileSync(join(repo, "a.txt"), "seed\n");
  git("add", "-A"); git("commit", "-qm", "seed");
  for (const [f, content, msg] of [["a.txt", "one\n", "feat one"], ["b.txt", "two\n", "feat two"], ["c.txt", "three\n", "feat three"], ["a.txt", "four\n", "feat four"]] as const) {
    writeFileSync(join(repo, f), content);
    git("add", "-A"); git("commit", "-qm", msg);
  }
}

describe("revert", () => {
  beforeEach(build);

  it("creates a new commit undoing exactly the picked one", () => {
    const r = revertCommit(repo, hash("HEAD")); // feat four: a.txt "four" -> "one"
    expect(r.ok).toBe(true);
    expect(subject()).toBe(`Revert "feat four"`);
    expect(read("a.txt")).toBe("one\n");
    expect(read("b.txt")).toBe("two\n");
    expect(read("c.txt")).toBe("three\n");
  });

  it("pauses as `reverting` on a conflict, and continue commits the resolution", () => {
    // feat one changed a.txt to "one"; feat four changed it to "four". The
    // revert of feat one expects "one" and finds "four" — a real conflict.
    const r = revertCommit(repo, hash("HEAD~3"));
    expect(r.ok).toBe(false);
    expect(conflicts(repo).state).toBe("reverting");
    expect(conflicts(repo).files.some((f) => f.endsWith("a.txt"))).toBe(true);
    expect(resolveWith(repo, "a.txt", "theirs").ok).toBe(true);
    const fin = mergeContinue(repo);
    expect(fin.ok).toBe(true);
    expect(conflicts(repo).state).toBe("clean");
    expect(subject()).toBe(`Revert "feat one"`);
    // "theirs" in a revert is the undone state — a.txt back to "seed", the
    // file's content before feat one changed it.
    expect(read("a.txt")).toBe("seed\n");
  });

  it("abort puts the branch back exactly", () => {
    const before = subject();
    const r = revertCommit(repo, hash("HEAD~3"));
    expect(r.ok).toBe(false);
    expect(mergeAbort(repo).ok).toBe(true);
    expect(subject()).toBe(before);
    expect(git("status", "--porcelain").stdout.toString().trim()).toBe("");
  });
});

describe("amend", () => {
  beforeEach(build);

  it("replaces the tip's message and folds staged changes", () => {
    writeFileSync(join(repo, "a.txt"), "four edited\n");
    expect(stage(repo, ["a.txt"]).ok).toBe(true);
    const r = amendCommit(repo, "feat four edited", "");
    expect(r.ok).toBe(true);
    expect(subject()).toBe("feat four edited");
    expect(at("HEAD", "a.txt")).toBe("four edited\n");
    expect(git("rev-list", "--count", "HEAD").stdout.toString().trim()).toBe("5");
  });

  it("refuses with unstaged changes so they cannot be silently dropped", () => {
    writeFileSync(join(repo, "a.txt"), "dirty\n");
    const r = amendCommit(repo, "new title", "");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("unstaged");
    expect(subject()).toBe("feat four");
  });

  it("refuses with nothing staged", () => {
    const r = amendCommit(repo, "new title", "");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("nothing staged");
  });
});

describe("squash", () => {
  beforeEach(build);

  it("folds a contiguous tip-run into one commit with the tree preserved", () => {
    const tip = hash("HEAD");
    const r = squashCommits(repo, hash("HEAD~1"), tip);
    expect(r.ok).toBe(true);
    // seed, feat one, feat two, then one commit holding "three"+"four".
    expect(git("rev-list", "--count", "HEAD").stdout.toString().trim()).toBe("4");
    expect(git("rev-list", "--count", `${hash("HEAD~1")}..HEAD`).stdout.toString().trim()).toBe("1");
    expect(at("HEAD", "b.txt")).toBe("two\n");
    expect(at("HEAD", "c.txt")).toBe("three\n");
    expect(at("HEAD", "a.txt")).toBe("four\n");
    expect(git("status", "--porcelain").stdout.toString().trim()).toBe("");
    // The old tip is the undo point.
    expect(git("rev-parse", "ORIG_HEAD").stdout.toString().trim()).toBe(tip);
  });

  it("refuses a range that is not contiguous to HEAD", () => {
    const r = squashCommits(repo, hash("HEAD~2"), hash("HEAD~1"));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("contiguous");
    expect(subject()).toBe("feat four");
  });

  it("refuses a newest that is not an ancestor of HEAD", () => {
    git("checkout", "-q", "-b", "side", "HEAD~2");
    writeFileSync(join(repo, "d.txt"), "side\n");
    git("add", "-A"); git("commit", "-qm", "side work");
    const side = hash("HEAD");
    git("checkout", "-q", "main");
    const r = squashCommits(repo, hash("HEAD"), side);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not in this branch's history");
  });
});
