/*
 * The doors between a pane, its branch, its pull request and its card.
 *
 * All of it is decided by data the phone already asks for: the branch of a
 * checkout (`/git/repo`), what the branch opens (`/prs/for-branch`), and the
 * tab strip. The fixtures are hand-built, never the classifier's own output.
 *
 * The trap the worktree cases hold: two checkouts of one repository share
 * `repo`, so a lookup that falls back to it draws the pane of the other branch
 * — plausibly, which is the worst kind of wrong on this screen.
 */
import { describe, expect, test } from "bun:test";
import type { PrBranchSummary } from "../../shared/types.ts";
import type { Tab } from "../src/terminal/tabs.ts";
import { paneForBranch, paneForKey, prForBranch, taskKeyIn } from "../src/model/goToWork.ts";

const tab = (over: Partial<Tab>): Tab => ({
  paneId: "%1", label: "1 orbit-1042", name: "orbit-1042", session: "work",
  where: "/home/dev/code/orbit-1042", agent: true, windowId: "@1",
  windowName: "orbit-1042", windowPanes: 1, ...over,
});

/** Two worktrees of acme/orbit, each on its own branch. */
const twoWorktrees: Tab[] = [
  tab({}),
  tab({
    paneId: "%2", label: "2 orbit-1050", name: "orbit-1050", where: "/home/dev/code/orbit-1050",
    windowId: "@2", windowName: "orbit-1050",
  }),
];
const branches: Record<string, string> = {
  "/home/dev/code/orbit-1042": "feat/ORBIT-1042",
  "/home/dev/code/orbit-1050": "feat/ORBIT-1050",
};

const pr = (over: Partial<PrBranchSummary>): PrBranchSummary => ({
  number: 184, title: "Add dark mode", author: "dev", state: "OPEN", isDraft: false,
  headRefName: "feat/ORBIT-1042", baseRefName: "main",
  url: "https://github.com/acme/orbit/pull/184", updatedAt: "2026-11-04T09:00:00Z",
  reviewDecision: "APPROVED", ...over,
});

describe("a branch and its pull request", () => {
  test("says which one the branch opens", () => {
    const found = prForBranch({ ok: true, from: pr({}), into: [] });
    expect(found.hit?.number).toBe(184);
  });

  test("misses without inventing one, and says why", () => {
    const miss = prForBranch({ ok: true, into: [] });
    expect(miss.hit).toBeNull();
    expect(miss.why).toContain("No pull request");
    const broke = prForBranch({ ok: false, into: [], error: "GitHub did not answer." });
    expect(broke.hit).toBeNull();
    expect(broke.why).toBe("GitHub did not answer.");
  });

  test("a branch that is only another pull request's base is not its pull request", () => {
    const out = prForBranch({ ok: true, into: [pr({ number: 200, headRefName: "feat/ORBIT-200" })] });
    expect(out.hit).toBeNull();
    expect(out.why).toContain("#200");
  });

  test("a signed-out computer is told apart from a branch with no pull request", () => {
    const out = prForBranch({ ok: true, into: [], needsAuth: true });
    expect(out.hit).toBeNull();
    expect(out.why).toContain("not signed in");
  });
});

describe("a pull request and its pane", () => {
  test("finds the worktree on that branch", () => {
    expect(paneForBranch(twoWorktrees, branches, "feat/ORBIT-1050")?.paneId).toBe("%2");
  });

  test("two worktrees of one repository are told apart by their branches", () => {
    // Both share acme/orbit; only their directories and branches separate them.
    expect(paneForBranch(twoWorktrees, branches, "feat/ORBIT-1042")?.paneId).toBe("%1");
  });

  test("no branch answer is no pane, never a guess at the repository's first worktree", () => {
    expect(paneForBranch(twoWorktrees, {}, "feat/ORBIT-1050")).toBeNull();
    expect(paneForBranch(twoWorktrees, branches, "fix/checks")).toBeNull();
    expect(paneForBranch(twoWorktrees, branches, null)).toBeNull();
  });

  test("a trailing slash on either side is the same directory", () => {
    expect(paneForBranch(twoWorktrees, { "/home/dev/code/orbit-1050/": "feat/ORBIT-1050" }, "feat/ORBIT-1050")?.paneId)
      .toBe("%2");
  });
});

describe("a card and its pane", () => {
  test("the key is read out of the branch", () => {
    expect(taskKeyIn("feat/ORBIT-1042")).toBe("ORBIT-1042");
    expect(taskKeyIn("main")).toBeNull();
    // A lower-case `utf-8` is not a project key: the branch has no upper case.
    expect(taskKeyIn("fix/utf-8")).toBeNull();
  });

  test("the key finds the pane running that branch", () => {
    expect(paneForKey(twoWorktrees, branches, "ORBIT-1050")?.paneId).toBe("%2");
  });

  test("a window named after the key is the fallback when git did not answer", () => {
    expect(paneForKey(twoWorktrees, {}, "ORBIT-1042")?.paneId).toBe("%1");
  });

  test("two windows carrying one key are not a coin flip", () => {
    const twins = [
      tab({}),
      tab({ paneId: "%2", name: "orbit-1042-sync", where: "/home/dev/code/orbit-1042-sync" }),
    ];
    expect(paneForKey(twins, {}, "ORBIT-1042")).toBeNull();
  });
});
