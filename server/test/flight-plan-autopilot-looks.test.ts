/*
 * How many Preflights the coordinator may start on one plan alone. In Co-pilot
 * and Manual the second looks decide; in Autopilot, not held, the money does,
 * up to a ceiling per plan; a reached budget is Co-pilot again. An open blocker
 * the coordinator can answer itself is never the person's stop in Autopilot,
 * but its Go still waits for the answer. The rules run on the modules directly.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ISOLATED = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "AGENTGLASS_STATE_DIR", "TMUX_TMPDIR"] as const;
const REAL = Object.fromEntries([...ISOLATED, "AGENTGLASS_DB"].map((k) => [k, process.env[k]]));
const HOME = mkdtempSync(join(tmpdir(), "agx-looks-"));
for (const k of ISOLATED) { process.env[k] = join(HOME, k.toLowerCase()); mkdirSync(process.env[k]!, { recursive: true }); }
mkdirSync(join(HOME, "xdg_config_home", "agentglass"), { recursive: true });
process.env.AGENTGLASS_DB = join(HOME, "agentglass.db");

const Flight = await import("../src/flightPlan.ts");
const Plans = await import("../src/flightPlanStore.ts");
const Store = await import("../src/preflightStore.ts");
const Budget = await import("../src/flightBudget.ts");
const { db } = await import("../src/db.ts");

const ROOT = "/work/orbit";
const plan = () => {
  const p = Plans.createPlan({ root: ROOT, title: "Footer", request: "r", visual: false });
  Plans.patchPlan(p.id, { planMd: "# Plan\nChange the footer." });
  return Plans.getPlan(p.id)!;
};
const rounds = (id: string, n: number) => { db.query(`UPDATE flight_plan SET review_rounds = ?, auto_runs = ? WHERE id = ?`).run(n, n, id); return Plans.getPlan(id)!; };
const finding = (id: string, severity: string, action: string | null = null) => ({ id, severity, title: "t", quote: "", evidence: "", action, note: null });
const withRun = (p: { id: string }, findings: object[], costUsd = 0) => {
  const run = Store.createRun({ root: ROOT, moment: "before-launch", state: "running", by: "t", input: { files: [], mockups: [], root: ROOT, model: "sonnet", budgetUsd: 1 } as never });
  Store.finish(run.id, { id: "x", createdAt: 0, model: "m", costUsd, capUsd: 1, files: [], mockups: [], skipped: [], read: [], findings } as never);
  Plans.setPreflightRun(p.id, run.id);
  return run;
};
const autopilot = () => Store.putSetting(ROOT, "flightPlan.pilot", "autopilot");

afterEach(() => {
  db.run(`DELETE FROM flight_plan`); db.run(`DELETE FROM preflight_run`); db.run(`DELETE FROM flight_plan_setting`);
  Budget.forgetBudget();
});
afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  for (const k of [...ISOLATED, "AGENTGLASS_DB"]) if (REAL[k] === undefined) delete process.env[k]; else process.env[k] = REAL[k];
});

describe("the coordinator's own Preflights", () => {
  test("in Autopilot the seat's 4th Preflight is allowed and the 9th is refused at the ceiling", () => {
    autopilot();
    const p = plan();
    expect(Flight.seatMayPreflight(rounds(p.id, 3), true)).toBeNull();
    expect(Flight.seatMayPreflight(rounds(p.id, Flight.AUTOPILOT_PREFLIGHTS_MAX - 1), true)).toBeNull();
    expect(Flight.seatMayPreflight(rounds(p.id, Flight.AUTOPILOT_PREFLIGHTS_MAX), true)).toContain(`${Flight.AUTOPILOT_PREFLIGHTS_MAX} Preflights in Autopilot`);
    expect(Flight.AUTOPILOT_PREFLIGHTS_MAX).toBe(8);
  });

  test("Co-pilot refuses the 3rd with the default second looks", () => {
    const p = plan();
    expect(Flight.autoRunsMax()).toBe(2);
    expect(Flight.seatMayPreflight(rounds(p.id, 1), true)).toBeNull();
    expect(Flight.seatMayPreflight(rounds(p.id, 2), true)).toContain("second looks are used");
  });

  test("an agent that is not the seat keeps the second looks, even in Autopilot", () => {
    autopilot();
    expect(Flight.seatMayPreflight(rounds(plan().id, 2), false)).toContain("second looks are used");
  });

  test("a reached budget, or a hold, is the Co-pilot rule again", () => {
    autopilot();
    const p = plan();
    withRun(plan(), [], 5.5);
    Budget.forgetBudget();
    expect(Budget.budgetState().reached).toBe("daily");
    expect(Flight.seatMayPreflight(rounds(p.id, 2), true)).toContain("second looks are used");
    Store.putSetting(Store.APP, "flightPlan.budget.dailyUsd", 10);
    expect(Flight.seatMayPreflight(rounds(p.id, 2), true)).toBeNull();
    Store.putSetting(ROOT, "flightPlan.held", true);
    expect(Flight.seatMayPreflight(rounds(p.id, 2), true)).toContain("second looks are used");
  });
});

describe("what a Preflight costs the budget", () => {
  const STUB = new URL("./preflightStub.ts", import.meta.url).pathname;
  afterEach(() => Flight.__setPreflightDeps(null));

  test("a run stopped at its cap counts what it spent, and that can reach the budget", async () => {
    autopilot();
    const capJson = JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 5.5 });
    Flight.__setPreflightDeps({ bin: [process.execPath, STUB], env: { STUB_RECORD: join(HOME, "record.json"), STUB_JSON: capJson } });
    const p = plan();
    const r = Flight.preflightPlan(p, "coordinator:chair");
    if (!r.ok) throw new Error(r.error);
    await r.done;
    expect(Store.getRun(r.run.id)!.state).toBe("failed");
    Budget.forgetBudget();
    expect(Budget.budgetState().dayUsd).toBeCloseTo(5.5);
    expect(Budget.budgetState().reached).toBe("daily");
    expect(Flight.seatMayPreflight(rounds(p.id, 2), true)).toContain("second looks are used");
  });

  test("a run still reading holds its cap; a failure that spent nothing known counts nothing", () => {
    const run = Store.createRun({ root: ROOT, moment: "before-launch", state: "running", by: "t", input: { files: [], mockups: [], root: ROOT, model: "sonnet", budgetUsd: 1.25 } as never });
    expect(Budget.budgetState(Date.now(), undefined, true).dayUsd).toBeCloseTo(1.25);
    Store.fail(run.id, "the reviewer could not start");
    expect(Budget.budgetState(Date.now(), undefined, true).dayUsd).toBe(0);
  });

  test("a run on its own from new plan text obeys the ceiling and the budget", () => {
    autopilot();
    const p = plan();
    db.query(`UPDATE flight_plan SET review_rounds = ? WHERE id = ?`).run(Flight.AUTOPILOT_PREFLIGHTS_MAX, p.id);
    expect(Flight.afterPlanText(Plans.getPlan(p.id)!, "t")).toBeNull();
    const q = plan();
    withRun(plan(), [], 5.5);
    expect(Flight.afterPlanText(Plans.getPlan(q.id)!, "t")).toBeNull();
    expect(db.query(`SELECT COUNT(*) AS c FROM preflight_run`).get()).toEqual({ c: 1 });
  });
});

describe("an open blocker in Autopilot", () => {
  test("is not the person's stop once the second looks are used, but the seat's Go waits for its answer", () => {
    autopilot();
    const p = plan();
    const run = withRun(p, [finding("F1", "blocker")]);
    const used = rounds(p.id, Flight.autoRunsMax());
    expect(Flight.stopReason(used)).toBeNull();
    expect(Flight.seatMayFly(used)).toEqual({ ok: false, error: expect.stringContaining("has no answer yet") });
    Store.setFindingAction(run.id, "F1", "fix", null, "coordinator:chair", true);
    expect(Flight.seatMayFly(Plans.getPlan(p.id)!)).toEqual({ ok: true });
  });

  test("in Co-pilot it is still the person's stop after the second looks", () => {
    const p = plan();
    withRun(p, [finding("F1", "blocker")]);
    expect(Flight.stopReason(rounds(p.id, Flight.autoRunsMax()))).toBe("open-blocker");
  });
});
