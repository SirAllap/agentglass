/*
 * The three ways a conflict screen quietly destroys work, and the guards.
 *
 * All three were reproduced against a real repository before any of this was
 * written, because all three look fine in a mockup:
 *
 *  1. git FORGETS which files a stop conflicted. `git ls-files -u` goes from
 *     three to zero across one `git add`, and afterwards a resolved file is
 *     indistinguishable from the hundreds the merge staged on its own. Every
 *     "3 of 5 resolved" is a lie without a record.
 *
 *  2. `git checkout --merge -- <path>` — the obvious "undo" — replaces a
 *     hand-written resolution with the original markers. Exit 0. No output.
 *
 *  3. Anything can `git add` a file that still has markers in it, and from
 *     then on git considers it resolved and will commit `<<<<<<<` into the
 *     branch.
 */
import { afterAll, beforeEach, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-msess-")));
process.env.AGENTGLASS_ROOT = dir;
const { mergeSession, reopenConflict, mergeContinue, resolveBlocks, resolveWith, markersLeft, sessionOp, mergeInfo, stoppedRefusal } =
  await import("../src/gitwork.ts");
const { __setSessionPath } = await import("../src/mergesession.ts");

let repo = "";
const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd: repo });

const unmerged = () => git("diff", "--name-only", "--diff-filter=U").stdout.toString().split("\n").filter(Boolean);
const read = (f: string) => readFileSync(join(repo, f), "utf8");

/** A merge stopped on three files, plus 40 that came through clean — the
 *  shape that makes "commit everything" a dangerous button. */
function build(): void {
  repo = join(dir, `r-${Math.random().toString(36).slice(2)}`);
  Bun.spawnSync(["mkdir", "-p", repo]);
  git("init", "-q", "-b", "main", ".");
  for (const f of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(repo, f), "base\n");
  git("add", "-A"); git("commit", "-qm", "seed");

  git("checkout", "-q", "-b", "feat");
  for (const f of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(repo, f), "theirs\n");
  for (let i = 0; i < 40; i++) writeFileSync(join(repo, `clean-${i}.txt`), "only on feat\n");
  git("add", "-A"); git("commit", "-qm", "feat side");

  git("checkout", "-q", "main");
  for (const f of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(repo, f), "ours\n");
  git("add", "-A"); git("commit", "-qm", "main side");
  git("merge", "feat");
}

beforeEach(() => {
  __setSessionPath(join(dir, `s-${Math.random().toString(36).slice(2)}.json`));
  build();
});
afterEach(() => { __setSessionPath(null); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("what git stops remembering", () => {
  it("git really does forget, which is why this exists", () => {
    // The measurement the whole file rests on, kept as a test so it stays true.
    expect(unmerged()).toHaveLength(3);
    git("add", "a.txt");
    expect(unmerged()).toHaveLength(2);
    expect(git("ls-files", "-u", "a.txt").stdout.toString()).toBe("");
  });

  it("remembers the set from before anything was resolved", () => {
    expect(mergeSession(repo).files).toEqual(["a.txt", "b.txt", "c.txt"]);
    resolveWith(repo, "a.txt", "ours");
    const s = mergeSession(repo);
    expect(s.files).toEqual(["a.txt", "b.txt", "c.txt"]);   // still three
    expect(s.left).toEqual(["b.txt", "c.txt"]);             // two to go
  });

  it("survives a reload, which is the case that broke the counter", () => {
    // The panel being closed and reopened is not an edge case, it is Tuesday.
    mergeSession(repo);
    resolveWith(repo, "a.txt", "ours");
    resolveWith(repo, "b.txt", "theirs");
    const fresh = mergeSession(repo);
    expect(fresh.files).toHaveLength(3);
    expect(fresh.left).toEqual(["c.txt"]);
  });

  it("knows which files this app resolved, and which it did not", () => {
    mergeSession(repo);                       // the screen opens: all three seen
    resolveWith(repo, "a.txt", "ours");
    // b.txt gets settled the way an agent in a tmux tab would do it.
    writeFileSync(join(repo, "b.txt"), "a third thing\n");
    git("add", "b.txt");
    const s = mergeSession(repo);
    expect(s.mine).toEqual(["a.txt"]);
    expect(s.files).toContain("b.txt");
  });

  it("cannot know about a file resolved before it ever looked", () => {
    // The honest limit of a record built by observation: if an agent settles a
    // file in a terminal and only then is the screen opened, that file is
    // indistinguishable from the forty that merged cleanly — git kept nothing
    // to distinguish them by. The count says two, and two is what there is
    // left to do. Pinned so nobody later mistakes it for a bug in the counter.
    writeFileSync(join(repo, "a.txt"), "settled elsewhere, before we looked\n");
    git("add", "a.txt");
    const s = mergeSession(repo);
    expect(s.files).toEqual(["b.txt", "c.txt"]);
    expect(s.left).toEqual(["b.txt", "c.txt"]);
  });

  it("keeps a rebase's stops apart, because each one has its own files", () => {
    // One key per operation would carry commit 1's three files into commit 2's
    // screen, which would then open claiming it was nearly done.
    const a = sessionOp(mergeInfo(repo));
    expect(a).toStartWith("merging:");
    git("merge", "--abort");
    git("checkout", "-q", "feat");
    git("rebase", "main");
    const b = sessionOp(mergeInfo(repo));
    expect(b).toStartWith("rebasing:");
    expect(b).not.toBe(a);
  });

  it("says nothing at all once the merge is over", () => {
    git("merge", "--abort");
    const s = mergeSession(repo);
    expect(s.op).toBe("");
    expect(s.files).toEqual([]);
  });
});

describe("putting a conflict back", () => {
  it("git's own undo destroys a hand resolution, silently", () => {
    // Not a hypothetical and not an argument — the command, and what it does.
    writeFileSync(join(repo, "a.txt"), "the answer I worked out\n");
    git("add", "a.txt");
    const r = git("checkout", "--merge", "--", "a.txt");
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString()).toBe("");
    expect(read("a.txt")).toContain("<<<<<<<");
    expect(read("a.txt")).not.toContain("the answer I worked out");
  });

  it("refuses without a confirmation, and says what would be lost", () => {
    mergeSession(repo);
    resolveBlocks(repo, "a.txt", [{ edit: ["the answer I worked out"] }]);
    const r = reopenConflict(repo, "a.txt");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("throws away");
    expect(read("a.txt")).toContain("the answer I worked out");   // untouched
  });

  it("warns differently when the work is not ours to describe", () => {
    // Resolved by an agent or an editor. We cannot show what is about to be
    // deleted, and the wording has to admit that rather than imply we can.
    mergeSession(repo);
    writeFileSync(join(repo, "a.txt"), "an agent's careful merge\n");
    git("add", "a.txt");
    const r = reopenConflict(repo, "a.txt");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("outside this panel");
    expect(r.error).toContain("Open the file first");
  });

  it("does it when confirmed, and proves the conflict is really back", () => {
    mergeSession(repo);
    resolveWith(repo, "a.txt", "ours");
    expect(unmerged()).not.toContain("a.txt");
    const r = reopenConflict(repo, "a.txt", true);
    expect(r.ok).toBe(true);
    expect(unmerged()).toContain("a.txt");
    expect(read("a.txt")).toContain("<<<<<<<");
  });

  it("stops being ours once it is conflicted again", () => {
    mergeSession(repo);
    resolveWith(repo, "a.txt", "ours");
    reopenConflict(repo, "a.txt", true);
    expect(mergeSession(repo).mine).not.toContain("a.txt");
  });

  it("refuses a file that was never one of this merge's conflicts", () => {
    mergeSession(repo);
    const r = reopenConflict(repo, "clean-3.txt", true);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not one of this merge's conflicts");
  });

  it("refuses a file that is still conflicted, rather than doing nothing", () => {
    mergeSession(repo);
    const r = reopenConflict(repo, "b.txt", true);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("nothing to put back");
  });

  it("refuses when nothing is being merged", () => {
    mergeSession(repo);
    git("merge", "--abort");
    expect(reopenConflict(repo, "a.txt", true).ok).toBe(false);
  });
});

/**
 * The lockdown, where it actually lives.
 *
 * The screen not offering a button is not the same as the button not working:
 * the Diff view reaches some of these routes, another window reaches all of
 * them, and so does an agent driving the app. So the refusal is on the server
 * and it applies to whoever asks.
 */
describe("what a stopped checkout refuses", () => {
  const REFUSED = [
    "/git/stage", "/git/unstage", "/git/discard", "/git/apply-hunk",
    "/git/commit-staged", "/git/push", "/git/pull", "/git/sync-base",
    "/git/checkout", "/git/reset", "/git/stash-push", "/git/merge", "/git/undo-merge",
  ];

  it("refuses every move that would make this worse, and says what to do", () => {
    for (const p of REFUSED) {
      const r = stoppedRefusal(repo, p);
      expect(r, p).not.toBeNull();
      expect(r!.error, p).toContain("abandon");
    }
  });

  it("counts what is left, so the message is about this merge", () => {
    expect(stoppedRefusal(repo, "/git/push")!.error).toContain("3 files still conflicted");
  });

  it("still refuses once everything is resolved but nothing is committed", () => {
    // The merge is not over until it is committed, and pushing here publishes
    // the state from BEFORE it — which reads as the merge having vanished.
    for (const f of ["a.txt", "b.txt", "c.txt"]) resolveWith(repo, f, "ours");
    const r = stoppedRefusal(repo, "/git/push");
    expect(r).not.toBeNull();
    expect(r!.error).toContain("Finish it or abandon it");
  });

  it("lets through the moves that are the way out", () => {
    for (const p of ["/git/resolve", "/git/resolve-blocks", "/git/merge-abort", "/git/merge-continue", "/git/reopen-conflict", "/git/fetch"]) {
      expect(stoppedRefusal(repo, p), p).toBeNull();
    }
  });

  it("goes quiet the moment the merge is over", () => {
    git("merge", "--abort");
    expect(stoppedRefusal(repo, "/git/push")).toBeNull();
  });

  it("does not speak for a bisect, which is not this kind of stopped", () => {
    git("merge", "--abort");
    git("bisect", "start");
    expect(stoppedRefusal(repo, "/git/stage")).toBeNull();
    git("bisect", "reset");
  });

  it("says nothing about a path it has no opinion on", () => {
    expect(stoppedRefusal(repo, "/git/worktree-add")).toBeNull();
  });
});

describe("committing a merge that still has markers in it", () => {
  it("finds markers in a staged file", () => {
    // b.txt is resolved first on purpose: left conflicted it would of course
    // have markers too, and the assertion would prove nothing.
    resolveWith(repo, "b.txt", "ours");
    writeFileSync(join(repo, "a.txt"), "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feat\n");
    git("add", "a.txt");
    expect(markersLeft(repo, ["a.txt", "b.txt"])).toEqual(["a.txt"]);
  });

  it("does not trip over a file that merely mentions them in prose", () => {
    writeFileSync(join(repo, "a.txt"), "the marker is written <<<<<<< at the start of a line\n");
    expect(markersLeft(repo, ["a.txt"])).toEqual([]);
  });

  it("refuses to continue, and names the file", () => {
    // git is perfectly happy here: the file is staged, so --diff-filter=U is
    // empty and `commit` would put the markers on the branch.
    mergeSession(repo);
    for (const f of ["a.txt", "b.txt", "c.txt"]) {
      if (f === "a.txt") { git("add", f); continue; }   // markers and all
      resolveWith(repo, f, "ours");
    }
    expect(unmerged()).toEqual([]);
    const r = mergeContinue(repo);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("a.txt");
    expect(r.error).toContain("conflict markers");
  });

  it("only looks at this merge's own files", () => {
    // A sweep of the index would trip over every committed fixture whose
    // content is conflict markers — this repository has several — and block
    // every merge forever.
    writeFileSync(join(repo, "fixture.txt"), "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n");
    git("add", "fixture.txt");
    mergeSession(repo);
    for (const f of ["a.txt", "b.txt", "c.txt"]) resolveWith(repo, f, "ours");
    expect(mergeContinue(repo).ok).toBe(true);
  });

  it("can be overridden, for the file that is meant to contain them", () => {
    mergeSession(repo);
    git("add", "a.txt");
    for (const f of ["b.txt", "c.txt"]) resolveWith(repo, f, "ours");
    expect(mergeContinue(repo).ok).toBe(false);
    expect(mergeContinue(repo, true).ok).toBe(true);
  });

  it("still refuses while anything is genuinely unmerged", () => {
    const r = mergeContinue(repo);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("3 file(s) to resolve");
  });

  /**
   * The one that made the screen lie.
   *
   * `git rebase --continue` exits NON-ZERO when it commits the current step
   * and the next commit conflicts — which, for a branch of any size, is the
   * ordinary outcome. Reading that exit code as failure reported the most
   * normal thing in the world as an error: a toast saying it had gone wrong,
   * over a repository that had in fact just landed a commit and stopped on the
   * next one, with the screen still showing the previous step.
   */
  it("calls a rebase that stopped again a success, because it advanced", () => {
    // Three commits, each conflicting on its own file, so continuing lands one
    // and immediately stops on the next.
    const root = join(dir, `rb-${Math.random().toString(36).slice(2)}`);
    Bun.spawnSync(["mkdir", "-p", root]);
    const g = (...a: string[]) =>
      Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...a], { cwd: root });
    for (const f of ["x.txt", "y.txt", "z.txt"]) writeFileSync(join(root, f), "base\n");
    g("init", "-q", "-b", "main", "."); g("add", "-A"); g("commit", "-qm", "seed");
    g("checkout", "-q", "-b", "feat");
    for (const [n, f] of [["1", "x.txt"], ["2", "y.txt"], ["3", "z.txt"]] as const) {
      writeFileSync(join(root, f), `feat ${n}\n`); g("commit", "-qam", `feat ${n}`);
    }
    g("checkout", "-q", "main");
    for (const f of ["x.txt", "y.txt", "z.txt"]) writeFileSync(join(root, f), "main\n");
    g("commit", "-qam", "main side");
    g("checkout", "-q", "feat"); g("rebase", "main");

    expect(mergeInfo(root).step).toBe(1);
    resolveWith(root, "x.txt", "ours");
    const r = mergeContinue(root);
    expect(r.ok).toBe(true);                      // it advanced; git's exit code says otherwise
    expect(r.output).toContain("commit 2 of 3");  // and says where it landed
    expect(mergeInfo(root).step).toBe(2);
    expect(mergeInfo(root).state).toBe("rebasing");
  });

  it("still reports a genuine failure as one", () => {
    // Nothing resolved, so `continue` cannot advance and the repository is
    // exactly where it was.
    const r = mergeContinue(repo);
    expect(r.ok).toBe(false);
  });

  it("forgets the stop once the merge is committed", () => {
    mergeSession(repo);
    for (const f of ["a.txt", "b.txt", "c.txt"]) resolveWith(repo, f, "ours");
    expect(mergeContinue(repo).ok).toBe(true);
    expect(mergeSession(repo).op).toBe("");
  });
});
