/*
 * `GET /flight-plan/plans` asks, for every project, which ref builders are cut
 * from and which launched builders have landed. It used to ask git
 * `merge-base --is-ancestor` for the trunk and for every launched branch on
 * every call: on a repo far ahead of its remote that walk read ~146k disk
 * blocks per request. Now one `for-each-ref` per project per request, and an
 * ancestry walk only when a branch tip moved. Counted with the git activity
 * log, which every spawn lands in.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REAL_XDG = process.env.XDG_CONFIG_HOME;
const HOME = mkdtempSync(join(tmpdir(), "agx-fp-reads-"));
process.env.XDG_CONFIG_HOME = HOME;
const Flight = await import("../src/flightPlan.ts");
const Plans = await import("../src/flightPlanStore.ts");
const { db } = await import("../src/db.ts");
const GitLog = await import("../src/gitlog.ts");

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  if (REAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = REAL_XDG;
});

const env = { ...process.env, GIT_AUTHOR_NAME: "Ada Orbit", GIT_AUTHOR_EMAIL: "ada@orbit.test", GIT_COMMITTER_NAME: "Ada Orbit", GIT_COMMITTER_EMAIL: "ada@orbit.test", GIT_CONFIG_GLOBAL: "/dev/null" };
const sh = (cwd: string, ...a: string[]) => { const r = Bun.spawnSync(["git", ...a], { cwd, env }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); return r.stdout.toString().trim(); };

const origin = join(HOME, "origin.git");
const repo = join(HOME, "orbit");
sh(HOME, "init", "-q", "--bare", "-b", "main", origin);
sh(HOME, "clone", "-q", origin, repo);
sh(repo, "commit", "-q", "--allow-empty", "-m", "one");
sh(repo, "push", "-q", "origin", "main");
sh(repo, "commit", "-q", "--allow-empty", "-m", "two, never pushed"); // local trunk ahead of origin

/** Three launched builders, each with one commit of its own, none merged. */
const from = sh(repo, "rev-parse", "HEAD");
const branches = ["flight-plan/a", "flight-plan/b", "flight-plan/c"];
for (const [i, b] of branches.entries()) {
  sh(repo, "checkout", "-q", "-b", b, from);
  writeFileSync(join(repo, `f${i}`), String(i)); sh(repo, "add", `f${i}`); sh(repo, "commit", "-q", "-m", b);
  const p = Plans.createPlan({ root: repo, title: b, request: "r", visual: false });
  db.query(`UPDATE flight_plan SET state = 'go' WHERE id = ?`).run(p.id);
  Plans.markLaunched(p.id, { branch: b, from });
}
sh(repo, "checkout", "-q", "main");

/** What the list route asks git, per call: the base, then who is in the air. */
async function listOnce(): Promise<{ base: string; flying: number; spawns: string[] }> {
  const since = GitLog.recent(0, 1000).at(-1)?.id ?? 0;
  const refs = await Flight.refShas(repo);
  const base = await Flight.localBase(repo, "origin/main", refs);
  const flying = (await Flight.flying(repo, base, refs)).length;
  const spawns = GitLog.recent(since, 1000).filter((e) => e.cwd === repo).map((e) => e.args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? "");
  return { base, flying, spawns };
}

describe("the plan list's git reads", () => {
  test("first call walks each pair of tips once; the next ones read only refs", async () => {
    const first = await listOnce();
    expect(first.base).toBe("main");
    expect(first.flying).toBe(3);
    // Old: rev-parse + merge-base for the base, then rev-parse + merge-base per builder = 8, 4 walks.
    expect(first.spawns.filter((s) => s === "merge-base").length).toBeLessThanOrEqual(4);
    for (let n = 0; n < 3; n++) {
      const again = await listOnce();
      expect(again.flying).toBe(3);
      expect(again.spawns).toEqual(["for-each-ref"]);
    }
  });

  test("a merge moves the trunk: the answer follows it, with walks only for the moved tip", async () => {
    sh(repo, "merge", "-q", "--no-ff", "-m", "land a", "flight-plan/a");
    const after = await listOnce();
    expect(after.base).toBe("main");
    expect(after.flying).toBe(2);
    expect(after.spawns.filter((s) => s === "merge-base").length).toBeLessThanOrEqual(4);
    expect((await listOnce()).spawns).toEqual(["for-each-ref"]);
  });

  test("without a snapshot each answer reads the refs itself and stays right", async () => {
    sh(repo, "branch", "-q", "-D", "flight-plan/b");
    expect((await Flight.flying(repo, "main")).length).toBe(1);
    expect(await Flight.localBase(repo, "origin/main")).toBe("main");
  });
});
