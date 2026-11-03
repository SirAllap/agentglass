/*
 * An ADOPTED seat (a session that was already running, not one the app
 * started) is handed a seat credential by `/seat/adopt`, and with it the Go
 * door treats it as the project's coordinator under the same rules as a started
 * seat: Autopilot only, its own project only, not held, no stop rule firing.
 * Without the credential its calls arrive on the machine token and the door
 * cannot tell it from any other agent, whose Go stays refused.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { MACHINE, startHarness, type Harness } from "./fixtures/workerHarness.ts";

const have = !!Bun.which("tmux") && !!Bun.which("python3");
let h: Harness, other: string, adopted: string, foreignPlan: string;
const call = async (token: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
  const r = await fetch(h.base + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: h.base, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const setPilot = (value: string) => h.asPerson("/settings/door", { id: "flightPlan.pilot", value, root: h.dir });
// A plan that is ready to take a Go: the review it would wait for is off, as in flight-plan-pilot.test.ts.
const ready = async (token: string) => {
  const id = (await call(token, "POST", "/flight-plan/plans", { root: h.dir, request: "footer", size: "M" })).body.plan.id as string;
  expect((await call(token, "PATCH", `/flight-plan/plans/${id}`, { plan_md: "# Plan\nChange the footer text." })).status).toBe(200);
  return id;
};

beforeAll(async () => {
  if (!have) return;
  h = await startHarness("fpadopted");
  other = join(h.dir, "other-project"); mkdirSync(other);
  await h.asPerson("/settings/door", { id: "flightPlan.enabled", value: true });
  await h.asPerson("/settings/door", { id: "flightPlan.preflight.reviews", value: [], root: h.dir });
  foreignPlan = "fp_0000000000000001";
  const db = new Database(join(h.dir, "w.db"));
  db.query(`INSERT INTO flight_plan (id, root, title, request, plan_md, state, created_at, updated_at) VALUES (?, ?, 'other', 'another project', '# Plan', 'ready', 1, 1)`).run(foreignPlan, other);
  db.close();
  // The started seat steps down; a session that was already running takes the chair.
  expect((await h.asPerson("/seat/close", { root: h.dir })).ok).toBe(true);
  const r = await h.asPerson("/seat/adopt", { root: h.dir, pane: await h.handTab(h.dir), powers: "assign" });
  expect(r.ok).toBe(true);
  adopted = (r as any).token;
}, SERVER_BOOT_MS);
afterAll(async () => { if (have) await h.stop(); });

describe.skipIf(!have)("an adopted seat on the Go door", () => {
  test("adopt hands back a seat credential", () => {
    expect(adopted).toMatch(/^st_/);
  });

  test("in Autopilot its Go is accepted and recorded under the seat's name", async () => {
    await setPilot("autopilot");
    const id = await ready(adopted);
    const go = await call(adopted, "POST", `/flight-plan/plans/${id}/go`, {});
    expect(go.body.plan?.decision?.by).toMatch(/^coordinator:/);
  });

  test("in Co-pilot and in Manual it is refused with the pilot named, and the plan does not move", async () => {
    const id = await ready(adopted);
    for (const [pilot, word] of [["copilot", "Co-pilot"], ["manual", "Manual"]] as const) {
      await setPilot(pilot);
      const r = await call(adopted, "POST", `/flight-plan/plans/${id}/go`, {});
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(`this project flies in ${word}: Go is the person's`);
    }
    expect((await call(MACHINE, "GET", `/flight-plan/plans/${id}`)).body.plan.state).toBe("ready");
  });

  test("another project's plan is refused whatever the pilot", async () => {
    await setPilot("autopilot");
    // The other project flies in Autopilot too, so only the project wall can stop it.
    const db = new Database(join(h.dir, "w.db"));
    db.query(`INSERT INTO flight_plan_setting (root, key, value) VALUES (?, 'flightPlan.pilot', '"autopilot"') ON CONFLICT (root, key) DO UPDATE SET value = excluded.value`).run(other);
    db.close();
    const r = await call(adopted, "POST", `/flight-plan/plans/${foreignPlan}/go`, {});
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("a seat touches its own project's flight plans only");
    expect((await call(MACHINE, "GET", `/flight-plan/plans/${foreignPlan}`)).body.plan.state).toBe("ready");
  });

  test("held, it is refused like a started seat", async () => {
    await setPilot("autopilot");
    const id = await ready(adopted);
    expect((await call(adopted, "POST", "/flight-plan/hold", {})).body.held).toBe(true);
    const r = await call(adopted, "POST", `/flight-plan/plans/${id}/go`, {});
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("this project is held: no new Go until the person resumes it");
    await h.asPerson("/flight-plan/resume", { root: h.dir });
  });

  test("a session that is not the seat is refused, even speaking with the machine token", async () => {
    await setPilot("autopilot");
    const id = await ready(adopted);
    for (const extra of [{ "x-agentglass-agent": "helper" }, { "x-agentglass-agent": "Orchestrator-example" }]) {
      const r = await call(MACHINE, "POST", `/flight-plan/plans/${id}/go`, {}, extra);
      expect(r.status).toBe(403);
    }
    expect((await call(MACHINE, "GET", `/flight-plan/plans/${id}`)).body.plan.state).toBe("ready");
  });

  test("standing the adopted seat down revokes its credential", async () => {
    await h.asPerson("/seat/close", { root: h.dir });
    expect((await call(adopted, "GET", "/flight-plan/plans")).status).toBe(401);
  });

  test("a started seat's own credential still says Go in Autopilot", async () => {
    rmSync(join(h.logs, "seat.token"), { force: true }); // the first seating left its token here
    expect((await h.asPerson("/seat/open", { root: h.dir, powers: "assign" })).ok).toBe(true);
    const token = await h.until(async () => (await Bun.file(join(h.logs, "seat.token")).exists() ? await Bun.file(join(h.logs, "seat.token")).text() : "") || undefined);
    await setPilot("autopilot");
    const id = await ready(token);
    const go = await call(token, "POST", `/flight-plan/plans/${id}/go`, {});
    expect(go.body.plan?.decision?.by ?? "").toMatch(/^coordinator:/);
  });
});
