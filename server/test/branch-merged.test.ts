// "Is this branch already in the trunk?" has to survive a squash merge.
//
// The branches panel gates its delete on that answer: get it wrong and a branch
// whose PR landed weeks ago still refuses to delete, with a "not fully merged"
// error the user can only clear from a terminal. Ancestry alone always gets it
// wrong here, because a squash merge replays the work as a brand new commit and
// the branch tip never becomes an ancestor of anything.
//
// So this pins the two merge shapes separately, plus the two cases where the
// answer must stay "no" — an open branch, and one sharing no history at all.
import { describe, expect, test, beforeAll } from "bun:test";
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
  const of = (name: string) => gw.branches(REPO).branches.find((b) => b.name === name);

  test("names the trunk it compared against", () => {
    expect(gw.branches(REPO).trunk).toBe("main");
  });

  test("a squash-merged branch counts as merged", () => {
    expect(of("squashed")?.mergedIntoTrunk).toBe(true);
  });

  test("a normally merged branch still counts as merged", () => {
    expect(of("merged")?.mergedIntoTrunk).toBe(true);
  });

  test("a branch with unlanded work does not", () => {
    expect(of("open")?.mergedIntoTrunk).toBe(false);
  });

  test("an unrelated history does not", () => {
    expect(of("stranger")?.mergedIntoTrunk).toBe(false);
  });
});
