/*
 * `GET /flight-plan/plans` asks two things of each plan's text: the model its
 * builder starts on (builderLaunch) and whether it stops for the person
 * (stopReason). Both read sensitiveHit, and the scan took ~125 ms on a 67 KB
 * plan, so the list scanned every plan twice. Now it scans a plan's text once
 * and an unchanged plan is never scanned again.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REAL_XDG = process.env.XDG_CONFIG_HOME;
const HOME = mkdtempSync(join(tmpdir(), "agx-fp-sensitive-"));
process.env.XDG_CONFIG_HOME = HOME;
const Flight = await import("../src/flightPlan.ts");
const Plans = await import("../src/flightPlanStore.ts");
const Store = await import("../src/preflightStore.ts");
const Model = await import("../../shared/builderModel.ts");
const { db } = await import("../src/db.ts");

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  if (REAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = REAL_XDG;
});

const root = join(HOME, "orbit");
Store.putSetting(root, "flightPlan.autopilot.askOnSensitive", true);
const role = { provider: "claude", model: "sonnet" };
const texts = ["## Step\nTouch web/src/thing.tsx.\n", "## Step\nEdit server/src/auth/token.ts.\n"];
const ids = texts.map((md, i) => {
  const p = Plans.createPlan({ root, title: `acme thing ${i}`, request: "r", visual: false });
  db.query(`UPDATE flight_plan SET plan_md = ?, size = 'M', state = 'ready' WHERE id = ?`).run(md, p.id);
  return p.id;
});

/** What the list asks of each plan before launch, and nothing else. */
const list = () => ids.map((id) => {
  const { planMd, ...rest } = Plans.getPlan(id)!;
  return { launch: Flight.builderLaunch({ id: rest.id, size: rest.size, planMd }, role, "auto", "opus"), stop: Flight.stopReason({ planMd, ...rest }) };
});

describe("the plan list's sensitive-path scan", () => {
  test("once per plan on the first list, never on a second list with no change, again after an edit", () => {
    const scan = spyOn(Model, "sensitiveHit");
    const first = list();
    expect(scan).toHaveBeenCalledTimes(ids.length);
    expect(first.map((r) => r.stop)).toEqual([null, "sensitive"]);
    expect(first.map((r) => r.launch.model)).toEqual(["sonnet", "opus"]);

    scan.mockClear();
    expect(list()).toEqual(first);
    expect(scan).toHaveBeenCalledTimes(0);

    db.query(`UPDATE flight_plan SET plan_md = ? WHERE id = ?`).run("## Step\nTouch web/src/other.tsx.\n", ids[1]);
    scan.mockClear();
    expect(list().map((r) => r.stop)).toEqual([null, null]);
    expect(scan).toHaveBeenCalledTimes(1);
    scan.mockRestore();
  });

  test("same verdict as the scan itself", () => {
    for (const md of [...texts, "## Risks\nA new package.\n", "plain\n"]) expect(Flight.planSensitiveHit({ id: "x-" + md, planMd: md })).toBe(Model.sensitiveHit(md));
    expect(Flight.planSensitiveHit({ planMd: "see migrations/0042_orbit_ledger.py" })).toBe("migrations/0042_orbit_ledger.py");
  });
});
