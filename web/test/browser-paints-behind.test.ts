import { describe, expect, test } from "bun:test";
import { paintsBehind, tabState, type TabAgent } from "../src/lib/browserAgentActivity.ts";

/* A background tab painted behind the front one costs a renderer's frames; a
   hidden one costs none. Only an agent mid-task needs the frames. */
describe("paintsBehind", () => {
  const agent = (over: Partial<TabAgent>): TabAgent => ({ agent: "a", working: 0, paused: false, log: [], ...over });

  test("an agent acting on the tab keeps it painted", () => {
    expect(paintsBehind(tabState(agent({ working: 1, op: "click" }), undefined, Date.now())?.key)).toBe(true);
  });

  test("a handoff hides the background tab, however long it waits", () => {
    const old = Date.now() - 60 * 60_000;
    const a = agent({ handoff: true, lastAt: old });
    expect(tabState(a, undefined, Date.now())?.key).toBe("handoff");
    expect(paintsBehind(tabState(a, undefined, Date.now())?.key)).toBe(false);
  });

  test("taken over, done, waiting and no agent are hidden", () => {
    for (const k of ["yours", "done", "waiting", undefined] as const) expect(paintsBehind(k)).toBe(false);
  });
});
