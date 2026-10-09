/*
 * "Update branch" says what it is going to do to this machine.
 *
 * The button merges the base into the head on GitHub, and that is all it has
 * ever done — so every press left the copy of that branch on disk one commit
 * staler, silently. You find out later, from a rejected push or a diff that
 * disagrees with the pull request you just read.
 *
 * What is pinned here is the split: exactly one state asks the server to touch
 * anything local (a branch that can be fast-forwarded), and every other state
 * has to produce a sentence instead. A machine with a dozen worktrees and an
 * agent in each is not somewhere to move a HEAD to save somebody a `git pull`.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { updateBranchMove, branchNoticeJump } from "../src/lib/updateBranch.ts";
import type { PrLocalHead } from "../../shared/types.ts";

const head = (over: Partial<PrLocalHead> = {}): PrLocalHead =>
  ({ branch: "feat/thing", exists: true, ahead: 0, behind: 1, dirty: false, sync: "ff", ...over });

describe("when there is nothing local to bring along", () => {
  it("behaves exactly as it did before if the server said nothing", () => {
    const m = updateBranchMove(56, "main", undefined);
    expect(m.label).toBe("Update branch · 56 behind");
    expect(m.syncLocal).toBe(false);
    expect(m.notice).toBeUndefined();
  });

  it("says nothing extra when this branch has no local copy", () => {
    const m = updateBranchMove(3, "main", head({ exists: false, sync: "absent" }));
    expect(m.label).toBe("Update branch · 3 behind");
    expect(m.syncLocal).toBe(false);
    expect(m.notice).toBeUndefined();
  });
});

describe("when the local copy can come along", () => {
  it("says so on the button, and asks for it", () => {
    const m = updateBranchMove(56, "main", head({ worktree: "/home/x/code/thing" }));
    expect(m.label).toBe("Update branch & pull · 56 behind");
    expect(m.syncLocal).toBe(true);
    expect(m.notice).toBeUndefined();
    expect(m.title).toContain("/home/x/code/thing");
  });

  it("still says so for a branch nobody has checked out — the easiest case of all", () => {
    // No working tree is involved: the ref moves, git enforces the
    // fast-forward, and nobody's editor sees anything change.
    const m = updateBranchMove(1, "main", head({ worktree: undefined }));
    expect(m.syncLocal).toBe(true);
    expect(m.title).toContain("local feat/thing");
  });
});

describe("when it cannot", () => {
  const WT = "/home/x/code/orbit-ORBIT-1042";
  const BR = "ORBIT-1042-add-retry-to-sync";

  it("does not ask for a sync, and hands the notice the facts — uncommitted changes", () => {
    const m = updateBranchMove(56, "main", head({ sync: "dirty", dirty: true, worktree: WT, branch: BR }));
    expect(m.syncLocal).toBe(false);
    expect(m.label).toBe("Update branch · 56 behind");
    expect(m.notice).toEqual({ kind: "dirty", worktree: WT, branch: BR, ahead: 0 });
  });

  it("does not ask for a sync, and hands the notice the facts — local commits GitHub has not got", () => {
    const m = updateBranchMove(4, "main", head({ sync: "diverged", ahead: 2, worktree: WT, branch: BR }));
    expect(m.syncLocal).toBe(false);
    expect(m.notice).toEqual({ kind: "diverged", worktree: WT, branch: BR, ahead: 2 });
    expect(m.title).toContain("2 commits that GitHub does not");
  });

  it("does not ask for a sync, and hands the notice the facts — that checkout is mid-merge", () => {
    const m = updateBranchMove(4, "main", head({ sync: "busy", worktree: WT, branch: BR }));
    expect(m.syncLocal).toBe(false);
    expect(m.notice).toEqual({ kind: "busy", worktree: WT, branch: BR, ahead: 0 });
  });

  it("gives no sentence of its own: the words are the notice's, in one place", () => {
    for (const sync of ["dirty", "diverged", "busy"] as const) {
      const m = updateBranchMove(4, "main", head({ sync, ahead: 1, worktree: WT }));
      expect(Object.keys(m).sort()).toEqual(["label", "notice", "syncLocal", "title"]);
    }
  });

  it("counts in singular where it should", () => {
    expect(updateBranchMove(1, "main", head({ sync: "diverged", ahead: 1 })).title).toContain("1 commit that GitHub");
    expect(updateBranchMove(1, "main", undefined).title).toContain("1 commit behind");
  });
});

/* The notice's button goes inside the app to what is in the way. Which place,
   for which kind, is a decision, so it is pinned here and not in the screen. */
describe("where the notice's button goes", () => {
  const ROOT = "/home/x/code/orbit";
  const n = (over: object) => ({ kind: "dirty", worktree: "/home/x/code/orbit-ORBIT-1042", branch: "ORBIT-1042-add-retry-to-sync", ahead: 0, ...over }) as any;

  it("dirty: File changes, filtered to that worktree", () => {
    expect(branchNoticeJump(n({}), ROOT)).toEqual({ view: "diff", filter: "orbit-ORBIT-1042" });
  });
  it("diverged: Git, on that worktree's history, where the unpushed commits are", () => {
    expect(branchNoticeJump(n({ kind: "diverged", ahead: 2 }), ROOT)).toEqual({ view: "git", root: "/home/x/code/orbit-ORBIT-1042", tab: "log" });
  });
  it("diverged and checked out nowhere: the repository's Branches, whose row counts them", () => {
    expect(branchNoticeJump(n({ kind: "diverged", ahead: 2, worktree: undefined }), ROOT)).toEqual({ view: "git", root: ROOT, tab: "branches" });
  });
  it("busy: Git, on that worktree's changes, where the merge in progress is", () => {
    expect(branchNoticeJump(n({ kind: "busy" }), ROOT)).toEqual({ view: "git", root: "/home/x/code/orbit-ORBIT-1042", tab: "changes" });
  });
  it("never a terminal", () => {
    for (const kind of ["dirty", "diverged", "busy"]) {
      for (const worktree of ["/home/x/code/orbit-ORBIT-1042", undefined]) {
        expect(branchNoticeJump(n({ kind, worktree }), ROOT).view).not.toBe("term");
      }
    }
  });
});

/* The layout and the warning are drawn in two components, and the picture
   cannot be rendered here, so what is pinned is the wiring and the words: the
   notice goes to the box's own full-width row (as `extraNode` its `basis-full`
   was relative to a wrapper only as wide as the button, and it sat beside it),
   one component words all three kinds, and the button wears the same hatch as
   the merge button, from one constant, whenever there is a notice at all. */
const updateSrc = await Bun.file(new URL("../src/lib/updateBranch.ts", import.meta.url)).text();
const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const box = await Bun.file(new URL("../src/components/MergeBox.tsx", import.meta.url)).text();
const jumpSrc = await Bun.file(new URL("../src/lib/worktreeJump.ts", import.meta.url)).text();
const git = await Bun.file(new URL("../src/components/GitPanel.tsx", import.meta.url)).text();
const code = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join("\n");
/** One function's source, from its signature to its own closing brace. */
const fn = (src: string, sig: string) => {
  const at = src.indexOf(sig);
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf("\n}\n", at);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end + 2);
};

describe("the Update branch notice in the merge box", () => {
  let notice = "";
  beforeAll(() => { notice = code(fn(panel, "function UpdateBranchNotice(")); });

  it("is its own full-width row under the buttons, for every kind", () => {
    expect(code(panel)).toMatch(/noticeNode=\{noticeNode\}/);
    expect(code(panel)).toMatch(/const noticeNode = canUpdate && updateMove\.notice \? <UpdateBranchNotice notice=\{updateMove\.notice\} root=\{root\} \/> : undefined;/);
    expect(code(box)).toMatch(/\{noticeNode && <div className="basis-full /);
  });

  it("says, in each kind, that only GitHub moves — one sentence, the same shape", () => {
    expect(notice).toContain("{why}, so Update branch is a remote-only sync: it updates the branch on GitHub and leaves {here} as it is. {next}");
  });

  it("keeps the dirty wording the reference was approved with, and says why and what next for the other two", () => {
    expect(notice).toContain('why: "Your local copy has uncommitted changes", here: "this checkout", next: "Stash them, or commit and push, and it can update both."');
    expect(notice).toMatch(/`Your local branch has \$\{n\.ahead\} commit\$\{[^}]+\} GitHub does not have`/);
    expect(notice).toContain('`Pull, then push ${one ? "it" : "them"}, and it can update both.`');
    expect(notice).toContain('"Your local copy has a merge, cherry-pick or revert in progress"');
    expect(notice).toContain('"Finish or abort it, push anything it leaves, and it can update both."');
  });

  it("draws the worktree and the branch as chips: the worktree never gives way, the branch truncates with its name on hover", () => {
    expect(notice).toMatch(/data-notice-worktree className="shrink-0 whitespace-nowrap[^"]*" title=\{n\.worktree\}/);
    expect(notice).toMatch(/data-notice-branch className="truncate min-w-0[^"]*" title=\{n\.branch\}/);
  });

  it("has one button, and it goes inside the app, to where the lib says", () => {
    expect(notice.match(/<Btn /g)?.length).toBe(1);
    expect(notice).toContain("requestWorktreeJump(branchNoticeJump(n, root))");
    for (const label of ['"Review changes"', '"Show commits"', '"Show branch"', '"Open in Git"']) expect(notice).toContain(label);
  });

  it("is the only place the words live: no sentence left in the lib or the panel's node", () => {
    const lib = code(fn(updateSrc, "export function updateBranchMove("));
    expect(lib).not.toContain("note:");
    expect(lib).not.toContain("dirtyTree");
    expect(code(panel)).not.toContain("updateMove.note");
  });

  it("puts the merge button's hatch on Update branch in every kind", () => {
    for (const sync of ["dirty", "diverged", "busy"] as const) {
      expect(updateBranchMove(5, "main", head({ sync, ahead: 1, worktree: "/x/wt" })).notice).toBeDefined();
    }
    expect(code(panel)).toMatch(/<Btn onClick=\{\(\) => onUpdateBranch\(updateMove\.syncLocal\)\}[^\n]*hazard=\{!!updateMove\.notice\}/);
    expect(code(panel).match(/background: HAZARD_STRIPE/g)?.length).toBe(3);
    expect(code(panel)).not.toContain('background: "repeating-linear-gradient(135deg, var(--warning)');
  });
});

describe("a jump that names a Git tab lands on it", () => {
  it("is part of the request", () => {
    expect(jumpSrc).toMatch(/tab\?: "changes" \| "log" \| "branches";/);
  });
  it("GitPanel applies it, and its first-open reset does not undo it", () => {
    const g = code(git);
    expect(g).toContain("if (wtJump.tab) setView(wtJump.tab);");
    const at = g.indexOf("if (firstOpen.current) {");
    expect(at).toBeGreaterThan(-1);
    expect(g.slice(at, g.indexOf("}", at))).not.toContain("setView(");
  });
});
