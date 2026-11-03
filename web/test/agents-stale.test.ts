/*
 * WHEN A CLAIM STOPS BEING A CLAIM.
 *
 * The screen this replaced showed three blockers 42 days old under "Waiting on
 * you". The reason was in two lines: the tray lists the eight newest reports
 * with no date filter, and the orphan rule asked only "is the agent still on
 * the field". Nothing read an age. These are the real shapes of that day,
 * with invented names.
 */
import { describe, expect, test } from "bun:test";
import { STALE_AFTER_MS, isStale, staleLine, hiddenLine, isRoutineLine } from "../src/lib/agentsStale.ts";
import { whatWaits } from "../src/lib/seatWaiting.ts";
import type { SeatFieldRow, SeatNeed, SeatReportRow } from "../src/lib/api.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const agent = (name: string, over: Partial<SeatFieldRow> = {}): SeatFieldRow => ({ name, state: "idle", pulse: [], ...over });
const report = (id: number, who: string, at: number, over: Partial<SeatReportRow> = {}): SeatReportRow =>
  ({ id, agent: who, session: "", state: "", blocked: "", need: "", cost: "", raw: "", at, readAt: null, ...over });
const need = (id: string, created: number): SeatNeed =>
  ({ id, root: "/home/a/code/orbit", text: "ask for a reviewer", cost: "", recommend: "", proof: "", created, doneAt: null, outcome: "" });

describe("a week", () => {
  test("the week is the line, to the millisecond", () => {
    expect(isStale(NOW - STALE_AFTER_MS + 1, NOW)).toBe(false);
    expect(isStale(NOW - STALE_AFTER_MS, NOW)).toBe(true);
  });
  test("a stamp from the future, or no stamp, never hides a blocker", () => {
    expect(isStale(NOW + DAY, NOW)).toBe(false);
    expect(isStale(NaN, NOW)).toBe(false);
  });
});

describe("what waits, with an age", () => {
  const field = [agent("scout-2"), agent("docs-4")];
  const old = report(1, "builder-1", NOW - 42 * DAY, { blocked: "the container is down" });
  const fresh = report(2, "docs-4", NOW - 2 * 3_600_000, { need: "a go on the push" });

  test("a 42-day-old blocker from a gone agent is stale, not orphaned", () => {
    const w = whatWaits(field, [old], [], [], 2, NOW);
    expect(w.orphaned).toHaveLength(0);
    expect(w.stale.reports.map((r) => r.id)).toEqual([1]);
    expect(w.count).toBe(0);
  });

  test("a week-old blocker from an agent that is STILL HERE is stale too: being alive does not renew a claim", () => {
    const w = whatWaits(field, [report(3, "docs-4", NOW - 9 * DAY, { blocked: "waiting on CI" })], [], [], 2, NOW);
    expect(w.asked).toHaveLength(0);
    expect(w.stale.reports).toHaveLength(1);
  });

  test("a fresh orphan is still orphaned work: the owner left and nobody is coming back", () => {
    const w = whatWaits(field, [report(4, "builder-1", NOW - 2 * DAY, { blocked: "needs a review" })], [], [], 2, NOW);
    expect(w.orphaned).toHaveLength(1);
    expect(w.stale.reports).toHaveLength(0);
  });

  test("a fresh ask from a live agent waits; an old ask from the orchestrator is stale", () => {
    const w = whatWaits(field, [old, fresh], [], [need("n1", NOW - 3_600_000), need("n2", NOW - 20 * DAY)], 2, NOW);
    expect(w.asked.map((r) => r.id)).toEqual([2]);
    expect(w.ready.map((n) => n.id)).toEqual(["n1"]);
    expect(w.stale.needs.map((n) => n.id)).toEqual(["n2"]);
    expect(w.count).toBe(2);
  });

  test("a report that says nothing is wrong is neither waiting nor stale", () => {
    const w = whatWaits(field, [report(5, "scout-2", NOW - 60 * DAY, { state: "reading" })], [], [], 2, NOW);
    expect(w.stale.reports).toHaveLength(0);
  });
});

describe("the one folded line", () => {
  const reach = (n: string) => n === "docs-4";
  test("counts, oldest in whole days, and which ids a dismissal takes", () => {
    const line = staleLine({
      reports: [report(1, "builder-1", NOW - 42 * DAY), report(2, "tester-6", NOW - 9 * DAY)],
      needs: [need("n2", NOW - 20 * DAY)],
    }, reach, NOW)!;
    expect(line.count).toBe(3);
    expect(line.oldestDays).toBe(42);
    expect(line.agentsGone).toBe(true);
    expect(line.reportIds).toEqual([1, 2]);
    expect(line.needIds).toEqual(["n2"]);
  });
  test("agents are 'gone' only when every one of them is", () => {
    expect(staleLine({ reports: [report(1, "builder-1", NOW - 9 * DAY), report(2, "docs-4", NOW - 9 * DAY)], needs: [] }, reach, NOW)!.agentsGone).toBe(false);
  });
  test("nothing stale is no line at all", () => {
    expect(staleLine({ reports: [], needs: [] }, reach, NOW)).toBeNull();
  });
  test("hidden material: counts from the server, absent when both are zero", () => {
    expect(hiddenLine({ oldReports: 38, routine: 120 })).toEqual({ reports: 38, routine: 120 });
    expect(hiddenLine({ oldReports: 0, routine: 0 })).toBeNull();
    expect(hiddenLine(undefined)).toBeNull();
  });
  test("a routine round is the 'looked, nothing changed' line and only that", () => {
    expect(isRoutineLine("(looked at 15:49 — nothing had changed, so nobody was woken)")).toBe(true);
    expect(isRoutineLine("(looked at 15:49 — the field cleared, so nobody was woken)")).toBe(true);
    expect(isRoutineLine("two upload branches overlap, asked the person")).toBe(false);
    expect(isRoutineLine("(looked at the diff and it is fine)")).toBe(false);
  });
});
