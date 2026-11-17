import { describe, expect, test } from "bun:test";
import { entryText, sprintStrip } from "../src/components/jira/list/sprintStripModel.ts";
import type { ProviderTask } from "../../shared/providers.ts";

const DAY = 864e5;
const NOW = Date.UTC(2026, 10, 10, 9);
const card = (id: string, sprint: string | null, over: Partial<ProviderTask> = {}) =>
  ({ id, customId: id, sprint, sprintActive: !!sprint, sprintId: sprint ? sprint.replace(/\D/g, "") : undefined, statusKind: "open", ...over }) as ProviderTask;
const known = { id: "4", name: "ORBIT S4", state: "active" as const, start: NOW - 8 * DAY, end: NOW + 6 * DAY, goal: "Ship the launch checklist" };

describe("the sprint strip", () => {
  test("shows nothing unless the view is one running sprint", () => {
    expect(sprintStrip({ cards: [card("ORBIT-1042", "ORBIT S4")], known, on: false, now: NOW }).entries).toEqual([]);
  });
  test("one sprint: name, days left, cards and points done of total", () => {
    const cards = [card("ORBIT-1042", "ORBIT S4", { statusKind: "done", points: 3 }), card("ORBIT-1043", "ORBIT S4", { points: 5 }), card("ORBIT-1044", null)];
    const s = sprintStrip({ cards, known, on: true, now: NOW });
    expect(s.entries).toHaveLength(1);
    expect(entryText(s.entries[0]!)).toBe("ORBIT S4 · 6 days left · 1/2 cards · 3/8 points");
    expect(s.entries[0]!.goal).toBe("Ship the launch checklist");
  });
  test("no points on the cards: no points figure", () => {
    expect(entryText(sprintStrip({ cards: [card("ORBIT-1042", "ORBIT S4")], known, on: true, now: NOW }).entries[0]!)).toBe("ORBIT S4 · 6 days left · 0/1 cards");
  });
  test("ends today and days over", () => {
    const e = (end: number) => sprintStrip({ cards: [card("ORBIT-1042", "ORBIT S4")], known: { ...known, end }, on: true, now: NOW }).entries[0]!;
    expect(e(NOW).left).toBe("ends today");
    expect(e(NOW - 2 * DAY).left).toBe("2 days over");
    expect(e(NOW - DAY).left).toBe("1 day over");
  });
  test("a sprint the context does not hold is drawn without days or goal", () => {
    const s = sprintStrip({ cards: [card("ACME-7", "ACME S9")], known, on: true, now: NOW });
    expect(s.entries[0]!.left).toBe("");
    expect(entryText(s.entries[0]!)).toBe("ACME S9 · 0/1 cards");
  });
  test("with no board dates, the days left come from the card's own sprint", () => {
    const c = card("ORBIT-1042", "ORBIT S4", { sprintStart: NOW - 8 * DAY, sprintEnd: NOW + 3 * DAY, sprintGoal: "Ship the checklist" });
    const e = sprintStrip({ cards: [c], known: undefined, on: true, now: NOW }).entries[0]!;
    expect(e.left).toBe("3 days left");
    expect(e.goal).toBe("Ship the checklist");
  });
  test("several sprints: biggest first, three at most, then the rest counted", () => {
    const cards = ["S1", "S1", "S1", "S2", "S2", "S3", "S4", "S5"].map((n, i) => card(`ORBIT-${i}`, `ORBIT ${n}`));
    const s = sprintStrip({ cards, known: undefined, on: true, now: NOW });
    expect(s.entries.map((e) => e.name)).toEqual(["ORBIT S1", "ORBIT S2", "ORBIT S3"]);
    expect(s.more).toBe(2);
  });
  test("a card in a closed sprint is not counted", () => {
    expect(sprintStrip({ cards: [card("ORBIT-1", "ORBIT S4", { sprintActive: false })], known, on: true, now: NOW }).entries).toEqual([]);
  });
});
