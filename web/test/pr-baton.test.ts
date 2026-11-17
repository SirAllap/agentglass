import { describe, expect, it } from "bun:test";
import { baton, LANE_ORDER, visibleLanes } from "../../shared/prBaton.ts";
import { LANES } from "../../shared/prLanes.ts";

const checks = (pending: number) => ({ total: 4, success: 4 - pending, failure: 0, pending, skipped: 0 });

describe("lane order", () => {
  it("matches the lane table, needs-you first", () => {
    expect([...LANE_ORDER]).toEqual(LANES.map((l) => l.id));
    expect(LANE_ORDER[0]).toBe("review");
  });
  it("folds Waiting on someone else away when empty, keeps the rest", () => {
    expect(visibleLanes({ review: 0 })).toEqual(["review", "land", "blocked", "flight"]);
    expect(visibleLanes({ others: 2 })).toContain("others");
  });
});

describe("who waits on whom", () => {
  const p = { checks: checks(0), mergeable: "MERGEABLE" } as never;
  it("review lane is yours", () => expect(baton(p, { lane: "review" })).toEqual({ step: "review", tone: "you", holder: "you" }));
  it("land lane is the merge press, done", () => expect(baton(p, { lane: "land" }).step).toBe("merge"));
  it("blocked is stuck on checks", () => expect(baton(p, { lane: "blocked" }).tone).toBe("stuck"));
  it("others waits on a person", () => expect(baton(p, { lane: "others" }).holder).toBe("other"));
  it("flight with checks running waits on checks", () => {
    expect(baton({ checks: checks(2), mergeable: "MERGEABLE" } as never, { lane: "flight" })).toEqual({ step: "checks", tone: "waiting", holder: "other" });
  });
});
