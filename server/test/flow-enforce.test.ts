import { describe, expect, test } from "bun:test";
import { flowHold, predecessorOf, reportSaysDone } from "../../shared/flowEnforce.ts";
import { markDone, doneRoles, holdFor, clearTask } from "../src/flowDone.ts";
import { putSetting } from "../src/preflightStore.ts";

const flow: { path: string[]; roster: { id: string; name: string }[] } = {
  path: ["build", "review", "verify"],
  roster: [{ id: "build", name: "Builder" }, { id: "review", name: "Reviewer" }, { id: "verify", name: "Verifier" }, { id: "scout", name: "Scout" }],
};

describe("flowHold", () => {
  test("the first role is never held", () => expect(flowHold(flow as never, "build", new Set())).toBeNull());
  test("a role off the path is never held", () => expect(flowHold(flow as never, "scout", new Set())).toBeNull());
  test("a role is held until the step before it is done", () => {
    const h = flowHold(flow as never, "review", new Set());
    expect(h?.missing).toBe("build");
    expect(h?.why).toContain("Builder has not reported done");
    expect(h?.why).toContain("Settings > Flow & review");
  });
  test("the step before done lets it through", () => expect(flowHold(flow as never, "review", new Set(["build"]))).toBeNull());
  test("only the step right before counts", () => expect(flowHold(flow as never, "verify", new Set(["build"]))?.missing).toBe("review"));
  test("predecessorOf", () => { expect(predecessorOf(flow.path, "verify")).toBe("review"); expect(predecessorOf(flow.path, "build")).toBeNull(); });
});

describe("reportSaysDone", () => {
  test("done opens the state line", () => { expect(reportSaysDone("Done: ORBIT-1042 built")).toBe(true); expect(reportSaysDone("hecho")).toBe(true); });
  test("a status that is not done does not count", () => { expect(reportSaysDone("working on it")).toBe(false); expect(reportSaysDone("not done yet")).toBe(false); expect(reportSaysDone("")).toBe(false); });
});

describe("holdFor with the stored record", () => {
  const ROOT = "/tmp/orbit-flow-enforce";
  test("off: nothing is held", () => {
    putSetting(ROOT, "flow.enforce", false);
    expect(holdFor(ROOT, "builder", "/wt/orbit-1042")).toBeNull();
  });
  test("done is kept per task", () => {
    markDone(ROOT, "/wt/orbit-1042", "builder");
    expect([...doneRoles(ROOT, "/wt/orbit-1042")]).toEqual(["builder"]);
    expect(doneRoles(ROOT, "/wt/orbit-9").size).toBe(0);
  });
  test("on: held until the predecessor's done is recorded, then let by (own template flow)", () => {
    putSetting(ROOT, "flow.enforce", true);
    const r = "/wt/orbit-2001";
    const first = holdFor(ROOT, "builder", r);
    expect(first?.missing).toBe("planner");
    markDone(ROOT, r, first!.missing);
    expect(holdFor(ROOT, "builder", r)).toBeNull();
    putSetting(ROOT, "flow.enforce", false);
  });
  test("clearTask forgets a removed worktree's done, so a later card there is held again", () => {
    markDone(ROOT, "/wt/orbit-2000", "builder");
    clearTask("/wt/orbit-2000");
    expect(doneRoles(ROOT, "/wt/orbit-2000").size).toBe(0);
  });
  test("no role, no root: nothing is held", () => { expect(holdFor(undefined, "x", "t")).toBeNull(); expect(holdFor(ROOT, undefined, "t")).toBeNull(); });
});
