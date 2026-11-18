/*
 * `flight-plan plan land`: a plan built outside Launch is closed by naming a commit the
 * base branch holds. Refused for the seat unless the project flies in Autopilot, refused
 * for a commit the base does not hold, refused for anything that is not a sha; accepted
 * for the seat and for the person, and then the plan reads as landed with the commit kept.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { startHarness, type Harness } from "./fixtures/workerHarness.ts";

const have = !!Bun.which("tmux") && !!Bun.which("python3") && !!Bun.which("git");
describe.skipIf(!have)("landing a plan built outside Launch", () => {
  let h: Harness;
  let inBase = "", offBase = "";
  const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: h.dir }).stdout.toString().trim();
  beforeAll(async () => {
    h = await startHarness("fpland");
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "one");
    inBase = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", "side");
    git("commit", "-q", "--allow-empty", "-m", "two");
    offBase = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    // The remote refs exist from the start: the server keeps the base branch's name for a while, so a remote that appeared mid-run would never be seen.
    git("update-ref", "refs/remotes/origin/main", inBase);
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    await h.asPerson("/settings/door", { id: "flightPlan.enabled", value: true });
    await h.asPerson("/settings/door", { id: "flightPlan.preflight.reviews", value: [], root: h.dir });
  }, SERVER_BOOT_MS);
  afterAll(async () => { if (h) await h.stop(); });

  const pilot = (value: string) => h.asPerson("/settings/door", { id: "flightPlan.pilot", value, root: h.dir });
  const ready = async () => {
    const made = await h.asPerson("/flight-plan/plans", { root: h.dir, request: "footer", size: "M" });
    const id = (made as any).plan.id as string;
    await fetch(`${h.base}/flight-plan/plans/${id}`, { method: "PATCH", headers: { Authorization: `Bearer ${h.seatToken}`, "Content-Type": "application/json", Origin: h.base }, body: JSON.stringify({ plan_md: "# Plan\nChange the footer." }) });
    return id;
  };
  const planOf = async (id: string) => (await h.read(`/flight-plan/plans/${id}`, h.seatToken)).body;

  test("the seat is refused outside Autopilot, then lands a plan in Autopilot", async () => {
    const id = await ready();
    await pilot("copilot");
    const no = await h.asSeat(`/flight-plan/plans/${id}/land`, { commit: inBase });
    expect(no.status).toBe(403);
    expect(no.error).toContain("Land is the person's");
    expect((await planOf(id)).landed).toBe(false);
    await pilot("autopilot");
    const yes = await h.asSeat(`/flight-plan/plans/${id}/land`, { commit: inBase.slice(0, 10) });
    expect(yes.status).toBe(200);
    const read = await planOf(id);
    expect(read.landed).toBe(true);
    expect(read.plan.landedSha).toBe(inBase);
    expect(read.plan.state).toBe("ready");
    expect((await h.asSeat(`/flight-plan/plans/${id}/land`, { commit: inBase })).status).toBe(409);
  });

  test("a commit the base does not hold, and a word that is not a sha, are refused", async () => {
    await pilot("autopilot");
    const id = await ready();
    const off = await h.asSeat(`/flight-plan/plans/${id}/land`, { commit: offBase });
    expect(off.status).toBe(409);
    expect(off.error).toContain("is not in");
    for (const commit of ["--all", "nope", "", undefined]) expect((await h.asPerson(`/flight-plan/plans/${id}/land`, { commit })).ok).toBe(false);
    expect((await planOf(id)).landed).toBe(false);
  });

  test("the person lands it in any mode", async () => {
    await pilot("manual");
    const id = await ready();
    expect((await h.asPerson(`/flight-plan/plans/${id}/land`, { commit: inBase })).ok).toBe(true);
    expect((await planOf(id)).plan.landedSha).toBe(inBase);
  });
  test("a project that never pushes lands a commit only its local base holds", async () => {
    await pilot("autopilot");
    // origin/main sits on the side branch, so local main has diverged from it and the base reads as origin/main.
    git("update-ref", "refs/remotes/origin/main", offBase);
    git("commit", "-q", "--allow-empty", "-m", "local only");
    const localOnly = git("rev-parse", "HEAD");
    const id = await ready();
    const neither = git("commit-tree", "-p", offBase, "-m", "dangling", `${offBase}^{tree}`);
    const no = await h.asSeat(`/flight-plan/plans/${id}/land`, { commit: neither });
    expect(no.status).toBe(409);
    expect(no.error).toContain("is not in origin/main: land it there first");
    const yes = await h.asSeat(`/flight-plan/plans/${id}/land`, { commit: localOnly });
    expect(yes.ok).toBe(true);
    expect((yes as any).foundIn).toBe("main");
    expect((await planOf(id)).plan.landedSha).toBe(localOnly);
  });
});
