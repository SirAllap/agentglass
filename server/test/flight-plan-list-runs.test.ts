/*
 * `GET /flight-plan/plans` reads Preflight runs two ways per call: the budget sums
 * the week's run costs, and every plan's stop reason reads its last run's findings.
 * A run row carries the plan text in `input` and the findings in `certificate`;
 * reading a later column walks the earlier one's overflow pages. 60 plans with 5
 * runs each (500 KB of input per run) took ~43 ms in the sum and ~18 ms in the
 * findings reads. The sum now answers from a covering index; the findings read
 * takes only the findings, never the parsed input.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "../src/preflight.ts";

const REAL_XDG = process.env.XDG_CONFIG_HOME;
const HOME = mkdtempSync(join(tmpdir(), "agx-fp-runs-"));
process.env.XDG_CONFIG_HOME = HOME;
const Pre = await import("../src/preflightStore.ts");
const Plans = await import("../src/flightPlanStore.ts");
const Flight = await import("../src/flightPlan.ts");
const { db } = await import("../src/db.ts");

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  if (REAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = REAL_XDG;
});

const root = join(HOME, "orbit");
const finding = (id: string, severity: string, action: string | null): Finding => ({ id, severity, title: "t", quote: "q", evidence: "e", action, note: null } as Finding);
const done = (findings: unknown[], costUsd = 0.25) => {
  const run = Pre.createRun({ root, moment: "manual", state: "running", by: "x", input: { id: "", text: "## Step\nTouch web/src/thing.tsx.\n" } as never });
  Pre.finish(run.id, { findings, summary: "s", costUsd } as never);
  return run.id;
};

describe("the plan list's reads of Preflight runs", () => {
  // `bun test` shares one database: runs an earlier file left count too, so the sums are measured from here.
  let base = 0;
  beforeAll(() => { base = Pre.preflightCostSince(0); });

  test("the budget's sum is answered from the covering index, never from the rows", () => {
    const plan = db.query<{ detail: string }, [number]>(`EXPLAIN QUERY PLAN SELECT SUM(COALESCE(json_extract(certificate, '$.costUsd'), spent_usd, CASE WHEN state = 'running' THEN json_extract(input, '$.budgetUsd') END)) AS usd FROM preflight_run WHERE created_at >= ?`).all(0);
    expect(plan.map((r) => r.detail).join(" ")).toContain("COVERING INDEX preflight_run_cost");
    done([]); done([]);
    expect(Pre.preflightCostSince(0) - base).toBeCloseTo(0.5, 5);
  });

  test("the cost sum still counts a failed run and a run still reading", () => {
    const failed = Pre.createRun({ root, moment: "manual", state: "running", by: "x", input: { id: "", text: "p", budgetUsd: 1 } as never });
    Pre.fail(failed.id, "boom", 0.4);
    Pre.createRun({ root, moment: "manual", state: "running", by: "x", input: { id: "", text: "p", budgetUsd: 2 } as never });
    expect(Pre.preflightCostSince(0) - base).toBeCloseTo(0.5 + 0.4 + 2, 5);
  });

  test("doneFindings answers for a finished run only", () => {
    const id = done([finding("f1", "blocker", null)]);
    expect(Pre.doneFindings(id)).toEqual([finding("f1", "blocker", null)]);
    const running = Pre.createRun({ root, moment: "manual", state: "running", by: "x", input: { id: "", text: "p" } as never });
    expect(Pre.doneFindings(running.id)).toEqual([]);
    expect(Pre.doneFindings("pf_missing")).toEqual([]);
  });

  test("stopReason reads the same answers from the findings read", () => {
    const plan = Plans.createPlan({ root, title: "acme thing", request: "r", visual: false });
    const at = (runId: string) => { db.query(`UPDATE flight_plan SET plan_md = ?, state = 'ready', preflight_run_id = ? WHERE id = ?`).run("## Step\nTouch web/src/thing.tsx.\n", runId, plan.id); return Plans.getPlan(plan.id)!; };
    expect(Flight.stopReason(at(done([finding("f1", "minor", "ask")])))).toBe("ask-finding");
    expect(Flight.stopReason(at(done([finding("f1", "blocker", "fix")])))).toBeNull();
  });
});
