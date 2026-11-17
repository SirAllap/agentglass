/** The move confirmation's decisions: who can go, who cannot and why, the grouping, the words. */
import { describe, expect, test } from "bun:test";
import { confirmSub, confirmTitle, moveButtonLabel, planMove, progressLine, resultToast, runDone, skippedStep, toastHolds, type MoveItem, type RunRow } from "../src/components/jira/list/moveConfirmModel.ts";
import type { MoveFacts } from "../src/components/jira/list/menus/menuModel.ts";

const it = (n: number, from: string): MoveItem => ({ id: `id${n}`, key: `ORBIT-${n}`, title: `Card ${n}`, from });
const items = [it(131, "Pre QA"), it(132, "Pre QA"), it(134, "Ready for QA"), it(135, "In development")];
const can: MoveFacts = { to: [{ status: "QA complete", asks: false, key: "31" }] };
const facts = new Map<string, MoveFacts>([
  ["id131", can], ["id132", can], ["id134", can],
  ["id135", { to: [{ status: "Code review", asks: false, key: "5" }] }],
]);

describe("planMove", () => {
  const p = planMove(items, facts, "QA complete");
  test("groups movable cards by where they stand, first seen first", () => {
    expect(p.groups.map((g) => [g.from, g.items.map((x) => x.key)])).toEqual([["Pre QA", ["ORBIT-131", "ORBIT-132"]], ["Ready for QA", ["ORBIT-134"]]]);
    expect(p.movable.length).toBe(3);
  });
  test("a card with no step is shown with the reason, not dropped", () => {
    expect(p.blocked.map((b) => [b.key, b.reason])).toEqual([["ORBIT-135", "No step to QA complete"]]);
  });
  test("a step that asks for details cannot be made here; unread or errored facts block", () => {
    const q = planMove([it(1, "A"), it(2, "A"), it(3, "A")], new Map<string, MoveFacts>([["id1", { to: [{ status: "B", asks: true, key: "1" }] }], ["id2", { error: "Jira is down" }]]), "B");
    expect(q.movable).toEqual([]);
    expect(q.blocked.map((b) => b.reason)).toEqual(["Needs details — use Move to…", "Jira is down", "Reading the steps…"]);
  });
});

describe("words", () => {
  test("titles name the status in upper case", () => {
    expect(confirmTitle(1, "QA complete", "ORBIT-131")).toBe("Move ORBIT-131 to QA COMPLETE?");
    expect(confirmTitle(5, "QA complete", "")).toBe("Move 5 cards to QA COMPLETE?");
  });
  test("the button counts what really moves", () => {
    expect(moveButtonLabel(1)).toBe("Move");
    expect(moveButtonLabel(4)).toBe("Move 4 cards");
    expect(confirmSub(planMove(items, facts, "QA complete"))).toBe("3 can move · 1 cannot. This writes to your Jira site.");
  });
  test("skippedStep names the next flow step only when the move goes past it", () => {
    expect(skippedStep("Ready for QA", "QA complete")).toBe("Ready for QA");
    expect(skippedStep("QA complete", "QA complete")).toBeNull();
    expect(skippedStep(null, "QA complete")).toBeNull();
  });
});

describe("run and toast", () => {
  const rows: RunRow[] = [{ phase: "moved" }, { phase: "moved" }, { phase: "moving" }, { phase: "failed", reason: "Resolution is required." }];
  test("progress line skips zeros and is not done while one is moving", () => {
    expect(progressLine(rows)).toBe("2 moved · 1 moving · 1 failed");
    expect(runDone(rows)).toBe(false);
  });
  test("toast: counts moved of all, names failures, holds when any failed", () => {
    const done: RunRow[] = [{ phase: "moved" }, { phase: "moved" }, { phase: "moved" }, { phase: "moved" }, { phase: "failed" }];
    expect(runDone(done)).toBe(true);
    expect(resultToast(done)).toBe("Moved 4 of 5 · 1 failed");
    expect(toastHolds(done)).toBe(true);
    expect(resultToast([{ phase: "moved" }, { phase: "moved" }])).toBe("Moved 2");
    expect(toastHolds([{ phase: "moved" }])).toBe(false);
  });
});
