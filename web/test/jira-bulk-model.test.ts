/* The bulk sheet's decisions: who is skipped, the sentence, and the per-card fold. Cards are invented. */
import { describe, expect, test } from "bun:test";
import { alreadyThere, bulkSentence, failedKeys, foldResults, planBulk, runLine, type BulkCard } from "../src/components/jira/list/bulkModel.ts";

const card = (n: number, over: Partial<BulkCard> = {}): BulkCard => ({ key: `ORBIT-${n}`, title: `Thing ${n}`, ...over });
const SPRINT = { kind: "sprint", value: "12", label: "Orbit Sprint 12" } as const;

describe("planBulk", () => {
  test("cards already in the sprint are skipped", () => {
    const p = planBulk([card(1042, { sprintId: "12" }), card(1043, { sprintId: "11" }), card(1044, { sprintId: null })], SPRINT);
    expect(p.skip.map((c) => c.key)).toEqual(["ORBIT-1042"]);
    expect(p.change.map((c) => c.key)).toEqual(["ORBIT-1043", "ORBIT-1044"]);
  });
  test("a card of unknown state is not skipped", () => {
    expect(alreadyThere(card(1045), { kind: "assignee", value: "acct-1" })).toBe(false);
    expect(alreadyThere(card(1045), { kind: "flag", value: true })).toBe(false);
  });
  test("labels: skip only when all adds are there and no removes are", () => {
    const ask = { kind: "labels" as const, add: ["a"], remove: ["b"] };
    expect(alreadyThere(card(1, { labels: ["a"] }), ask)).toBe(true);
    expect(alreadyThere(card(1, { labels: ["a", "b"] }), ask)).toBe(false);
    expect(alreadyThere(card(1, { labels: [] }), ask)).toBe(false);
  });
  test("more than 50 cards to change is flagged", () => {
    const many = Array.from({ length: 51 }, (_, i) => card(2000 + i));
    expect(planBulk(many, SPRINT).tooMany).toBe(true);
    expect(planBulk(many.slice(0, 50), SPRINT).tooMany).toBe(false);
  });
});

describe("bulkSentence", () => {
  test("says the change in one sentence", () => {
    expect(bulkSentence(5, SPRINT)).toBe("Move 5 cards to Orbit Sprint 12");
    expect(bulkSentence(1, { kind: "backlog" })).toBe("Move 1 card to the backlog");
    expect(bulkSentence(3, { kind: "assignee", value: null })).toBe("Take the assignee off 3 cards");
    expect(bulkSentence(2, { kind: "flag", value: true })).toBe("Flag 2 cards");
    expect(bulkSentence(2, { kind: "labels", add: ["x"], remove: ["y"] })).toBe("On 2 cards: add x and remove y");
  });
});

describe("foldResults", () => {
  const keys = ["ORBIT-1042", "ORBIT-1043", "ORBIT-1044"];
  test("each card gets its own state and a card the answer forgot is failed", () => {
    const rows = foldResults(keys, [{ key: "ORBIT-1042", ok: true }, { key: "orbit-1043", ok: false, error: "Your Jira account cannot change this card" }]);
    expect(rows["ORBIT-1042"]).toEqual({ s: "done" });
    expect(rows["ORBIT-1043"]).toEqual({ s: "failed", error: "Your Jira account cannot change this card" });
    expect(rows["ORBIT-1044"].s).toBe("failed");
    expect(failedKeys(rows)).toEqual(["ORBIT-1043", "ORBIT-1044"]);
    expect(runLine(rows)).toBe("Changed 1 of 3; 2 failed");
  });
  test("no answer at all fails every card", () => {
    expect(failedKeys(foldResults(keys, undefined)).length).toBe(3);
    expect(runLine(foldResults(keys, undefined))).toBe("Nothing changed: 3 failed");
  });
});
