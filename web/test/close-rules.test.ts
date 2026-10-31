import { describe, expect, test } from "bun:test";
import type { TmuxWindow } from "../../shared/types.ts";
import { closeVerdict, closedSentence, reopenPlan } from "../src/lib/closeRules.ts";

const w = (id: string, index: number, over: Partial<TmuxWindow> = {}): TmuxWindow =>
  ({ id, index, name: `w${index}`, active: false, flags: "", ...over });

describe("when a close asks", () => {
  test("a working or waiting agent asks, in words that say it will be stopped", () => {
    const v = closeVerdict([w("@1", 1, { name: "AI01", status: "working" })]);
    expect(v).toEqual({ ask: true, title: "Close AI01?", body: "The agent is working and will be stopped.", stop: "Stop and close" });
    expect(closeVerdict([w("@1", 1, { name: "AI01", status: "waiting" })])).toMatchObject({ body: "The agent is waiting on you and will be stopped." });
  });
  test("a shell, an idle or finished agent, an errored one and a restored one close at once", () => {
    for (const status of [undefined, "idle", "done", "error"] as const) {
      expect(closeVerdict([w("@1", 1, { status })]).ask).toBe(false);
    }
    expect(closeVerdict([w("@1", 1, { restored: true, was: "Claude Code" })]).ask).toBe(false);
  });
  test("close all asks once, with the count, only when one of them is busy", () => {
    const two = [w("@1", 1), w("@2", 2, { status: "working" })];
    expect(closeVerdict(two, "orbit")).toMatchObject({ ask: true, title: "Close 2 windows in orbit?", stop: "Stop and close all" });
    expect(closeVerdict([w("@1", 1), w("@2", 2)], "orbit").ask).toBe(false);
  });
});

describe("the toast's sentence", () => {
  test("names one window, counts several", () => {
    expect(closedSentence([w("@1", 1, { name: "build" })])).toBe("Closed build");
    expect(closedSentence([w("@1", 1, { name: "" })])).toBe("Closed shell");
    expect(closedSentence([w("@1", 1), w("@2", 2)])).toBe("Closed 2 windows");
  });
});

describe("where Reopen puts it back", () => {
  const row = [w("@1", 1), w("@2", 2, { cwd: "/code/orbit" }), w("@3", 3)];
  test("after the window that was before it, in its folder", () => {
    expect(reopenPlan(row, ["@2"])).toEqual([{ name: "w2", cwd: "/code/orbit", anchor: "@1", after: true }]);
  });
  test("before the next one when it was first", () => {
    expect(reopenPlan(row, ["@1"])).toEqual([{ name: "w1", anchor: "@2", after: false }]);
  });
  test("with nothing left standing it still reopens, at the end", () => {
    expect(reopenPlan([w("@1", 1)], ["@1"])).toEqual([{ name: "w1", after: true }]);
  });
  test("several come back in their old order: the last is inserted first", () => {
    const steps = reopenPlan(row, ["@2", "@3"]);
    expect(steps.map((s) => s.name)).toEqual(["w3", "w2"]);
    expect(steps.every((s) => s.anchor === "@1" && s.after)).toBe(true);
  });
  test("nothing to put back for ids that are not windows", () => {
    expect(reopenPlan(row, ["@9"])).toEqual([]);
  });
});
