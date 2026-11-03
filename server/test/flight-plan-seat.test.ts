/*
 * A chair's own credential on the Flight plan routes, on a booted server where a
 * chair really sits (fixtures/workerHarness.ts): it reads its own project's
 * runs and plans and nobody else's. It cannot say a run's Go or No-go, nor ask
 * for a Preflight over a file: the wall in auth.ts turns those away before a
 * route runs. It writes plans and answers findings in its own project, and in
 * Co-pilot a plan's Go, No-go and Launch are still the person's.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { MACHINE, startHarness, type Harness } from "./fixtures/workerHarness.ts";

const have = !!Bun.which("tmux") && !!Bun.which("python3");
let h: Harness, other: string, ownRun: string, foreignRun: string, ownDone: string, foreignDone: string, ownPlan: string, foreignPlan: string;
beforeAll(async () => {
  if (!have) return;
  h = await startHarness("fpseat");
  other = join(h.dir, "other-project"); mkdirSync(other);
  writeFileSync(join(h.dir, "plan.md"), "# Plan");
  const person = (path: string, body: unknown) => h.asPerson(path, body);
  await person("/settings/door", { id: "flightPlan.enabled", value: true });
  ownPlan = ((await person("/flight-plan/plans", { root: h.dir, request: "own project" })) as any).plan.id;
  // A run that waits for Go executes nothing, so no reviewer is needed here; a request now starts running, so such a row goes straight into the server's own database.
  // So does another project the app does not know: it cannot be made through the routes.
  const db = new Database(join(h.dir, "w.db"));
  ownRun = "pf_0000000000000000"; foreignRun = "pf_0000000000000001"; foreignPlan = "fp_0000000000000001";
  db.query(`INSERT INTO preflight_run (id, created_at, root, moment, state, requested_by, input) VALUES (?, 2, ?, 'before-launch', 'awaiting-go', 'x', '{}')`).run(ownRun, h.dir);
  // Two finished runs with one finding each: the answer to a finding needs a certificate to answer on.
  ownDone = "pf_0000000000000002"; foreignDone = "pf_0000000000000003";
  const cert = JSON.stringify({ id: "c", createdAt: 1, model: "m", costUsd: 0, files: [], mockups: [], skipped: [], sawConversation: false, isolation: "x", findings: [{ id: "F1", severity: "major", title: "t", quote: "", evidence: "", action: null, note: null }] });
  for (const [id, root] of [[ownDone, h.dir], [foreignDone, other]] as const) db.query(`INSERT INTO preflight_run (id, created_at, root, moment, state, requested_by, input, certificate) VALUES (?, 3, ?, 'before-launch', 'done', 'x', '{}', ?)`).run(id, root, cert);
  db.query(`INSERT INTO preflight_run (id, created_at, root, moment, state, requested_by, input) VALUES (?, 1, ?, 'before-launch', 'awaiting-go', 'x', '{}')`).run(foreignRun, other);
  db.query(`INSERT INTO flight_plan (id, root, title, request, state, created_at, updated_at) VALUES (?, ?, 'other', 'another project', 'draft', 1, 1)`).run(foreignPlan, other);
  db.close();
}, SERVER_BOOT_MS);
afterAll(async () => { if (have) await h.stop(); });

const asSeat = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(h.base + path, { method, headers: { Authorization: `Bearer ${h.seatToken}`, "Content-Type": "application/json", Origin: h.base }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const asMachine = async (path: string) => (await (await fetch(h.base + path, { headers: { Authorization: `Bearer ${MACHINE}` } })).json()) as Record<string, any>;

describe.skipIf(!have)("a seat on the Flight plan routes", () => {
  test("the setup is real: the person sees both projects' runs and plans", async () => {
    const runs = (await asMachine("/flight-plan/runs")).runs.map((r: any) => r.id);
    expect(runs).toEqual(expect.arrayContaining([ownRun, foreignRun]));
    expect((await asMachine("/flight-plan/plans")).plans.map((p: any) => p.id)).toEqual(expect.arrayContaining([ownPlan, foreignPlan]));
  });

  test("it lists its own project's runs and plans only, whatever root it asks for", async () => {
    for (const q of ["", `?root=${encodeURIComponent(other)}`]) {
      expect((await asSeat("GET", `/flight-plan/runs${q}`)).body.runs.map((r: any) => r.id).sort()).toEqual([ownRun, ownDone].sort());
      expect((await asSeat("GET", `/flight-plan/plans${q}`)).body.plans.map((p: any) => p.id)).toEqual([ownPlan]);
    }
  });

  test("it reads its own run and plan, and is refused another project's", async () => {
    expect((await asSeat("GET", `/flight-plan/runs/${ownRun}`)).status).toBe(200);
    expect((await asSeat("GET", `/flight-plan/plans/${ownPlan}`)).status).toBe(200);
    expect((await asSeat("GET", `/flight-plan/runs/${foreignRun}`)).status).toBe(403);
    expect((await asSeat("GET", `/flight-plan/plans/${foreignPlan}`)).status).toBe(403);
  });

  test("a run's Go and No-go are the person's even for its own project's run, and nothing moves", async () => {
    for (const id of [ownRun, foreignRun]) {
      for (const verb of ["go", "no-go"]) expect((await asSeat("POST", `/flight-plan/runs/${id}/${verb}`, {})).status).toBe(403);
      expect((await asMachine(`/flight-plan/runs/${id}`)).run.state).toBe("awaiting-go");
    }
  });

  test("it answers a finding in its own project's run, never another project's; in Manual the person answers", async () => {
    const answer = (id: string) => asSeat("POST", `/flight-plan/runs/${id}/findings/F1`, { action: "fix" });
    expect((await answer(foreignDone)).status).toBe(403);
    expect((await asMachine(`/flight-plan/runs/${foreignDone}`)).run.certificate.findings[0].action).toBeNull();
    await h.asPerson("/settings/door", { id: "flightPlan.pilot", value: "manual", root: h.dir });
    expect((await answer(ownDone)).status).toBe(403);
    expect((await asMachine(`/flight-plan/runs/${ownDone}`)).run.certificate.findings[0].action).toBeNull();
    await h.asPerson("/settings/door", { id: "flightPlan.pilot", value: "copilot", root: h.dir });
    expect((await answer(ownDone)).status).toBe(200);
    expect((await asMachine(`/flight-plan/runs/${ownDone}`)).run.certificate.findings[0].action).toBe("fix");
  });

  test("an agent on the machine token that is not the coordinator answers no finding, so it lifts no stop", async () => {
    await h.asPerson("/settings/door", { id: "flightPlan.pilot", value: "autopilot", root: h.dir });
    try {
      for (const action of ["dismiss", "fix"]) {
        const r = await h.asPerson(`/flight-plan/runs/${ownDone}/findings/F1`, { action, note: "not needed" }, { "X-Agentglass-Agent": "builder-orbit" });
        expect(r.status).toBe(403);
      }
      expect((await asMachine(`/flight-plan/runs/${ownDone}`)).run.certificate.findings[0].action).not.toBe("dismiss");
    } finally { await h.asPerson("/settings/door", { id: "flightPlan.pilot", value: "copilot", root: h.dir }); }
  });

  test("it cannot ask for a Preflight over a file", async () => {
    expect((await asSeat("POST", "/flight-plan/preflight", { root: h.dir, moment: "manual", files: [join(h.dir, "plan.md")] })).status).toBe(403);
  });

  test("it writes plans in its own project only", async () => {
    const made = await asSeat("POST", "/flight-plan/plans", { root: h.dir, request: "x" });
    expect(made.status).toBe(200);
    const id = made.body.plan.id as string;
    expect((await asSeat("PATCH", `/flight-plan/plans/${id}`, { title: "edited" })).body.plan.title).toBe("edited");
    expect((await asSeat("POST", "/flight-plan/plans", { root: other, request: "x" })).status).toBe(403);
    expect((await asSeat("PATCH", `/flight-plan/plans/${foreignPlan}`, { plan_md: "# sneaky" })).status).toBe(403);
    expect((await asMachine(`/flight-plan/plans/${foreignPlan}`)).plan).toMatchObject({ state: "draft", planMd: "" });
  });

  test("in Co-pilot, Go, No-go and Launch on its own project's plan are the person's; another project's is refused outright", async () => {
    for (const verb of ["preflight", "go", "no-go", "launch"]) expect((await asSeat("POST", `/flight-plan/plans/${foreignPlan}/${verb}`, { reason: "r" })).status, verb).toBe(403);
    for (const verb of ["go", "no-go", "launch"]) {
      const r = await asSeat("POST", `/flight-plan/plans/${ownPlan}/${verb}`, { reason: "r" });
      expect(r.status, verb).toBe(403);
      expect(r.body.error, verb).toContain("Co-pilot");
    }
    expect((await asMachine(`/flight-plan/plans/${ownPlan}`)).plan).toMatchObject({ state: "draft", planMd: "" });
  });
});
