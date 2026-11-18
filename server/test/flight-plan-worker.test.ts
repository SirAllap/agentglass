/*
 * A plan built by a worker that is not a Claude tab: the project's builder
 * chain decides, Launch starts the worker through the policy, and the plan's
 * `worker` link is what the view follows (working, then ended).
 * The route itself opens no window here: what it would start is read from the
 * source, and the state of a link is a pure function.
 */
import { describe, expect, test } from "bun:test";
import { alreadyBuilding, workerPhase } from "../src/flightPlan.ts";

const index = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
const launch = (() => {
  const start = index.indexOf("async function launchFlightPlan(");
  return index.slice(start, index.indexOf("\n}\n", start));
})();

describe("what a linked worker is doing", () => {
  const rows = [
    { name: "fp-orbit-search", endedAt: null },
    { name: "fp-orbit-export", endedAt: 1_700_000_000_000 },
  ];
  test("a live row is working, a finished one ended", () => {
    expect(workerPhase("fp-orbit-search", rows)).toBe("working");
    expect(workerPhase("fp-orbit-export", rows)).toBe("ended");
  });
  test("no link, or a name this machine never ran, says nothing", () => {
    expect(workerPhase(null, rows)).toBeNull();
    expect(workerPhase(undefined, rows)).toBeNull();
    expect(workerPhase("", rows)).toBeNull();
    expect(workerPhase("fp-nobody", rows)).toBeNull();
  });
});

describe("Launch starts the builder its project's chain names", () => {
  test("a builder chain that is not Claude starts the worker through the policy, in the plan's own tree, with the plan as its brief", () => {
    expect(launch).toContain("startThroughPolicy(");
    expect(launch).toContain('body: { role: "builder" }');
    expect(launch).toContain("cwd: tree.path");
    expect(launch).toContain("FlightPlan.launchPrompt(plan, coordinator)");
    expect(launch).toContain("FlightPlanStore.setWorker(plan.id, name)");
  });
  test("a Claude chain keeps the tab it always opened", () => {
    expect(launch).toContain('const engine = "claude" as const;');
    expect(launch).toContain("issueArgv(");
    expect(launch).toContain("engineWindowOutcome(");
  });
  test("the engine is asked before a tree is cut, and no longer refused", () => {
    expect(launch.indexOf("builderEngineFor(plan.root)")).toBeGreaterThan(-1);
    expect(launch.indexOf("builderEngineFor(plan.root)")).toBeLessThan(launch.indexOf("flightBase(plan.root)"));
    expect(launch).not.toContain("Launch only starts a Claude builder");
  });
});

describe("Go and Launch never start a second builder", () => {
  test("a ready or Go plan whose linked worker runs is refused with the worker's name", () => {
    expect(alreadyBuilding({ state: "ready", worker: "fp-orbit-search" }, "working")).toBe("a worker is already building this plan: fp-orbit-search");
    expect(alreadyBuilding({ state: "go", worker: "fp-orbit-search" }, "working")).toBe("a worker is already building this plan: fp-orbit-search");
  });
  test("an ended worker, no link, or a draft does not refuse", () => {
    expect(alreadyBuilding({ state: "ready", worker: "fp-orbit-export" }, "ended")).toBeNull();
    expect(alreadyBuilding({ state: "ready", worker: null }, null)).toBeNull();
    expect(alreadyBuilding({ state: "draft", worker: "fp-orbit-search" }, "working")).toBeNull();
  });
  test("Launch and Go both ask before anything is cut", () => {
    expect(launch).toContain("await linkedBuilder(plan)");
    expect(launch.indexOf("await linkedBuilder(plan)")).toBeLessThan(launch.indexOf("flightBase(plan.root)"));
    const go = index.indexOf('if (m[2] === "go") {\n          const busy = await linkedBuilder(plan);');
    expect(go).toBeGreaterThan(-1);
    expect(go).toBeLessThan(index.indexOf("FlightPlanStore.decide(plan.id, m[2]"));
  });
});
