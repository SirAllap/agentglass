import { describe, expect, test } from "bun:test";
import { runSteps } from "../src/lib/prApplyRun.ts";
import { handOverPlan } from "../src/lib/prHandOver.ts";
import { applyResult, startSteps, type Outcomes } from "../src/lib/prApplyResult.ts";

const plan = handOverPlan({
  mode: "reviewers", author: "dana-r", picked: ["mara-k"], already: [],
  tracker: { kind: "clickup", card: "ORBIT-1042", status: "to do" },
  card: { mirror: false, people: ["Mara K"], status: "in review" },
});
const collect = () => { let out: Outcomes = {}; return { get: () => out, on: (o: Outcomes) => { out = { ...out, ...o }; } }; };

describe("running a plan", () => {
  test("each system gets only its own steps, and all at once", async () => {
    const seen: Record<string, string[]> = {};
    const c = collect();
    await runSteps(plan.steps, plan.steps.map((s) => s.id), {
      github: async (s) => { seen.github = s.map((x) => x.id); return { "gh-reviewers": { state: "ok" } }; },
      clickup: async (s) => { seen.clickup = s.map((x) => x.id); return { "card-assign": { state: "ok" }, "card-status": { state: "ok" } }; },
    }, c.on);
    expect(seen).toEqual({ github: ["gh-reviewers"], clickup: ["card-assign", "card-status"] });
    expect(applyResult(plan, c.get()).phase).toBe("done");
  });

  test("a system reports as soon as it is done, not when the slowest is", async () => {
    const order: string[] = [];
    await runSteps(plan.steps, plan.steps.map((s) => s.id), {
      github: async () => { await new Promise((r) => setTimeout(r, 30)); return { "gh-reviewers": { state: "ok" } }; },
      clickup: async () => ({ "card-assign": { state: "ok" }, "card-status": { state: "ok" } }),
    }, (o) => order.push(Object.keys(o)[0]!));
    expect(order[0]).toBe("card-assign");
  });

  test("a runner that throws fails its steps and nobody else's", async () => {
    const c = collect();
    await runSteps(plan.steps, plan.steps.map((s) => s.id), {
      github: async () => { throw new Error("offline"); },
      clickup: async () => ({ "card-assign": { state: "ok" }, "card-status": { state: "ok" } }),
    }, c.on);
    const r = applyResult(plan, c.get());
    expect(r.phase).toBe("partial");
    expect(r.rows.map((x) => [x.label, x.state])).toEqual([["GitHub", "fail"], ["ClickUp", "ok"]]);
  });

  test("a step the runner did not answer for did not pass", async () => {
    const c = collect();
    await runSteps(plan.steps, plan.steps.map((s) => s.id), {
      github: async () => ({ "gh-reviewers": { state: "ok" } }),
      clickup: async () => ({ "card-assign": { state: "ok" } }),
    }, c.on);
    expect(applyResult(plan, c.get()).retry).toEqual(["card-status"]);
  });

  test("a retry sends only the failed set; what passed is not sent again", async () => {
    let out: Outcomes = { "gh-reviewers": { state: "ok" }, "card-assign": { state: "fail" }, "card-status": { state: "fail" } };
    const sent: string[] = [];
    const retry = applyResult(plan, out).retry;
    out = startSteps(out, retry);
    await runSteps(plan.steps, retry, {
      github: async () => { sent.push("github"); return {}; },
      clickup: async (s) => { sent.push(...s.map((x) => x.id)); return Object.fromEntries(s.map((x) => [x.id, { state: "ok" as const }])); },
    }, (o) => { out = { ...out, ...o }; });
    expect(sent).toEqual(["card-assign", "card-status"]);
    expect(applyResult(plan, out).phase).toBe("done");
  });
});
