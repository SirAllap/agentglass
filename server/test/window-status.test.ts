/*
 * The order a window's panes, a folded group's windows and the switcher's rows
 * are ranked by. A question outranks an error, an error outranks work, and a
 * window with no agent at all ranks after every window that has one.
 */
import { describe, expect, test } from "bun:test";
import { STATUS_ORDER, statusRank, worstStatus } from "../../shared/windowStatus.ts";

describe("worstStatus", () => {
  test("a question three panes deep is the window's status", () => {
    expect(worstStatus(["working", "idle", "waiting"])).toBe("waiting");
  });

  test("an error outranks work and a finish", () => {
    expect(worstStatus(["done", "working", "error"])).toBe("error");
  });

  test("panes without an agent do not count", () => {
    expect(worstStatus([undefined, "idle", undefined])).toBe("idle");
    expect(worstStatus([undefined, null])).toBeUndefined();
    expect(worstStatus([])).toBeUndefined();
  });
});

describe("statusRank", () => {
  test("follows STATUS_ORDER, with no status last", () => {
    const ranks = STATUS_ORDER.map(statusRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(statusRank(undefined)).toBeGreaterThan(statusRank("idle"));
  });
});
