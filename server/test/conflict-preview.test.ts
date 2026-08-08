/*
 * Naming the files a merge would conflict on, without merging anything.
 *
 * The panel that wants this is polling, on a checkout somebody is working in.
 * The existing "Resolve conflicts" button makes a REAL merge in a worktree of
 * its own — the right thing to do when you are about to resolve, and far too
 * much to do just to say "these three files".
 *
 * `git merge-tree --write-tree` merges entirely in the object database. The
 * first test here is the one the whole feature rests on: after asking, the
 * working tree is untouched and HEAD has not moved.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-preview-")));
process.env.AGENTGLASS_ROOT = dir;
const { conflictPreview } = await import("../src/gitwork.ts");

let repo = "";
const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd: repo });

/** main and feat, disagreeing about seven files and agreeing about one — with
 *  an `origin` that is really itself, so the fetch has somewhere to go. */
function build(): void {
  repo = join(dir, `r-${Math.random().toString(36).slice(2)}`);
  Bun.spawnSync(["mkdir", "-p", repo]);
  git("init", "-q", "-b", "main", ".");
  for (const f of "abcdefg") writeFileSync(join(repo, `${f}.txt`), "base\n");
  writeFileSync(join(repo, "quiet.txt"), "nobody touches this\n");
  git("add", "-A"); git("commit", "-qm", "seed");
  git("remote", "add", "origin", repo);

  git("checkout", "-q", "-b", "feat");
  for (const f of "abcdefg") writeFileSync(join(repo, `${f}.txt`), "theirs\n");
  writeFileSync(join(repo, "only-on-feat.txt"), "new\n");
  git("add", "-A"); git("commit", "-qm", "feat side");

  git("checkout", "-q", "main");
  for (const f of "abcdefg") writeFileSync(join(repo, `${f}.txt`), "ours\n");
  git("add", "-A"); git("commit", "-qm", "main side");
  git("fetch", "-q", "origin");
}

beforeEach(build);
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("asking costs nothing", () => {
  it("leaves the working tree and HEAD exactly as they were", () => {
    // The claim the feature rests on. A panel poll must not move anything in
    // a checkout somebody is typing in.
    const head = git("rev-parse", "HEAD").stdout.toString();
    const before = git("status", "--porcelain").stdout.toString();
    return conflictPreview(repo, "main", "feat").then(() => {
      expect(git("rev-parse", "HEAD").stdout.toString()).toBe(head);
      expect(git("status", "--porcelain").stdout.toString()).toBe(before);
      expect(git("rev-parse", "--verify", "--quiet", "MERGE_HEAD").exitCode).not.toBe(0);
    });
  });
});

describe("what it reports", () => {
  it("names every file that would conflict, and nothing else", async () => {
    const r = await conflictPreview(repo, "main", "feat");
    expect(r.ok).toBe(true);
    expect(r.clean).toBe(false);
    expect(r.conflicts.sort()).toEqual(["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt", "g.txt"]);
    // Files the merge carries but nobody has to decide are not conflicts.
    expect(r.conflicts).not.toContain("only-on-feat.txt");
    expect(r.conflicts).not.toContain("quiet.txt");
  });

  it("says a clean merge is clean rather than inventing a conflict", async () => {
    git("checkout", "-q", "-b", "tidy", "main");
    writeFileSync(join(repo, "elsewhere.txt"), "unrelated\n");
    git("add", "-A"); git("commit", "-qm", "elsewhere");
    git("checkout", "-q", "main");
    git("fetch", "-q", "origin");
    const r = await conflictPreview(repo, "main", "tidy");
    expect(r.ok).toBe(true);
    expect(r.clean).toBe(true);
    expect(r.conflicts).toEqual([]);
  });

  it("counts a file one side deleted and the other edited", async () => {
    // A different kind of conflict from two edits, and one people meet: git
    // reports it as a conflicted path with no content to choose between. If it
    // were missed, the list would say "2 files" over a merge that stops on 3.
    git("checkout", "-q", "-b", "pruner", "main");
    git("rm", "-q", "quiet.txt");
    git("commit", "-qm", "drop it");
    git("checkout", "-q", "-b", "keeper", "main");
    writeFileSync(join(repo, "quiet.txt"), "still wanted\n");
    git("commit", "-qam", "keep it");
    git("fetch", "-q", "origin");
    const r = await conflictPreview(repo, "pruner", "keeper");
    expect(r.ok).toBe(true);
    expect(r.conflicts).toContain("quiet.txt");
  });
});

describe("what it refuses", () => {
  it("refuses a branch name that is not one", async () => {
    expect((await conflictPreview(repo, "main; rm -rf /", "feat")).ok).toBe(false);
    expect((await conflictPreview(repo, "main", "--upload-pack=evil")).ok).toBe(false);
  });

  it("says which branch it has no copy of, rather than reporting no conflicts", async () => {
    // Reporting "clean" for a branch nobody has is how a merge button gets
    // enabled on a pull request that cannot merge.
    const r = await conflictPreview(repo, "main", "never-existed");
    expect(r.ok).toBe(false);
    expect(r.clean).toBe(false);
    expect(r.error).toContain("never-existed");
  });

  it("refuses a path that is not a repository", async () => {
    expect((await conflictPreview(join(dir, "nope"), "main", "feat")).ok).toBe(false);
  });
});

describe("a pull request from a fork", () => {
  it("uses refs/pull/<n>/head, because there is no branch on origin to fetch", async () => {
    // Measured against this repository's own open pull requests: one of the
    // two is from a fork, so refs/heads/<branch> does not exist on origin and
    // the first version of this answered "no local copy" for a pull request
    // whose conflict it could name perfectly well. On a public repository that
    // is the ordinary case. The same ref also survives the author deleting
    // their branch while the pull request is open — which is what this does,
    // to prove the branch name is not what makes it work.
    const sha = git("rev-parse", "feat").stdout.toString().trim();
    git("update-ref", "refs/pull/7/head", sha);
    git("branch", "-D", "feat");
    expect(git("rev-parse", "--verify", "--quiet", "feat").exitCode).not.toBe(0);

    const r = await conflictPreview(repo, "main", "feat", 7);
    expect(r.ok).toBe(true);
    expect(r.conflicts.length).toBe(7);
  });

  it("still falls back to the branch when there is no pull ref", async () => {
    const r = await conflictPreview(repo, "main", "feat", 999);
    expect(r.ok).toBe(true);
    expect(r.conflicts.length).toBe(7);
  });
});

describe("when the fetch cannot happen", () => {
  it("still answers, and marks the answer stale", async () => {
    // Offline-and-approximate beats offline-and-silent, but the caller has to
    // be able to tell the difference.
    git("remote", "set-url", "origin", join(dir, "not-a-remote"));
    const r = await conflictPreview(repo, "main", "feat");
    expect(r.ok).toBe(true);
    expect(r.stale).toBe(true);
    expect(r.conflicts.length).toBe(7);
  });
});
