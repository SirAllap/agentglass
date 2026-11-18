/*
 * `GET /flight-plan/plans` reads the budget once and hands it to stopReason for
 * every plan. Each budget read sums the week's Preflight runs, and the list used
 * to read it once per plan: 200 plans with 10 runs each took ~7.9 s on a
 * synthetic database, 688 ms of main-thread CPU on a real one. The budget's own
 * launched-plan read takes the root and the launch record, never the plan text.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REAL_XDG = process.env.XDG_CONFIG_HOME;
const HOME = mkdtempSync(join(tmpdir(), "agx-fp-budget-"));
process.env.XDG_CONFIG_HOME = HOME;
const Flight = await import("../src/flightPlan.ts");
const Plans = await import("../src/flightPlanStore.ts");
const Budget = await import("../src/flightBudget.ts");
const { db } = await import("../src/db.ts");

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  if (REAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = REAL_XDG;
});

const root = join(HOME, "orbit");
const plan = Plans.createPlan({ root, title: "acme thing", request: "r", visual: false });
db.query(`UPDATE flight_plan SET plan_md = ?, state = 'ready' WHERE id = ?`).run("## Step\nTouch web/src/thing.tsx.\n", plan.id);

describe("the plan list's budget read", () => {
  test("stopReason answers from the budget it is given, not from the books", () => {
    const p = Plans.getPlan(plan.id)!;
    expect(Budget.budgetState().reached).toBeNull();
    expect(Flight.stopReason(p)).toBeNull();
    const reached = { ...Budget.budgetState(), reached: "daily" as const };
    expect(Flight.stopReason(p, Date.now(), false, reached)).toBe("budget");
  });

  test("the budget's launched-plan read carries no plan text", () => {
    db.query(`UPDATE flight_plan SET state = 'go' WHERE id = ?`).run(plan.id);
    Plans.markLaunched(plan.id, { branch: "flight-plan/acme", worktree: join(HOME, "wt") });
    // Plans another file launched in the shared database are not this one's.
    const rows = Plans.launchedWhere().filter((r) => r.root === root);
    expect(rows).toEqual([{ root, launched: expect.objectContaining({ worktree: join(HOME, "wt") }) }]);
    expect(Object.keys(rows[0]!)).toEqual(["root", "launched"]);
  });
});
