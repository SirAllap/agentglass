// "Is this branch already in the trunk?" has to survive a rewritten history.
//
// The branches panel gates its delete on that answer: get it wrong and a branch
// whose PR landed weeks ago still refuses to delete, with a "not fully merged"
// error the user can only clear from a terminal. Ancestry alone always gets it
// wrong for the two shapes GitHub's merge button actually produces — squash
// replays the work as one brand new commit, rebase replays it as several, and
// in neither case does the branch tip become an ancestor of anything.
//
// So this pins the three merge shapes separately, plus the two cases where the
// answer must stay "no" — an open branch, and one sharing no history at all —
// plus the two ways a correct answer can still be lost afterwards: an expiring
// cache, and a branch that grows new commits once the verdict is already in.
import { describe, expect, test, beforeAll, afterAll, setSystemTime } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-merged-")));
const REPO = join(dir, "repo");

process.env.XDG_CONFIG_HOME = dir; // never inherit the developer's own scope
process.env.AGENTGLASS_DB = join(dir, "m.db");

function git(...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function commit(file: string, body: string, message: string) {
  writeFileSync(join(REPO, file), body);
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

let gw: typeof import("../src/gitwork.ts");

beforeAll(async () => {
  mkdirSync(REPO, { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  commit("README", "x\n", "root");

  // Squash-merged: several commits collapsed into one new commit on main. This
  // is the GitHub merge button, and the case the old ancestry test failed.
  git("checkout", "-q", "-b", "squashed");
  commit("feature.txt", "one\n", "wip one");
  commit("feature.txt", "one\ntwo\n", "wip two");
  git("checkout", "-q", "main");
  git("merge", "-q", "--squash", "squashed");
  git("commit", "-q", "-m", "feat: the whole branch, squashed (#1)");

  // Rebase-merged: the same commits replayed one by one onto main, each with a
  // new hash. This is the other GitHub merge button, and the one that defeats
  // the squash probe too — that probe looks for a single combined patch, and a
  // rebase never leaves one.
  //
  // Main has to move first. Replayed straight onto the commit they branched
  // from, the picks reproduce byte-identical commits, main fast-forwards, and
  // plain ancestry answers — which is not the case under test.
  git("checkout", "-q", "-b", "rebased");
  commit("rebase-a.txt", "a\n", "first half");
  commit("rebase-b.txt", "b\n", "second half");
  git("checkout", "-q", "main");
  commit("trunk.txt", "moved on\n", "unrelated trunk work");
  git("cherry-pick", "rebased~1", "rebased");

  // Merge-committed: ancestry still holds, and must keep being recognised.
  git("checkout", "-q", "-b", "merged", "main");
  commit("other.txt", "kept\n", "real merge work");
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", "merge branch 'merged'", "merged");

  // Open: real work that is genuinely not in main.
  git("checkout", "-q", "-b", "open", "main");
  commit("open.txt", "unfinished\n", "still going");

  // No shared history — this repo really does contain unrelated histories, and
  // "no merge base" must read as "don't know", never as "safe to delete".
  git("checkout", "-q", "--orphan", "stranger");
  git("rm", "-rq", "--cached", ".");
  commit("stranger.txt", "alien\n", "unrelated root");

  git("checkout", "-q", "main");
  gw = await import("../src/gitwork.ts");
});

describe("mergedIntoTrunk", () => {
  const of = async (name: string) => (await gw.branches(REPO)).branches.find((b) => b.name === name);

  /**
   * Squash detection is deliberately eventual.
   *
   * It costs ~5 git spawns per branch and used to run inline, which made the
   * Branches tab take five seconds on a 44-branch repo. It now sweeps after the
   * response goes out and fills the cached set in place, so the answer lands on
   * a later read — the UI polls, and until then the branch simply keeps its
   * delete confirmation, which is the safe direction to be wrong in.
   *
   * So the assertion is "becomes true", not "is true on the first call". It
   * still fails if the squash logic itself breaks: the flag would never flip.
   */
  const settles = async (name: string, want: boolean, ms = 5000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if ((await of(name))?.mergedIntoTrunk === want) return true;
      if (Date.now() > deadline) return (await of(name))?.mergedIntoTrunk;
      await Bun.sleep(25);
    }
  };

  test("names the trunk it compared against", async () => {
    expect((await gw.branches(REPO)).trunk).toBe("main");
  });

  test("a squash-merged branch counts as merged, once the sweep has run", async () => {
    expect(await settles("squashed", true)).toBe(true);
  });

  test("a rebase-merged branch counts as merged, once the sweep has run", async () => {
    expect(await settles("rebased", true)).toBe(true);
  });

  test("a normally merged branch still counts as merged", async () => {
    expect((await of("merged"))?.mergedIntoTrunk).toBe(true);
  });

  test("a branch with unlanded work does not", async () => {
    expect((await of("open"))?.mergedIntoTrunk).toBe(false);
  });

  test("an unrelated history does not", async () => {
    expect((await of("stranger"))?.mergedIntoTrunk).toBe(false);
  });

  /**
   * The two TTLs are an order of magnitude apart, and that gap used to eat the
   * answer: the ancestry entry expires after 30s and is rebuilt from `--merged`
   * alone, while the sweep that found the squashes declines to re-run for five
   * minutes because it swept recently. Every branch above flipped back to "not
   * merged — kept" for four and a half minutes out of every five.
   *
   * A minute is squarely inside that window. Nothing about the repo changed, so
   * nothing about the answer may either.
   */
  test("verdicts survive the ancestry cache expiring under them", async () => {
    setSystemTime(new Date(Date.now() + 60_000));
    expect((await of("squashed"))?.mergedIntoTrunk).toBe(true);
    expect((await of("rebased"))?.mergedIntoTrunk).toBe(true);
  });

  /**
   * ...but only for the commit they were proved against. A remembered verdict
   * that outlived its branch would be worse than the bug it fixes: the delete
   * behind this flag is `-D`, so it would throw away work nothing has checked.
   */
  test("a remembered verdict is dropped when the branch moves", async () => {
    git("checkout", "-q", "rebased");
    commit("rebase-c.txt", "c\n", "new work, after the merge");
    git("checkout", "-q", "main");
    setSystemTime(new Date(Date.now() + 60_000)); // still inside the sweep's TTL
    expect((await of("rebased"))?.mergedIntoTrunk).toBe(false);
  });
});

afterAll(() => setSystemTime());
