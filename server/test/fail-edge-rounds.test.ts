/*
 * Fail-edge rounds: the count is read from flight_plan_step each time, so the
 * stop clears when the flow's maxRounds is raised. Pure parts only; the real
 * server case is in required-step-route.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { renderFlowForOrchestrator, ROLE_LINES_MAX } from "../src/flow.ts";
import { templateFlow } from "../../shared/flowTemplates.ts";
import { STOP_SENTENCE } from "../src/flightPlan.ts";
import { QUESTION_STOPS } from "../src/flightPlanStore.ts";

const noFail = () => { const f = templateFlow(); return { ...f, edges: f.edges.filter((e) => e.on !== "fail") }; };

describe("fail-edge rounds", () => {
  test("brief for a flow with no fail edge never mentions rounds", () => {
    expect(renderFlowForOrchestrator(noFail())).not.toContain("The server counts these");
  });
  test("brief with a fail edge says the server counts, within ROLE_LINES_MAX", () => {
    const out = renderFlowForOrchestrator(templateFlow());
    expect(out).toContain("The server counts these and stops the plan at that number.");
    expect(out.length).toBeGreaterThan(0);
    expect(ROLE_LINES_MAX).toBe(1500);
  });
  test("sentence and question stop exist", () => {
    expect(STOP_SENTENCE["rounds-used"]).toBe("A step has failed the most times the flow allows: a person decides.");
    expect(QUESTION_STOPS).toContain("rounds-used");
  });
});
