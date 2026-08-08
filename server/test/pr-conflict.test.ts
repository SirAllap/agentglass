/*
 * Putting a pull request's conflict somewhere it can be resolved.
 *
 * Against a real git repository in a temp directory, because every claim here
 * is a claim about git: that the merge lands in a worktree of its OWN, that the
 * checkout you are standing in is untouched, that pressing twice is the same as
 * pressing once, and that "no conflict after all" is reported rather than
 * mistaken for one.
 *
 * No network and no GitHub: the branch names are the input, and working out
 * which two branches a pull request is between is somebody else's job.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// realpath, because git records the resolved path in a worktree's .git file and
// these assertions compare paths. The scope guard reads the machine's real
// config, so it is pointed at the fixture BEFORE gitwork is imported — the same
// dance remote-branches.test.ts does.
const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-prconf-")));
process.env.AGENTGLASS_ROOT = dir;
const { prepareConflictMerge } = await import("../src/gitwork.ts");

let repo = "";

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd });

/** A repository with two branches that touch the same line, and an `origin`
 *  that is really itself — enough for a fetch to succeed and for `origin/x` to
 *  mean something. */
function build(): string {
  const root = join(dir, `repo-${Math.random().toString(36).slice(2)}`);
  Bun.spawnSync(["mkdir", "-p", root]);
  git(root, "init", "-q", "-b", "main", ".");
  writeFileSync(join(root, "f.txt"), "base\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "first");
  git(root, "remote", "add", "origin", root);

  git(root, "checkout", "-q", "-b", "feature");
  writeFileSync(join(root, "f.txt"), "theirs\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "feature side");

  git(root, "checkout", "-q", "main");
  writeFileSync(join(root, "f.txt"), "ours\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "main side");
  git(root, "fetch", "-q", "origin");
  return root;
}

beforeEach(() => { repo = build(); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("preparing a conflict", () => {
  it("merges in a worktree of its own and names the files in conflict", () => {
    const r = prepareConflictMerge(repo, "feature", "main");
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual(["f.txt"]);
    expect(r.root).toBe(`${repo}-conflict-feature`);
    expect(existsSync(join(r.root!, "f.txt"))).toBe(true);
    // The markers are there, which is what the resolver reads.
    expect(readFileSync(join(r.root!, "f.txt"), "utf8")).toContain("<<<<<<<");
  });

  it("leaves the checkout you are standing in exactly as it was", () => {
    // The whole reason this uses a worktree. A button that rewrites the tree
    // somebody is working in is a button they learn not to press.
    const before = readFileSync(join(repo, "f.txt"), "utf8");
    const head = git(repo, "rev-parse", "HEAD").stdout.toString();
    prepareConflictMerge(repo, "feature", "main");
    expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe(before);
    expect(git(repo, "rev-parse", "HEAD").stdout.toString()).toBe(head);
    expect(git(repo, "status", "--porcelain").stdout.toString()).toBe("");
  });

  it("pressed twice is the same as pressed once", () => {
    // Both buttons prepare, and somebody will press the other one.
    const a = prepareConflictMerge(repo, "feature", "main");
    const b = prepareConflictMerge(repo, "feature", "main");
    expect(b.ok).toBe(true);
    expect(b.root).toBe(a.root);
    expect(b.conflicts).toEqual(["f.txt"]);
  });

  it("says the merge was clean rather than inventing a conflict", () => {
    // A branch that is only BEHIND merges through. Reporting that is the
    // difference between "push it" and a resolver opened on an empty list.
    const root = build();
    git(root, "checkout", "-q", "-b", "tidy", "main");
    writeFileSync(join(root, "other.txt"), "unrelated\n");
    git(root, "add", "-A"); git(root, "commit", "-qm", "elsewhere");
    git(root, "checkout", "-q", "main");
    git(root, "fetch", "-q", "origin");
    const r = prepareConflictMerge(root, "tidy", "main");
    expect(r.ok).toBe(true);
    expect(r.clean).toBe(true);
    expect(r.conflicts).toEqual([]);
  });

  it("uses the checkout that already has the branch, instead of refusing", () => {
    // The first version answered "already checked out at …", which is a fact
    // and not an instruction — and the wrong answer anyway: that checkout is
    // exactly where the merge belongs, and where somebody would do it by hand.
    const held = `${repo}-feature`;
    git(repo, "worktree", "add", held, "feature");
    const r = prepareConflictMerge(repo, "feature", "main");
    expect(r.ok).toBe(true);
    expect(r.root).toBe(held);
    expect(r.conflicts).toEqual(["f.txt"]);
    expect(readFileSync(join(held, "f.txt"), "utf8")).toContain("<<<<<<<");
  });

  it("refuses that checkout only when it has work in it, and says how to fix it", () => {
    // Merging into somebody's half-finished work is the one thing this whole
    // design exists to avoid — so the refusal carries the two words that clear
    // it rather than a description of the situation.
    const held = `${repo}-feature`;
    git(repo, "worktree", "add", held, "feature");
    writeFileSync(join(held, "f.txt"), "half a thought\n");
    const r = prepareConflictMerge(repo, "feature", "main");
    expect(r.ok).toBe(false);
    expect(r.error).toContain(held);
    expect(r.error).toContain("commit or stash");
  });

  it("pressed again mid-merge reports where it stands", () => {
    // `git merge` refuses while one is in progress and says nothing useful; the
    // list of conflicts is what the caller wanted either way.
    const first = prepareConflictMerge(repo, "feature", "main");
    const again = prepareConflictMerge(repo, "feature", "main");
    expect(again.ok).toBe(true);
    expect(again.root).toBe(first.root);
    expect(again.conflicts).toEqual(["f.txt"]);
  });

  it("refuses a branch name that is not one", () => {
    expect(prepareConflictMerge(repo, "feature; rm -rf /", "main").ok).toBe(false);
    expect(prepareConflictMerge(repo, "feature", "--upload-pack=evil").ok).toBe(false);
  });
});
