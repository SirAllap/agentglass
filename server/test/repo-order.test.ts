// The order every repo picker shows.
//
// Four dropdowns read the same list — Source control's, the terminal's, the
// docked console's and the project picker — so the ordering is decided once,
// here, on the server. The rule: the project itself first, then its checkouts
// most recently worked in first. On a repo worked one-worktree-per-ticket that
// is the difference between "the branch I am on today" being at the top and
// being seventeen rows down, alphabetically, next to a ticket from March.
//
// Half of these tests exist because the cheap signals lie. `touchedAt` reads a
// commit date and one file stamp, and every cheaper thing tried first turned
// out to be rewritten by something that is not the user working — see
// touchedAt() for the list, and the last two tests here for the two that were
// written, measured against a real repo, and backed out.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, realpathSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string, repo: string, gw: typeof import("../src/gitwork.ts"), wtm: typeof import("../src/worktree.ts");
const wt = (name: string) => join(dir, `orbit-${name}`);
const TICKETS = ["WEB-1", "WEB-2", "WEB-3"];

const run = (cwd: string, ...args: string[]) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

/**
 * Commit in `cwd`, dated, and age its HEAD to match.
 *
 * Both halves matter, because `touchedAt` is the later of the two. `git
 * worktree add` stamps HEAD with the moment of creation, so three checkouts
 * made in the same second all read "now" however old their commits are — which
 * is right in life (a worktree you just made IS what you are working on) and
 * useless in a fixture trying to order by commit date. Ageing HEAD alongside
 * the commit is what a checkout made a day ago actually looks like.
 */
function commitAt(cwd: string, file: string, secondsAgo: number) {
  writeFileSync(join(cwd, file), `${file}\n`);
  run(cwd, "add", "-A");
  const at = new Date(Date.now() - secondsAgo * 1000);
  const when = at.toISOString();
  spawnSync("git", ["-C", cwd, "commit", "-qm", file], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  });
  const gd = wtm.gitDir(cwd);
  if (gd) { try { utimesSync(join(gd, "HEAD"), at, at); } catch { /* mid-write */ } }
}

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-order-")));
  repo = join(dir, "orbit");
  // Scope the cockpit at the fixture, so discoverRepos takes its "one project
  // and its worktrees" path — the shape these dropdowns actually run in.
  process.env.AGENTGLASS_ROOT = repo;

  wtm = await import("../src/worktree.ts"); // commitAt below needs it
  spawnSync("git", ["init", "-q", "-b", "main", repo], { encoding: "utf8" });
  run(repo, "config", "user.email", "t@example.com");
  run(repo, "config", "user.name", "t");
  // The project itself is the STALEST of the four on purpose: position 0 is
  // about what it is, not about when it was last touched.
  commitAt(repo, "a.txt", 259_200); // three days ago
  for (const t of TICKETS) run(repo, "worktree", "add", "-q", "-b", t, wt(t));

  // Work lands on the three tickets in a deliberately non-alphabetical order:
  // WEB-2 a minute ago, WEB-3 an hour, WEB-1 a day. Otherwise the assertion
  // would pass on alphabetical order too and prove nothing.
  commitAt(wt("WEB-1"), "one.txt", 86_400);
  commitAt(wt("WEB-2"), "two.txt", 60);
  commitAt(wt("WEB-3"), "three.txt", 3_600);

  gw = await import("../src/gitwork.ts");
});

afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } });

/** The picker's list, cache bypassed — it is held for 5s and every assertion
 *  here changes something. */
const order = async () => {
  gw.invalidateRepos();
  return (await gw.discoverRepos([], [])).map((r) => r.name);
};

describe("repo picker order", () => {
  it("puts the project first and the rest newest-worked-in first", async () => {
    expect(await order()).toEqual(["orbit", "orbit-WEB-2", "orbit-WEB-3", "orbit-WEB-1"]);
  });

  it("keeps the project at the top even when it is the stalest thing there", async () => {
    // The whole point of "position 0": it is the thing the others are worktrees
    // OF, and hunting for it in a list of seventeen is not a thing anyone
    // should have to do.
    gw.invalidateRepos();
    const repos = await gw.discoverRepos([], []);
    expect(repos[0].name).toBe("orbit");
    expect(repos[0].worktreeOf).toBeUndefined();
    // …and it really is the oldest of the four, so this is not passing by luck.
    expect(repos[0].touchedAt).toBeLessThan(Math.min(...repos.slice(1).map((r) => r.touchedAt)));
  });

  it("reorders when work lands in a checkout", async () => {
    commitAt(wt("WEB-1"), "more.txt", 0);
    expect((await order())[1]).toBe("orbit-WEB-1");
  });

  it("gives every checkout a timestamp", async () => {
    // 0 means "nothing could be read", and those sort last. A fixture where
    // they were all 0 would pass the ordering tests by accident.
    gw.invalidateRepos();
    const repos = await gw.discoverRepos([], []);
    expect(repos.length).toBe(4);
    for (const r of repos) expect(r.touchedAt).toBeGreaterThan(0);
  });

  it("survives the dirty-count sweep, which rewrites the index", async () => {
    // The first version of this sorted on the index mtime. `git status` — which
    // discoverRepos runs against every checkout to count changed files —
    // refreshes the index and writes it back, so the timestamp became "when the
    // picker last polled": identical everywhere, and the order came out as
    // whichever parallel status happened to finish last.
    const before = await order();
    await order(); // a second full sweep: every status runs again
    expect(await order()).toEqual(before);
  });

  it("survives git's housekeeping rewriting the reflogs", async () => {
    // The second version sorted on `logs/HEAD`. Git's own `gc --auto` — which a
    // fetch triggers — expires every worktree's reflog in one pass, stamping
    // them all with the same millisecond. On the repo this was found on, that
    // was sixteen of eighteen checkouts. Simulated directly here: the point is
    // the timestamps, not what moved them.
    const before = await order();
    const now = new Date();
    for (const t of TICKETS) {
      const gd = wtm.gitDir(wt(t));
      try { utimesSync(join(gd!, "logs", "HEAD"), now, now); } catch { /* no reflog is fine */ }
    }
    expect(await order()).toEqual(before);
  });
});
