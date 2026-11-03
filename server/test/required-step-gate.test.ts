/*
 * A STEP THE FLOW MARKS REQUIRED IS ENFORCED WHERE A PLAN'S WORK LANDS.
 *
 * The seat was only told a required role "cannot be skipped". The server now
 * records how each role worker started for a plan ended, and Integrate (the
 * coordinator's check before bringing the work in) refuses while a required
 * role on the saved path has no passing result for the plan text as saved.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-reqstep-"));
const restore = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, AGENTGLASS_DB: process.env.AGENTGLASS_DB, AGENTGLASS_STATE_DIR: process.env.AGENTGLASS_STATE_DIR };
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.AGENTGLASS_DB = join(dir, "gate.db");

const Store = await import("../src/flightPlanStore.ts");
const FlightPlan = await import("../src/flightPlan.ts");
const { writeStoredFlow } = await import("../src/config.ts");
const { templateFlow } = await import("../../shared/flowTemplates.ts");
const { renderFlowForOrchestrator, roleLines, ROLE_LINES_MAX } = await import("../src/flow.ts");
const { endedTurn, reportOf } = await import("../src/agents/policystart.ts");
const { prepareRun, runFiles } = await import("../src/agents/headless.ts");
const { db } = await import("../src/db.ts");

afterAll(() => {
  for (const [k, v] of Object.entries(restore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const rootOf = () => `/home/a/code/orbit-gate-${++n}`;
const newPlan = (root: string) => Store.createPlan({ root, title: "Add thing", request: "add the thing", visual: false });

/** The template flow with the Inspector required (on the path) and a custom role on it too. */
function saveFlow(root: string, o: { inspectorRequired?: boolean; onPath?: boolean; custom?: boolean } = {}) {
  const f = templateFlow();
  const insp = f.roster.find((r) => r.id === "inspector")!;
  insp.required = o.inspectorRequired ?? true;
  if (o.onPath === false) f.path = f.path.filter((id) => id !== "inspector");
  if (o.custom) {
    f.roster = [...f.roster, { ...f.roster[0]!, id: "devops", name: "DevOps", policyRole: undefined, chain: [{ engine: "claude", model: "" }], tools: [], readsOnly: true, required: true }] as typeof f.roster;
    f.path = [...f.path, "devops"];
  }
  expect(writeStoredFlow(root, f).ok).toBe(true);
}

/** The template flow with the reviewing role renamed to `checker` everywhere: a built-in role whose roster id is not its own. */
function saveAliasFlow(root: string) {
  const f = templateFlow();
  const at = (id: string) => (id === "inspector" ? "checker" : id);
  f.roster = f.roster.map((r) => (r.id === "inspector" ? { ...r, id: "checker", name: "Checker" } : r));
  f.path = f.path.map(at);
  f.blocks = f.blocks.map((b) => ({ ...b, id: at(b.id) }));
  f.edges = f.edges.map((e) => ({ ...e, from: at(e.from), to: at(e.to) }));
  expect(writeStoredFlow(root, f).ok).toBe(true);
}

describe("roundsSpentFor", () => {
  test("a built-in role reaches its roster entry by policyRole: the alias's fails spend the reviewer's rounds", () => {
    const root = rootOf();
    saveAliasFlow(root);
    const p = newPlan(root);
    expect(FlightPlan.roundsSpentFor(p, "reviewer")).toBe(false);
    for (let i = 0; i < 3; i++) Store.recordStep(p.id, "checker", "fail");
    expect(FlightPlan.roundsSpentFor(p, "reviewer")).toBe(true);
    expect(FlightPlan.roundsSpentFor(p, "builder")).toBe(false);
    expect(FlightPlan.roundsUsed(p)).toEqual(["Checker"]);
  });
});

describe("requiredMissing", () => {
  test("a required Inspector on the path is missing until a pass is recorded", () => {
    const root = rootOf(); saveFlow(root);
    const p = newPlan(root);
    expect(FlightPlan.requiredMissing(p)).toEqual(["Inspector"]);
    Store.recordStep(p.id, "inspector", "pass");
    expect(FlightPlan.requiredMissing(p)).toEqual([]);
  });
  test("a failed verdict does not count", () => {
    const root = rootOf(); saveFlow(root);
    const p = newPlan(root);
    Store.recordStep(p.id, "inspector", "fail");
    expect(FlightPlan.requiredMissing(p)).toEqual(["Inspector"]);
  });
  test("a required role off the path is not required (the flow writer also refuses to save one, so the flow is ignored)", () => {
    const root = rootOf(); saveFlow(root, { onPath: false });
    expect(FlightPlan.requiredMissing(newPlan(root))).toEqual([]);
  });
  test("no saved flow, or nothing required: unaffected", () => {
    expect(FlightPlan.requiredMissing(newPlan(rootOf()))).toEqual([]);
    const root = rootOf(); saveFlow(root, { inspectorRequired: false });
    expect(FlightPlan.requiredMissing(newPlan(root))).toEqual([]);
  });
  test("a pass given to an older plan text does not count for the new one", () => {
    const root = rootOf(); saveFlow(root);
    const p = newPlan(root);
    Store.patchPlan(p.id, { planMd: "v1" });
    Store.recordStep(p.id, "inspector", "pass");
    expect(FlightPlan.requiredMissing(Store.getPlan(p.id)!)).toEqual([]);
    Store.patchPlan(p.id, { planMd: "v2" });
    expect(FlightPlan.requiredMissing(Store.getPlan(p.id)!)).toEqual(["Inspector"]);
  });
  test("a plan made before the gate existed is exempt", () => {
    const root = rootOf(); saveFlow(root);
    const p = newPlan(root);
    db.query("UPDATE flight_plan SET created_at = 1 WHERE id = ?").run(p.id);
    expect(FlightPlan.requiredMissing(Store.getPlan(p.id)!)).toEqual([]);
  });
  test("the stop reason has its sentence", () => {
    expect(FlightPlan.STOP_SENTENCE["required-step"]).toBe("A step the flow marks required has no passing result yet: a person decides.");
  });
});

/** A finished headless worker row the way policystart leaves it, with its output file. */
function endedWorker(name: string, root: string, by: Record<string, unknown>, o: { exit?: number; out?: string } = {}) {
  const BY = { headless: true, turn: 1, turnMinutes: 30, engine: "claude", model: "sonnet", position: 0, because: [], scope: "global", rule: "base", envelope: {}, ...by };
  db.query(`INSERT INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at, adopted, seat_root, started_by, exit_code, exit_line)
    VALUES (?1, 'claude', ?2, '%999', '@999', ?3, NULL, 0, ?4, ?5, ?6, '')`).run(name, dir, Date.now() - 1000, root, JSON.stringify(BY), o.exit ?? 0);
  mkdirSync(join(dir, "x"), { recursive: true });
  const f = prepareRun(name, "work", "none");
  if (o.out !== undefined) writeFileSync(runFiles(name).out, o.out);
  return f;
}
const quiet = { send: async () => {} };

describe("recording on endedTurn", () => {
  test("a built-in role started for a plan records a pass", async () => {
    const root = rootOf(); saveFlow(root);
    const p = newPlan(root);
    endedWorker("rs-builder", root, { role: "builder", planId: p.id });
    await endedTurn("rs-builder", quiet);
    expect(Store.passedRoles(p.id).has("builder")).toBe(true);
  });
  test("a custom role started for a plan records a pass", async () => {
    const root = rootOf(); saveFlow(root, { custom: true });
    const p = newPlan(root);
    expect(FlightPlan.requiredMissing(p)).toEqual(["Inspector", "DevOps"]);
    endedWorker("rs-devops", root, { role: "devops", planId: p.id });
    await endedTurn("rs-devops", quiet);
    expect(FlightPlan.requiredMissing(p)).toEqual(["Inspector"]);
  });
  test("a worker without --plan records nothing", async () => {
    const root = rootOf(); saveFlow(root);
    const p = newPlan(root);
    endedWorker("rs-noplan", root, { role: "inspector" });
    await endedTurn("rs-noplan", quiet);
    expect(FlightPlan.requiredMissing(p)).toEqual(["Inspector"]);
  });
  test("a failed turn records a fail", async () => {
    const root = rootOf(); saveFlow(root);
    const p = newPlan(root);
    endedWorker("rs-failed", root, { role: "inspector", planId: p.id }, { exit: 1 });
    // The failure path asks which engines are ready; the verdict is what is under test.
    await endedTurn("rs-failed", quiet).catch(() => {});
    expect(FlightPlan.requiredMissing(p)).toEqual(["Inspector"]);
    expect(db.query("SELECT verdict FROM flight_plan_step WHERE plan_id = ?").all(p.id)).toEqual([{ verdict: "fail" }]);
  }, 30000);
  test("a reviewer with a BLOCKER line, or with no readable report, is not a pass; a clean one is", async () => {
    const root = rootOf(); saveFlow(root);
    const p = newPlan(root);
    const frame = (t: string) => JSON.stringify({ type: "result", result: t });
    endedWorker("rs-rev-block", root, { role: "inspector", planId: p.id }, { out: frame("looked\nBLOCKER: the lock is gone") });
    await endedTurn("rs-rev-block", quiet);
    expect(FlightPlan.requiredMissing(p)).toEqual(["Inspector"]);
    endedWorker("rs-rev-blank", root, { role: "inspector", planId: p.id }, { out: "" });
    await endedTurn("rs-rev-blank", quiet);
    expect(FlightPlan.requiredMissing(p)).toEqual(["Inspector"]);
    endedWorker("rs-rev-clean", root, { role: "inspector", planId: p.id }, { out: frame("looked\nno findings") });
    await endedTurn("rs-rev-clean", quiet);
    expect(FlightPlan.requiredMissing(p)).toEqual([]);
  });
  test("reportOf: result frame, plain text, or null", () => {
    expect(reportOf(`{"type":"x"}\n{"type":"result","result":"ok"}`)).toBe("ok");
    expect(reportOf(`{"type":"text","part":{"type":"text","text":"fine\\nBLOCKER: x"}}`)).toBe("fine\nBLOCKER: x");
    expect(reportOf(`{"type":"item.completed","item":{"type":"agent_message","text":"codex says"}}`)).toBe("codex says");
    expect(reportOf("plain words")).toBe("plain words");
    expect(reportOf(`{"type":"x"}`)).toBeNull();
    expect(reportOf("")).toBeNull();
  });
  test("a recording that throws never breaks the worker's end", async () => {
    const root = rootOf(); saveFlow(root);
    endedWorker("rs-throw", root, { role: "builder", planId: "fp_does_not_exist" });
    db.exec("ALTER TABLE flight_plan_step RENAME TO flight_plan_step_x");
    try { await endedTurn("rs-throw", quiet); } finally { db.exec("ALTER TABLE flight_plan_step_x RENAME TO flight_plan_step"); }
  });
});

describe("the seat brief", () => {
  test("the Hard rule names the server refusal and --plan", () => {
    const f = templateFlow(); f.roster.find((r) => r.id === "inspector")!.required = true;
    const text = renderFlowForOrchestrator(f);
    expect(text).toContain("The server refuses to land a plan until each of these has a passing result");
    expect(text).toContain("--plan <id>");
  });
  test("a flow with nothing required is word for word what it was", () => {
    expect(renderFlowForOrchestrator(templateFlow())).not.toContain("refuses to land");
  });
  test("the role lines stay inside ROLE_LINES_MAX", () => {
    const f = templateFlow(); f.roster.find((r) => r.id === "inspector")!.required = true;
    expect(roleLines(f.roster).length).toBeLessThanOrEqual(ROLE_LINES_MAX);
  });
});
