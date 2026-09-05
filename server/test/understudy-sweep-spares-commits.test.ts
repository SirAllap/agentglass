/**
 * `sweepEmptyWorktrees` already asks git how many commits are still on a
 * spared branch, to decide whether to delete it. It used to throw that number
 * away the moment the answer was "keep it" — the row stayed on hold with
 * nothing to show for the measurement it had just made.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../src/db.ts";
import * as Work from "../src/understudy-work.ts";
import { sweepEmptyWorktrees, setGitHook, commitsSpared } from "../src/understudy-watchdog.ts";

const REPO = "/tmp/understudy-sweep-probe";

let worktree: string;

beforeEach(() => {
  db.exec("DELETE FROM understudy_work");
  worktree = mkdtempSync(join(tmpdir(), "understudy-sweep-"));
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
  setGitHook(async () => ({ ok: true, out: "" }));
});

function failedRunWithBranch(branch: string, outcome: string) {
  const item = { source: "asked", id: `asked:${branch}`, title: "left something behind", detail: "", repo: REPO, weight: 1 };
  const id = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree, branch });
  Work.finishRun(id!, "failed", outcome);
  return id!;
}

test("a branch with commits is spared, and the row says how many and where", async () => {
  const id = failedRunWithBranch("feat/spared", "tests failed: 2 of 90");
  setGitHook(async (args) => {
    if (args[0] === "rev-list") return { ok: true, out: "3\n" };
    return { ok: true, out: "" };
  });

  const swept = await sweepEmptyWorktrees();
  /*
   * THE DIRECTORY GOES, THE COMMITS DO NOT — and that is a change from what
   * this test first asserted.
   *
   * Sparing the whole worktree left a checkout list nobody could read after a
   * busy day: "we must not leave WTs that are already finished... but without
   * losing work they have done". Both halves hold at once, because git already
   * keeps the work: the BRANCH has every commit whether or not a directory
   * points at it, and `git worktree add` brings the directory back in a second.
   * So a clean tree is freed and its branch is named in the answer.
   */
  expect(swept.length, "a finished run's clean worktree should not be left behind").toBe(1);
  expect(swept[0]!.kept, "the branch holding the work has to be named").toBe("feat/spared");

  const row = Work.runs(10).find((r) => r.id === id)!;
  expect(row.state, "freeing a worktree is not a verdict on the run").toBe("failed");
  expect(row.outcome).toContain("tests failed: 2 of 90");
  expect(row.outcome).toContain("Left 3 commits on feat/spared that nobody has merged");
  expect(commitsSpared(row.outcome)).toBe(3);
});

test("but a worktree with uncommitted work in it stays", async () => {
  /* The one thing a branch does NOT hold. Asked of git rather than assumed:
     `status --porcelain` with anything in it means the directory is the only
     copy, and the only copy is never swept. */
  failedRunWithBranch("feat/dirty", "tests failed");
  setGitHook(async (args) => {
    if (args[0] === "rev-list") return { ok: true, out: "2\n" };
    if (args[0] === "status") return { ok: true, out: " M server/src/thing.ts\n" };
    return { ok: true, out: "" };
  });

  expect((await sweepEmptyWorktrees()).length).toBe(0);
});

test("running the sweep again does not pile up duplicate lines", async () => {
  const id = failedRunWithBranch("feat/repeat", "tests failed");
  setGitHook(async (args) => {
    if (args[0] === "rev-list") return { ok: true, out: "1\n" };
    return { ok: true, out: "" };
  });

  await sweepEmptyWorktrees();
  await sweepEmptyWorktrees();

  const row = Work.runs(10).find((r) => r.id === id)!;
  expect(row.outcome.split("Left 1 commit on feat/repeat").length - 1).toBe(1);
});

test("a spared branch's count updates if more lands on it before the next sweep", async () => {
  const id = failedRunWithBranch("feat/growing", "tests failed");
  let count = "1\n";
  setGitHook(async (args) => {
    if (args[0] === "rev-list") return { ok: true, out: count };
    return { ok: true, out: "" };
  });

  await sweepEmptyWorktrees();
  count = "4\n";
  await sweepEmptyWorktrees();

  const row = Work.runs(10).find((r) => r.id === id)!;
  expect(commitsSpared(row.outcome)).toBe(4);
  expect(row.outcome).not.toContain("Left 1 commit");
});

test("a branch with nothing on it is still removed, untouched by the new line", async () => {
  const id = failedRunWithBranch("feat/empty", "tests failed");
  setGitHook(async (args) => {
    if (args[0] === "rev-list") return { ok: true, out: "0\n" };
    if (args[0] === "worktree") return { ok: true, out: "" };
    return { ok: true, out: "" };
  });

  const swept = await sweepEmptyWorktrees();
  expect(swept.some((s) => s.runId === id)).toBe(true);

  const row = Work.runs(10).find((r) => r.id === id)!;
  expect(row.outcome).toBe("tests failed");
});

test("commitsSpared reads 0 out of an outcome the sweep never touched", () => {
  expect(commitsSpared("tests failed: 2 of 90")).toBe(0);
  expect(commitsSpared("")).toBe(0);
});

test("and so does one with work in it that was never committed at all", async () => {
  /*
   * THE CASE THE DIRTY CHECK WAS NOT ASKED ABOUT.
   *
   * The check above only ran on the branch that HAD commits. A run that wrote
   * code and never committed it — the ordinary shape of an agent that ran out
   * of turn, and of every run this register calls `empty` — went down the
   * other path, which asked git nothing and ran `worktree remove --force`.
   * Force is the flag that removes a dirty tree, so the one copy of that work
   * was deleted by the tidy-up. "We must not leave WTs that are already
   * finished... but without losing work they have done": this is the second
   * half, and it is the half that has no branch to fall back on.
   */
  failedRunWithBranch("feat/uncommitted", "it ran out of turn");
  let removed = false;
  setGitHook(async (args) => {
    if (args[0] === "rev-list") return { ok: true, out: "0\n" };
    if (args[0] === "status") return { ok: true, out: " M web/src/components/Thing.tsx\n?? server/test/thing.test.ts\n" };
    if (args[0] === "worktree" && args[1] === "remove") { removed = true; return { ok: true, out: "" }; }
    return { ok: true, out: "" };
  });

  const swept = await sweepEmptyWorktrees();
  expect(removed, "a directory holding the only copy of some work is never removed").toBe(false);
  expect(swept.length).toBe(0);
});

test("a branch with nothing on it and nothing in it still goes", async () => {
  /* The sweep's whole reason to exist: the leftovers of a run that died before
     it wrote anything. Sparing those is how the checkout list became a screen
     nobody could read. */
  failedRunWithBranch("feat/nothing", "it never started");
  const asked: string[] = [];
  setGitHook(async (args) => {
    asked.push(args.join(" "));
    if (args[0] === "rev-list") return { ok: true, out: "0\n" };
    if (args[0] === "status") return { ok: true, out: "" };
    return { ok: true, out: "" };
  });

  const swept = await sweepEmptyWorktrees();
  expect(asked.some((a) => a.startsWith("worktree remove")), "an empty leftover is the thing this sweep is for").toBe(true);
  expect(swept.length).toBe(1);
});
