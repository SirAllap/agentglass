/*
 * THE EMPTY BRANCH THAT KILLED A SHIFT.
 *
 * Branch names are a hash of the item, so a task whose run died badly can
 * never be cut again: every attempt answers "a branch named … already exists",
 * the loop counts it as a failed round, and `shouldStop` ends the whole shift.
 * Measured 2026-08-27 — one run died of a directory swept from under it, and
 * the deputy was then idle for the rest of the afternoon over a branch with
 * nothing on it that nobody could see from the screen.
 *
 * Driven through `workUntilDone` with a git that answers the way git does,
 * because what is being pinned is a sequence of git calls, not a helper.
 */
import { describe, expect, test } from "bun:test";
import * as Loop from "../src/understudy-loop.ts";

type Call = { args: string[]; cwd: string };

/** A git that refuses the first `worktree add` the way a leftover branch does,
 *  and answers everything else plainly. `holds` is how many commits the branch
 *  is carrying. */
function fakeGit(holds: number, opts: { checkedOut?: boolean } = {}) {
  const calls: Call[] = [];
  const git = async (args: string[], cwd: string) => {
    calls.push({ args, cwd });
    const a = args.join(" ");
    if (a.startsWith("worktree add")) {
      const first = calls.filter((c) => c.args.join(" ").startsWith("worktree add")).length === 1;
      return first
        ? { ok: false, out: "fatal: a branch named 'feat/x' already exists" }
        : { ok: true, out: "" };
    }
    if (a.startsWith("worktree list")) {
      return { ok: true, out: opts.checkedOut ? "worktree /tmp/other\nbranch refs/heads/feat/x\n" : "worktree /tmp/main\n" };
    }
    if (a.startsWith("rev-list")) return { ok: true, out: `${holds}\n` };
    if (a.startsWith("branch -D")) return { ok: true, out: "" };
    return { ok: true, out: "" };
  };
  return { git, calls };
}

const cut = (git: (args: string[], cwd: string) => Promise<{ ok: boolean; out: string }>) =>
  Loop.__cutWorktree("/tmp/repo", "feat/x", git);

describe("cutting a worktree over a branch that is already there", () => {
  test("an empty leftover is removed and the cut is retried", async () => {
    const { git, calls } = fakeGit(0);
    const r = await cut(git);
    expect(r.ok, "an empty leftover branch stopped the whole shift").toBe(true);
    expect(calls.some((c) => c.args.join(" ") === "branch -D feat/x")).toBe(true);
    expect(calls.filter((c) => c.args[0] === "worktree" && c.args[1] === "add").length).toBe(2);
  });

  test("but a branch holding work is never deleted, and says what it holds", async () => {
    const { git, calls } = fakeGit(3);
    const r = await cut(git);
    expect(r.ok).toBe(false);
    expect(r.says).toContain("3 commits");
    expect(calls.some((c) => c.args.join(" ").startsWith("branch -D")), "somebody's commits were thrown away").toBe(false);
  });

  test("nor one another worktree still has checked out", async () => {
    const { git, calls } = fakeGit(0, { checkedOut: true });
    const r = await cut(git);
    expect(r.ok).toBe(false);
    expect(r.says).toContain("another worktree");
    expect(calls.some((c) => c.args.join(" ").startsWith("branch -D"))).toBe(false);
  });
});
