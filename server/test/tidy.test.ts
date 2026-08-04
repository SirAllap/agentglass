// Telling someone how to clean their repository, without touching it.
//
// The ask was explicit: "don't do anything yourself — tell me how I clean it,
// or give me something in the app that does it faster, and make sure you touch
// nothing in git." A checkout with fifty-five branches, twenty-four worktrees,
// twenty-two stashes and half a gigabyte in it, with branches whose owner
// could no longer say where they came from.
//
// So the module reads and returns strings. These tests hold that line — that
// it writes nothing, and that the lines it hands over cannot lose work — on a
// throwaway repository built here, never on anybody's real one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tidyReport, vetCommand } from "../src/tidy.ts";
import { git } from "../src/git.ts";

let repo: string;
let remoteDir: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "agx-tidy-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "one"]);
  // A branch that is genuinely merged, and one that is genuinely not.
  git(repo, ["branch", "already-merged"]);
  git(repo, ["checkout", "-q", "-b", "has-own-work"]);
  writeFileSync(join(repo, "b.txt"), "two\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "two"]);
  git(repo, ["checkout", "-q", "main"]);
  /**
   * A branch whose upstream is gone, built properly rather than assumed.
   *
   * The first version of this fixture had no remote at all, so the `gone`
   * finding never produced a command — and the test that forbids `-D` was
   * quietly checking a code path it never reached. Deliberately breaking the
   * module is what exposed that: swapping `-d` for `-D` turned nothing red.
   */
  const remote = mkdtempSync(join(tmpdir(), "agx-tidy-remote-"));
  git(remote, ["init", "-q", "--bare"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-q", "-u", "origin", "main"]);
  git(repo, ["checkout", "-q", "-b", "was-on-the-remote"]);
  git(repo, ["push", "-q", "-u", "origin", "was-on-the-remote"]);
  git(repo, ["checkout", "-q", "main"]);
  // The remote branch disappears — what a merged pull request does.
  git(remote, ["update-ref", "-d", "refs/heads/was-on-the-remote"]);
  git(repo, ["fetch", "-q", "--prune"]);
  remoteDir = remote;

  // A worktree whose directory is then deleted, so the prune finding exists.
  // Without this the finding never fired in tests, and swapping its command
  // for `git reset --hard` turned nothing red — the second time the same hole
  // appeared, which is what moved the safety rule into the module itself.
  const wt = join(repo, "..", `agx-tidy-wt-${process.pid}`);
  git(repo, ["worktree", "add", "-q", "-b", "in-a-worktree", wt]);
  rmSync(wt, { recursive: true, force: true });

  // Something set aside, so the stash finding has a subject.
  writeFileSync(join(repo, "a.txt"), "changed\n");
  git(repo, ["stash", "push", "-q", "-m", "wip"]);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  if (remoteDir) rmSync(remoteDir, { recursive: true, force: true });
});

const find = (r: ReturnType<typeof tidyReport>, id: string) => r.findings.find((f) => f.id === id);

describe("what it reports", () => {
  test("it uses the checkout's own default branch, not a guess", () => {
    // `master` here, `main` there. Comparing against a branch that does not
    // exist would report every branch as unmerged, which is the same as
    // reporting nothing while looking like it worked.
    expect(tidyReport(repo).base).toBe("main");
  });

  test("a merged branch is listed; a branch with its own work is not", () => {
    const merged = find(tidyReport(repo), "merged");
    expect(merged?.items).toContain("already-merged");
    expect(merged?.items).not.toContain("has-own-work");
  });

  test("a branch whose remote is gone is listed, with a command to match", () => {
    const gone = find(tidyReport(repo), "gone");
    expect(gone?.items).toContain("was-on-the-remote");
    // The command has to exist for the safety tests below to be testing
    // anything at all — that is the whole point of building the remote.
    expect(gone?.command).toContain("git branch -d");
  });

  test("a worktree whose directory is gone is found, with the exact safe command", () => {
    const w = find(tidyReport(repo), "worktrees");
    expect(w?.items.length).toBe(1);
    // Asserted exactly, not by pattern: this is the assertion that turns red
    // if somebody swaps the command for something destructive, which is the
    // failure two earlier versions of this file could not see.
    expect(w?.command).toBe("git worktree prune -v");
  });

  test("stashes are found and shown", () => {
    const s = find(tidyReport(repo), "stashes");
    expect(s?.items.length).toBe(1);
    expect(s?.items[0]).toContain("wip");
  });

  test("a directory that is not a checkout says so instead of throwing", () => {
    const r = tidyReport(tmpdir());
    expect(r.error).toBeTruthy();
    expect(r.findings).toEqual([]);
  });

  test("findings with nothing in them are absent, not empty", () => {
    // An empty section per category is furniture, and furniture is what
    // teaches people to skim past the section that matters.
    for (const f of tidyReport(repo).findings) expect(f.items.length).toBeGreaterThan(0);
  });
});

describe("the commands it is willing to hand over", () => {
  test("branch deletion is always -d, never -D", () => {
    /**
     * The single most important line in this file. `-d` refuses to delete a
     * branch whose work is not merged and names it; `-D` deletes it and the
     * commits with it. Every branch command here must be the one whose worst
     * case is a refusal.
     */
    for (const f of tidyReport(repo).findings) {
      if (!f.command) continue;
      expect(f.command).not.toMatch(/\bbranch\b.*\s-D\b/);
      expect(f.command).not.toMatch(/--force\b/);
      expect(f.command).not.toMatch(/\s-f\b/);
    }
  });

  test("no command can drop a stash", () => {
    // Uncommitted work is the one thing in a checkout that exists nowhere
    // else, so the panel offers no way to lose it and says why instead.
    const s = find(tidyReport(repo), "stashes");
    expect(s?.command).toBeNull();
    expect(s?.note).toContain("on purpose");
    for (const f of tidyReport(repo).findings) {
      expect(f.command ?? "").not.toContain("stash drop");
      expect(f.command ?? "").not.toContain("stash clear");
    }
  });

  test("nothing offered can rewrite history or discard a working tree", () => {
    const forbidden = [/reset\s+--hard/, /clean\s+-[a-z]*f/, /push\s+--force/, /filter-branch/, /reflog\s+expire/, /prune\s+--expire/];
    for (const f of tidyReport(repo).findings) {
      for (const bad of forbidden) expect(f.command ?? "").not.toMatch(bad);
    }
  });
});

describe("the guard that makes those rules total", () => {
  /**
   * Why this exists instead of more assertions over the report.
   *
   * The tests above can only examine commands the fixture happens to produce,
   * and a temporary checkout has no stale worktrees, no half-gigabyte of loose
   * objects and no eight hundred remote refs — so most findings never existed
   * and most commands were never looked at. Replacing a safe command with
   * `git reset --hard` turned nothing red. Twice, in two different findings.
   *
   * So the rule lives in the module now, and this drives it directly with the
   * dangerous input a fixture cannot be relied on to generate. It covers
   * findings nobody has written yet, which the report-walking tests never can.
   */
  const refuses = (cmd: string) => vetCommand(cmd).command === null;

  test("it refuses every way of losing committed work", () => {
    expect(refuses("git branch -D some-branch")).toBe(true);
    expect(refuses("git branch -d --force some-branch")).toBe(true);
    expect(refuses("git reset --hard")).toBe(true);
    expect(refuses("git push --force origin main")).toBe(true);
    expect(refuses("git filter-branch --all")).toBe(true);
  });

  test("it refuses every way of losing work that was never committed", () => {
    expect(refuses("git clean -fd")).toBe(true);
    expect(refuses("git stash drop stash@{0}")).toBe(true);
    expect(refuses("git stash clear")).toBe(true);
    // The reflog is what makes a mistaken deletion recoverable; expiring it is
    // what turns "undo it" into "it is gone".
    expect(refuses("git reflog expire --expire=now --all")).toBe(true);
    expect(refuses("git gc --prune=now")).toBe(true);
  });

  test("it lets the safe lines through untouched", () => {
    for (const ok of ["git branch -d a b c", "git worktree prune -v", "git gc", "git fetch --prune"]) {
      expect(vetCommand(ok).command).toBe(ok);
    }
  });

  test("a refused command loses its button and says why", () => {
    // Not silently dropped: a missing button with no explanation is a bug
    // report, and the reason is the interesting half.
    const v = vetCommand("git branch -D x");
    expect(v.command).toBeNull();
    expect(v.refused).toContain("unmerged");
  });
});

describe("it reads and does not write", () => {
  test("asking for the report changes nothing in the repository", () => {
    /**
     * The promise the whole module is built on, checked rather than asserted
     * in prose: take the repository's full state, ask for the report several
     * times, and take it again.
     */
    const state = () => JSON.stringify({
      branches: git(repo, ["branch", "--format=%(refname:short) %(objectname)"]).stdout,
      stashes: git(repo, ["stash", "list"]).stdout,
      worktrees: git(repo, ["worktree", "list", "--porcelain"]).stdout,
      head: git(repo, ["rev-parse", "HEAD"]).stdout,
      reflog: git(repo, ["reflog", "--format=%H %gs"]).stdout,
      file: readFileSync(join(repo, "a.txt"), "utf8"),
    });
    const before = state();
    tidyReport(repo); tidyReport(repo); tidyReport(repo);
    expect(state()).toBe(before);
  });
});
