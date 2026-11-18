import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { INSPECT_ROWS } from "../src/components/settings/pages/inspectRows.ts";
import { CLEANUP_ROWS, FLIGHT_PLAN_ROWS, POLARIS_ROWS, SEAT_ROWS, STORED_ROWS, TRACKER_ROWS } from "../src/components/orchestration/doorSpecs.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const pane = read("../src/components/orchestration/OrchestrationPane.tsx");
const later = read("../src/components/settings/pages/later.tsx");

describe("lot 6: door keys keep exactly one home", () => {
  const all = [FLIGHT_PLAN_ROWS, CLEANUP_ROWS, SEAT_ROWS, TRACKER_ROWS, STORED_ROWS, POLARIS_ROWS].flat().map((r) => r.id);
  test("no key is listed twice", () => { expect(new Set(all).size).toBe(all.length); });
  test("flight plan has its 18 keys (the plan said 20)", () => { expect(FLIGHT_PLAN_ROWS.length).toBe(18); });
  test("the four agents.role keys live on the engine row a person uses, not on Inspect or a stored shape", () => {
    expect(INSPECT_ROWS.some((r) => r.id.startsWith("agents.role."))).toBe(false);
    expect(STORED_ROWS.some((r) => r.id.startsWith("agents.role."))).toBe(false);
    expect(read("../src/components/settings/pages/EnginesUsagePage.tsx")).toContain("settingId={`agents.role.${role}`}");
  });
  test("no door row is drawn as a stored shape: every kind is a typed control", () => {
    for (const r of [FLIGHT_PLAN_ROWS, CLEANUP_ROWS, SEAT_ROWS, TRACKER_ROWS, STORED_ROWS, POLARIS_ROWS].flat()) expect(["bool", "choice", "number", "text", "list"]).toContain(r.kind);
  });
  test("the seat keys bind to the real stored ones", () => {
    expect(SEAT_ROWS.map((r) => r.id)).toEqual(["seat.kind", "seat.model", "seat.powers", "seat.change"]);
  });
});

describe("lot 6: where each group is drawn", () => {
  test("Flow & review no longer draws the door cards", () => {
    for (const n of ["FLIGHT_PLAN_ROWS", "CLEANUP_ROWS", "TRACKER_ROWS"]) expect(pane.includes(`specs={${n}}`)).toBe(false);
  });
  test("Roles & limits draws the limits once, through the Workers page", () => {
    expect(pane.split("specs={STORED_ROWS}").length - 1).toBe(1);
    expect(pane.split("<EnvLimitsCard").length - 1).toBe(1);
    // The memory row and the limits are rows of the new Workers page, drawn once by it.
    expect(pane.split("<WorkersPage").length - 1).toBe(1);
    expect(readFileSync(new URL("../src/components/settings/pages/WorkersPage.tsx", import.meta.url).pathname, "utf8").split("<MemoryRow").length - 1).toBe(1);
  });
  test("Flow & review draws the seat, flow and tuning rows once, through its own page; Polaris rows live on the Polaris page", () => {
    expect(pane.split("<FlowReviewPage").length - 1).toBe(1);
    const page = readFileSync(new URL("../src/components/settings/pages/FlowReviewPage.tsx", import.meta.url).pathname, "utf8");
    for (const n of ["FLOW", "SEAT", "TUNING"]) expect(page.split(`specs={${n}}`).length - 1).toBe(1);
    const pol = readFileSync(new URL("../src/components/settings/pages/PolarisPage.tsx", import.meta.url).pathname, "utf8");
    expect(pol.split("specs={POLARIS}").length - 1).toBe(1);
  });
  test("workers and fplan pages render the split parts", () => {
    expect(later).toContain('part="limits"');
    expect(later).toContain("<FlightPlanSettings />");
  });
});

describe("lot 6: search reaches every door key, on the page that draws it", () => {
  const gen = read("../src/lib/settingsRows.gen.ts");
  const rowsOf = (paneId: string) => gen.split("\n").filter((l) => l.startsWith(`  { pane: "${paneId}",`));
  const has = (paneId: string, id: string) => rowsOf(paneId).some((l) => l.includes(`settingId: "${id}"`));
  test("every key the door cards draw is in the generated index", () => {
    for (const r of [...FLIGHT_PLAN_ROWS, ...STORED_ROWS, ...INSPECT_ROWS]) expect(gen.includes(`settingId: "${r.id}"`)).toBe(true);
    for (const r of SEAT_ROWS) expect(gen.includes(`settingId: "${r.id}"`)).toBe(true);
  });
  test("flight plan keys are on fplan, roles and stored keys on workers, seat keys on Flow & review", () => {
    for (const r of FLIGHT_PLAN_ROWS) expect(has("fplan", r.id)).toBe(true);
    for (const r of STORED_ROWS) expect(has("workers", r.id)).toBe(true);
    for (const r of INSPECT_ROWS.filter((x) => x.id.startsWith("agents.role."))) expect(has("inspect", r.id)).toBe(true);
    for (const r of SEAT_ROWS) expect(has("orchestration", r.id)).toBe(true);
  });
  test("Roles & limits indexes only what it draws: no review, rule or session-start rows", () => {
    const labels = rowsOf("workers").join("\n");
    for (const gone of ["Who reviews and checks", "Conditions", "Notify the project lead", "Auto-continue"]) expect(labels.includes(`label: "${gone}`)).toBe(false);
    for (const here of ["Minutes per turn", "Review rounds", "Workers at once", "Forget worker roles"]) expect(labels.includes(`label: "${here}"`)).toBe(true);
  });
  test("the limits part is indexed on workers only, not again on Flow & review", () => {
    expect(rowsOf("orchestration").join("\n").includes('label: "Minutes per turn"')).toBe(false);
  });
});
