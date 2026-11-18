/*
 * The server-enforced local merge: the flow's gates at the branch tip, the server's own review of the
 * diff as the sign-off, the person's override, and a merge that only ever touches the local base.
 * Real git repos (one with a bare remote whose hooks write markers), the reviewer is preflightStub.ts.
 */
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Flow } from "../../shared/flow.ts";

const HOME = mkdtempSync(join(tmpdir(), "agx-mergelocal-"));
const restore = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, AGENTGLASS_DB: process.env.AGENTGLASS_DB, AGENTGLASS_DOCTRINE: process.env.AGENTGLASS_DOCTRINE,
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL };
process.env.XDG_CONFIG_HOME = join(HOME, "config");
process.env.AGENTGLASS_DOCTRINE = join(HOME, "doctrine");
process.env.AGENTGLASS_DB = join(HOME, "ml.db");
mkdirSync(join(HOME, "config", "agentglass"), { recursive: true });
Object.assign(process.env, { GIT_AUTHOR_NAME: "Ada Orbit", GIT_AUTHOR_EMAIL: "ada@orbit.test", GIT_COMMITTER_NAME: "Ada Orbit", GIT_COMMITTER_EMAIL: "ada@orbit.test" });

const STUB = new URL("./preflightStub.ts", import.meta.url).pathname;
const { __setPreflightDeps } = await import("../src/flightPlan.ts");
const Plans = await import("../src/flightPlanStore.ts");
const Store = await import("../src/preflightStore.ts");
const Local = await import("../src/localMerge.ts");
const { handleMergeLocal } = await import("../src/mergeLocalRoute.ts");
const { allowed, seatAllows } = await import("../src/auth.ts");
const { verdictOf } = await import("../src/signoff.ts");
const { readFlow, writeFlow } = await import("../src/flow.ts");
const { db } = await import("../src/db.ts");

// The Preflight budget is read from the process-wide DB, where files that ran earlier leave spend today. Own the caps, so the before-merge review is never refused for budget; put them back in afterAll.
const CAPS = ["flightPlan.budget.dailyUsd", "flightPlan.budget.weeklyUsd"] as const;
const capRow = (k: string) => db.query<{ value: string }, [string, string]>(`SELECT value FROM flight_plan_setting WHERE root = ? AND key = ?`).get(Store.APP, k);
const capsBefore = CAPS.map((k) => ({ k, row: capRow(k) }));
for (const k of CAPS) Store.putSetting(Store.APP, k, 1_000_000);
const restoreCaps = () => { for (const { k, row } of capsBefore) { if (row) db.query(`UPDATE flight_plan_setting SET value = ? WHERE root = ? AND key = ?`).run(row.value, Store.APP, k); else db.query(`DELETE FROM flight_plan_setting WHERE root = ? AND key = ?`).run(Store.APP, k); } };

const env = { ...process.env, GIT_AUTHOR_NAME: "Ada Orbit", GIT_AUTHOR_EMAIL: "ada@orbit.test", GIT_COMMITTER_NAME: "Ada Orbit", GIT_COMMITTER_EMAIL: "ada@orbit.test", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...a: string[]) => { const r = Bun.spawnSync(["git", ...a], { cwd, env }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); return r.stdout.toString().trim(); };
const BLOCKER = "### F1 - Blocker - Drops the table\nQuote: q\nEvidence: the diff deletes it";
const reply = (text: string) => __setPreflightDeps({ bin: [process.execPath, STUB], env: { STUB_REPLY: text } });
const person = { kind: "person" as const, name: "" };
const seat = { kind: "seat" as const, powers: "assign", name: "orbit-seat" };
let n = 0;

/** A repo with a bare remote (hooks that would leave a marker), a launched plan, and one commit on its branch. */
function fixture() {
  const dir = join(HOME, `r${++n}`);
  const remote = join(dir, "remote.git"), repo = join(dir, "orbit");
  mkdirSync(dir);
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  for (const h of ["pre-push", "pre-merge-commit", "post-merge"]) { writeFileSync(join(remote, "hooks", h), `#!/bin/sh\ntouch ${join(dir, "marker-" + h)}\n`); chmodSync(join(remote, "hooks", h), 0o755); }
  git(dir, "clone", "-q", remote, repo);
  git(repo, "checkout", "-q", "-b", "main");
  for (const h of ["pre-push", "pre-merge-commit", "post-merge"]) { writeFileSync(join(repo, ".git", "hooks", h), `#!/bin/sh\ntouch ${join(dir, "marker-" + h)}\n`); chmodSync(join(repo, ".git", "hooks", h), 0o755); }
  writeFileSync(join(repo, "a.txt"), "one\n"); git(repo, "add", "a.txt"); git(repo, "commit", "-q", "-m", "one"); git(repo, "push", "-q", "origin", "main");
  for (const h of ["pre-push", "pre-merge-commit", "post-merge"]) rmSync(join(dir, `marker-${h}`), { force: true }); // the setup push fired pre-push
  const from = git(repo, "rev-parse", "HEAD");
  git(repo, "branch", "flight-plan/thing");
  git(repo, "checkout", "-q", "flight-plan/thing");
  writeFileSync(join(repo, "b.txt"), "two\n"); git(repo, "add", "b.txt"); git(repo, "commit", "-q", "-m", "add b");
  git(repo, "checkout", "-q", "main");
  Store.putSetting(repo, "flightPlan.pilot", "autopilot");
  const p = Plans.createPlan({ root: repo, title: "Add thing", request: "r", visual: false });
  Plans.patchPlan(p.id, { planMd: "# Plan\nAdd b.txt" });
  Plans.decide(p.id, "go", "tester");
  Plans.markLaunched(p.id, { branch: "flight-plan/thing", from });
  return { dir, remote, repo, from, id: p.id, plan: () => Plans.getPlan(p.id)!, tip: () => git(repo, "rev-parse", "flight-plan/thing"), main: () => git(repo, "rev-parse", "main") };
}
type F = ReturnType<typeof fixture>;
const call = (f: F, c: { kind: "person" | "seat" | "worker" | "other"; powers?: string; name: string }, body: { override?: unknown } = {}) => handleMergeLocal(f.plan(), c, body, "main");
/** Waits for the sign-off run the server started for this plan to end: up to 30 s, returning the moment it ends. A 5 s cap ran out on a slow CI runner, the run was still going, and every test after it read 409 merge-busy. */
const runEnds = async (f: F) => {
  for (let i = 0; i < 1200; i++) { const r = Store.listRuns({ root: f.repo }).find((x) => x.moment === "before-merge"); if (r && r.state !== "running") return r; await Bun.sleep(25); }
  throw new Error("the review never ended");
};
const verdicts = (f: F) => db.query<{ verdict: string }, [string]>(`SELECT verdict FROM flight_plan_signoff WHERE plan_id = ? ORDER BY id`).all(f.id).map((r) => r.verdict);
const merges = (f: F) => Plans.mergesOf(f.id);
const saveFlow = (root: string) => {
  const flow = readFlow(root).flow as Flow;
  flow.roster = flow.roster.map((r) => (r.id === "qa-only" ? { ...r, required: true } : r));
  if (!flow.path.includes("qa-only")) { flow.path = [...flow.path.slice(0, -1), "qa-only", ...flow.path.slice(-1)]; /* the Gate stays last */ flow.blocks = flow.path.map((id, i) => ({ id, x: i * 240, y: 0 })); flow.edges = [...flow.edges, { from: "qa-only", to: "verifier", on: "pass" as const }, { from: "qa-only", to: "builder", on: "fail" as const, maxRounds: 2 }].filter((e, i, a) => a.findIndex((x) => x.from === e.from && x.to === e.to && x.on === e.on) === i); }
  const w = writeFlow(root, flow);
  if (!w.ok) throw new Error(JSON.stringify(w));
};

afterEach(() => __setPreflightDeps(null));
afterAll(() => {
  restoreCaps();
  rmSync(HOME, { recursive: true, force: true });
  for (const [k, v] of Object.entries(restore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

setDefaultTimeout(40_000); // runEnds may wait up to 30 s on a slow runner

describe("the sign-off", () => {
  test("no verdict: 202 and one run; a clear verdict then merges once with a merge commit, and nothing leaves the machine", async () => {
    const f = fixture(); reply("No findings");
    const before = f.main();
    const a = await call(f, person);
    expect(a.status).toBe(202); expect(a.body.state).toBe("signoff-running");
    expect((await call(f, person)).status).toBe(202); // a second call is the same run
    await runEnds(f);
    expect(Store.listRuns({ root: f.repo }).filter((r) => r.moment === "before-merge")).toHaveLength(1);
    const m = await call(f, person);
    expect(m.status).toBe(200); expect(m.body.state).toBe("merged"); expect(m.body.pushed).toBe(false);
    expect(git(f.repo, "log", "-1", "--format=%s", "main")).toBe(`Merge flight-plan/thing (flight plan ${f.id})`);
    expect(git(f.repo, "rev-parse", "main^1")).toBe(before);
    expect(git(f.repo, "rev-parse", "main^2")).toBe(f.tip());
    expect(git(f.remote, "rev-parse", "main")).toBe(f.from);
    for (const h of ["pre-push", "pre-merge-commit", "post-merge"]) expect(existsSync(join(f.dir, `marker-${h}`))).toBe(false);
    expect(merges(f)).toHaveLength(1); expect(merges(f)[0]!.merged).toBe(1);
    expect((await call(f, person)).body.state).toBe("already-landed");
  });
  test("a blocker refuses with the reviewer's sentence for a seat and for the person, and the override does not cover it", async () => {
    const f = fixture(); reply(BLOCKER);
    await call(f, seat); await runEnds(f);
    const s = await call(f, seat);
    expect(s.status).toBe(409); expect(s.body.state).toBe("signoff-blocker"); expect(String(s.body.error)).toContain("Drops the table");
    const p = await call(f, person, { override: { reason: "I looked, ship it" } });
    expect(p.status).toBe(409); expect(p.body.state).toBe("signoff-blocker");
    expect(f.main()).toBe(f.from);
    expect(merges(f).map((r) => r.merged)).toEqual([3]);
    expect(Plans.mergeSummary(f.id).overrides).toEqual({ attempts: 0, merged: 0 }); // nothing was overridden: the row has no gate in it
  });
  test("a commit after the verdict makes it not count: a new run starts", async () => {
    const f = fixture(); reply("No findings");
    await call(f, person); await runEnds(f);
    git(f.repo, "checkout", "-q", "flight-plan/thing"); writeFileSync(join(f.repo, "c.txt"), "3\n"); git(f.repo, "add", "c.txt"); git(f.repo, "commit", "-q", "-m", "more"); git(f.repo, "checkout", "-q", "main");
    const a = await call(f, person);
    expect(a.status).toBe(202); expect(f.main()).toBe(f.from);
    await Bun.sleep(300);
    expect(Store.listRuns({ root: f.repo }).filter((r) => r.moment === "before-merge").length).toBe(2);
  });
  test("a verdict is for one base commit: when base moves, the merge says base-moved, a new review starts, and nothing merges", async () => {
    const f = fixture(); reply("No findings");
    await call(f, person); await runEnds(f);
    expect((await call(f, person)).body.state).not.toBe("signoff-running"); // clear: merges; undo to test the move
    git(f.repo, "reset", "-q", "--hard", f.from); // back to the reviewed base (test setup, not the server)
    db.query(`UPDATE flight_plan SET landed_at = NULL WHERE id = ?`).run(f.id); db.query(`DELETE FROM flight_plan_merge WHERE plan_id = ?`).run(f.id);
    git(f.repo, "commit", "-q", "--allow-empty", "-m", "base moves on");
    const moved = f.main();
    const r = await call(f, person);
    expect(r.status).toBe(409); expect(r.body.state).toBe("base-moved");
    expect(f.main()).toBe(moved);
    await Bun.sleep(300);
    expect(Store.listRuns({ root: f.repo }).filter((x) => x.moment === "before-merge").length).toBe(2);
  });
  test("a review that cannot run waits with its reason; the person signs off, a seat never does, and the person's row wins after a retry", async () => {
    const f = fixture();
    __setPreflightDeps({ bin: [process.execPath, "-e", "process.exit(3)"], env: {} });
    expect((await call(f, person)).status).toBe(202); await runEnds(f);
    const w = await call(f, seat);
    expect(w.status).toBe(409); expect(w.body.state).toBe("signoff-waiting");
    expect((await call(f, seat, { override: { reason: "go on", signoff: true } })).status).toBe(403);
    expect((await call(f, person, { override: { reason: "okay then", signoff: true } })).status).toBe(200);
    expect(verdicts(f)).toContain("person");
    expect(merges(f)[0]).toMatchObject({ merged: 1, reason: "okay then" });
    expect(Plans.mergeSummary(f.id).overrides.merged).toBe(0); // signed off, no gate overridden
  });
  test("a person's sign-off while the review runs writes nothing", async () => {
    const f = fixture(); reply("No findings");
    expect((await call(f, person)).status).toBe(202);
    const r = await call(f, person, { override: { reason: "now please", signoff: true } });
    expect(r.status).toBe(202); expect(verdicts(f)).toEqual([]);
  });
  test("a seat's own reviewer passes satisfy the flow gate and never the sign-off", async () => {
    const f = fixture(); reply("No findings");
    expect((await call(f, seat)).status).toBe(202);
    expect(f.main()).toBe(f.from);
  });
});

describe("the flow's gates", () => {
  test("a missing required step is refused at the tip: 403 for a seat, 409 for the person, and a pass on older code does not count", async () => {
    const f = fixture(); saveFlow(f.repo);
    const s = await call(f, seat); expect(s.status).toBe(403); expect(s.body.state).toBe("required-step");
    const p = await call(f, person); expect(p.status).toBe(409); expect(p.body.state).toBe("required-step");
    Plans.recordStep(f.id, "qa-only", "pass", "abc"); // no tip: the old way of recording
    expect((await call(f, person)).status).toBe(409);
    expect(String((await call(f, person)).body.error)).toContain("re-run on the current commit");
    expect(Plans.passedRoles(f.id).has("qa-only")).toBe(true); // integrate-check's reading still says clean
    Plans.recordStep(f.id, "qa-only", "pass", "abc", "0".repeat(40), "qa-1");
    expect((await call(f, person)).status).toBe(409);
    Plans.recordStep(f.id, "qa-only", "pass", "abc", f.tip(), "qa-1");
    reply("No findings");
    expect((await call(f, person)).status).toBe(202); // the gate is open; the review starts
  });
  test("the person's override lifts the gate with a logged reason, and an empty one is 400", async () => {
    const f = fixture(); saveFlow(f.repo); reply("No findings");
    expect((await call(f, person, { override: { reason: " " } })).status).toBe(400);
    expect((await call(f, seat, { override: { reason: "please" } })).status).toBe(403);
    expect((await call(f, { kind: "worker", name: "w" })).status).toBe(403);
    expect((await call(f, { kind: "seat", powers: "speak", name: "s" })).status).toBe(403);
    expect((await call(f, { kind: "other", name: "x" })).status).toBe(403);
    const r = await call(f, person, { override: { reason: "QA is down today" } });
    expect(r.status).toBe(202);
    const row = merges(f)[0]!;
    expect(row.reason).toBe("QA is down today"); expect(row.overridden).toContain("required-step"); expect(row.merged).toBe(3);
    expect(Plans.mergeSummary(f.id).overrides.attempts).toBe(1);
  });
  test("polling writes no row", async () => {
    // The review is held for 4 s so three polls always land while it runs; a fast reply made the third poll
    // the one that found a finished pass and merged, on a runner slower than this machine.
    const f = fixture(); __setPreflightDeps({ bin: [process.execPath, STUB], env: { STUB_REPLY: "No findings", STUB_SLEEP_MS: "4000" } });
    for (let i = 0; i < 3; i++) await call(f, seat);
    expect(merges(f)).toHaveLength(0);
  });
});

describe("two requests for one plan", () => {
  test("while one merge runs, a second for the same plan gets 409 merge-busy and only one merge is recorded", async () => {
    const f = fixture(); reply("No findings");
    await call(f, person); await runEnds(f);
    const [a, b] = await Promise.all([call(f, person), call(f, person)]);
    const answers = [a, b].sort((x, y) => x.status - y.status);
    expect(answers[0].status).toBe(200); expect(answers[0].body.state).toBe("merged");
    expect(answers[1].status).toBe(409); expect(answers[1].body.code).toBe("merge-busy");
    expect(String(answers[1].body.error)).toContain("already running");
    expect(merges(f)).toHaveLength(1);
  });
});

describe("the merge itself", () => {
  const cleared = async (f: F) => { reply("No findings"); await call(f, person); await runEnds(f); };
  test("a conflict is aborted, base is where it was, and the row says tried and failed", async () => {
    const f = fixture();
    git(f.repo, "checkout", "-q", "flight-plan/thing"); writeFileSync(join(f.repo, "a.txt"), "branch\n"); git(f.repo, "commit", "-qam", "branch a"); git(f.repo, "checkout", "-q", "main");
    writeFileSync(join(f.repo, "a.txt"), "main\n"); git(f.repo, "commit", "-qam", "main a");
    const before = f.main();
    await cleared(f);
    const r = await call(f, person);
    expect(r.status).toBe(409); expect(r.body.state).toBe("conflict"); expect(r.body.files).toEqual(["a.txt"]);
    expect(f.main()).toBe(before); expect(git(f.repo, "status", "--porcelain")).toBe("");
    expect(merges(f).map((x) => x.merged)).toEqual([3]);
  });
  test("base not checked out, a dirty tree and a signing repo are refused with no change", async () => {
    const f = fixture(); await cleared(f);
    git(f.repo, "checkout", "-q", "flight-plan/thing");
    expect((await call(f, person)).body.state).toBe("base-not-checked-out");
    git(f.repo, "checkout", "-q", "main");
    writeFileSync(join(f.repo, "a.txt"), "dirty\n");
    expect((await call(f, person)).body.state).toBe("dirty-tree");
    git(f.repo, "checkout", "--", "a.txt");
    git(f.repo, "config", "commit.gpgsign", "true");
    expect((await call(f, person)).body.state).toBe("signing-not-supported");
    expect(f.main()).toBe(f.from); expect(merges(f)).toHaveLength(0);
  });
  test("a branch merged by hand is answered already-merged and a stuck intent row is settled", async () => {
    const f = fixture(); await cleared(f);
    const row = Plans.recordMerge({ planId: f.id, who: "you", base: "main", baseBefore: f.from, branch: "flight-plan/thing", tip: f.tip(), overridden: [], reason: null, passes: [], signoffId: null });
    git(f.repo, "merge", "-q", "--no-ff", "-m", "by hand", "flight-plan/thing");
    const r = await call(f, seat);
    expect(r.body.state).toBe("already-merged");
    expect(merges(f).find((x) => x.id === row)!.merged).toBe(2);
    expect(Plans.openMerge(f.id)).toBeNull();
  });
  test("a crash after the merge: the intent row is found by its subject and becomes merged", async () => {
    const f = fixture(); await cleared(f);
    const row = Plans.recordMerge({ planId: f.id, who: "you", base: "main", baseBefore: f.from, branch: "flight-plan/thing", tip: f.tip(), overridden: [], reason: null, passes: [], signoffId: null });
    git(f.repo, "merge", "-q", "--no-ff", "-m", `Merge flight-plan/thing (flight plan ${f.id})`, "flight-plan/thing");
    const r = await call(f, seat);
    expect(r.body).toMatchObject({ state: "already-merged", mergedBy: "this-verb" });
    expect(merges(f).find((x) => x.id === row)).toMatchObject({ merged: 1, sha: f.main() });
  });
  test("the branch rules: gone, never moved, no branch", async () => {
    const f = fixture();
    git(f.repo, "branch", "-q", "-D", "flight-plan/thing");
    expect((await call(f, person)).body.state).toBe("branch-gone");
    const g = fixture(); git(g.repo, "branch", "-f", "flight-plan/thing", g.from);
    expect((await call(g, person)).body.state).toBe("nothing-to-merge");
  });
  test("a branch reset to an older commit already in base is nothing-to-merge and is not marked landed", async () => {
    const f = fixture();
    git(f.repo, "commit", "-q", "--allow-empty", "-m", "more on main");
    const p = Plans.createPlan({ root: f.repo, title: "Reset", request: "r", visual: false }); Plans.patchPlan(p.id, { planMd: "# P" }); Plans.decide(p.id, "go", "t");
    Plans.markLaunched(p.id, { branch: "reset-me", from: f.main() }); // cut from main's newest commit...
    git(f.repo, "branch", "reset-me", f.from); // ...then reset to an older one that base already holds
    const r = await handleMergeLocal(Plans.getPlan(p.id)!, person, {}, "main");
    expect(r.body.state).toBe("nothing-to-merge");
    expect(Plans.getPlan(p.id)!.landedAt).toBeNull();
  });
  test("base from origin/ is refused as not local", async () => {
    const f = fixture();
    expect((await handleMergeLocal(f.plan(), person, {}, "origin/main")).body.state).toBe("base-not-local");
  });
  test("a second merge in the same repo at the same moment is merge-busy, and a moved branch is tip-moved", async () => {
    const f = fixture();
    const r = Local.mergeLocal(f.repo, { base: "main", branch: "flight-plan/thing", sha: "1".repeat(40), planId: f.id, onBeforeGit: () => { throw new Error("must not run"); } });
    expect(r).toMatchObject({ ok: false, reason: "tip-moved" });
    let inner: unknown;
    Local.mergeLocal(f.repo, { base: "main", branch: "flight-plan/thing", sha: f.tip(), planId: f.id, onBeforeGit: () => { inner = Local.mergeLocal(f.repo, { base: "main", branch: "flight-plan/thing", sha: f.tip(), planId: f.id, onBeforeGit: () => {} }); } });
    expect(inner).toMatchObject({ ok: false, reason: "merge-busy" });
  });
});

describe("no push", () => {
  test("every vector starts with an allowed subcommand and never names push, fetch, remote, pull or send-pack", async () => {
    for (const v of Local.vectors("main", "flight-plan/thing", "a".repeat(40), "fp_0123456789abcdef")) {
      expect(["rev-parse", "symbolic-ref", "status", "merge", "merge-base", "diff", "log", "config"]).toContain(v[0]!);
      expect(["push", "fetch", "remote", "pull", "send-pack"]).not.toContain(v[0]!);
      expect(() => Local.assertAllowed(v)).not.toThrow();
    }
    for (const bad of ["push", "fetch", "remote", "pull", "send-pack", "stash", "reset", "checkout"]) expect(() => Local.assertAllowed([bad])).toThrow();
    expect(() => Local.assertAllowed(["config", "user.name", "x"])).toThrow();
  });
  test("a real merge runs only closed-list git calls", async () => {
    const f = fixture(); reply("No findings"); await call(f, person); await runEnds(f);
    const seen: string[][] = []; Local.__spyGit((a) => seen.push(a));
    try { expect((await call(f, person)).body.state).toBe("merged"); } finally { Local.__spyGit(null); }
    expect(seen.length).toBeGreaterThan(5);
    for (const a of seen) expect(["push", "fetch", "remote", "pull", "send-pack"]).not.toContain(a[0]!);
  });
  test("a repo with no remote merges too", async () => {
    const f = fixture(); git(f.repo, "remote", "remove", "origin"); reply("No findings"); await call(f, person); await runEnds(f);
    expect((await call(f, person)).body.state).toBe("merged");
  });
});

describe("the wall", () => {
  const path = "/flight-plan/plans/fp_0123456789abcdef/merge-local";
  test("a worker credential is refused; the person's machine token and an assign seat pass; a speak seat does not", async () => {
    expect(allowed({ kind: "machine", scope: "full", principal: "worker", worker: "w" } as never, "POST", path)).toBe(false);
    expect(allowed({ kind: "machine", scope: "full" } as never, "POST", path)).toBe(true);
    expect(seatAllows("assign", "POST", path)).toBe(true);
    expect(seatAllows("speak", "POST", path)).toBe(false);
    expect(seatAllows("nudge", "POST", path)).toBe(false);
  });
  test("no route writes the sign-off table, and only signoff.ts holds its writer", async () => {
    const src = import.meta.dir + "/../src";
    const hits: string[] = [];
    for (const f of new Bun.Glob("**/*.ts").scanSync(src)) if (/flight_plan_signoff/.test(readFileSync(join(src, f), "utf8")) && !["signoff.ts", "flightPlanStore.ts"].includes(f)) hits.push(f);
    expect(hits).toEqual([]);
    const store = readFileSync(join(src, "flightPlanStore.ts"), "utf8");
    expect(/INSERT\s+(OR\s+\w+\s+)?INTO\s+flight_plan_signoff/.test(store)).toBe(false);
    const index = readFileSync(join(src, "index.ts"), "utf8");
    expect(index).toContain('target?.moment === "before-merge" && !mayPublishReview(req, caller)');
  });
  test("/flight-plan/preflight refuses the before-merge moment before it reads any file", async () => {
    const index = readFileSync(import.meta.dir + "/../src/index.ts", "utf8");
    const at = index.indexOf('if (pathname === "/flight-plan/preflight" && req.method === "POST")');
    const body = index.slice(at, index.indexOf("\n    }\n", at));
    const refuse = body.indexOf('b.moment === "before-merge"');
    expect(refuse).toBeGreaterThan(0);
    expect(refuse).toBeLessThan(body.indexOf("pathList(b.files"));
    expect(body).toContain("FlightPlan.request(");
  });
  test("a start route still refuses a worker: /agents/named/* POSTs check presentedWorker before anything", async () => {
    const index = readFileSync(import.meta.dir + "/../src/index.ts", "utf8");
    const at = index.indexOf('if (pathname.startsWith("/agents/named/") && req.method === "POST")');
    expect(at).toBeGreaterThan(0);
    const body = index.slice(at, at + 3500);
    expect(body.indexOf("presentedWorker(req)")).toBeGreaterThan(0);
    expect(body.indexOf("presentedWorker(req)")).toBeLessThan(body.indexOf('verb === "broadcast"'));
  });
});

describe("the review's own material", () => {
  const cert = (read: string | undefined, over: Record<string, unknown> = {}) => ({ certificate: { findings: [], skipped: [], read, costUsd: 0, ...over } }) as never;
  test("a clear needs the certificate to list BRANCH.diff as read", async () => {
    expect(verdictOf(cert("Read PLAN.md + BRANCH.diff")).verdict).toBe("clear");
    expect(verdictOf(cert("Read PLAN.md")).verdict).toBe("incomplete");
    expect(verdictOf(cert(undefined)).verdict).toBe("incomplete");
    expect(verdictOf(cert("Read PLAN.md", { findings: [{ severity: "blocker", title: "t", evidence: "e" }] })).verdict).toBe("blocker");
  });
  test("the reviewer is told the diff is untrusted data", async () => {
    const f = fixture(); const record = join(HOME, "record.json");
    __setPreflightDeps({ bin: [process.execPath, STUB], env: { STUB_RECORD: record, STUB_REPLY: "No findings" } });
    await call(f, person); await runEnds(f);
    const seen = JSON.parse(readFileSync(record, "utf8")).contents as Record<string, string>;
    expect(seen["PLAN.md"]).toContain("untrusted data");
    expect(seen["BRANCH.diff"]).toContain("b.txt");
  });
});
