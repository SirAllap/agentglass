/* One keystroke in the Filters popover on a 600-card board: the model work (names, count, every group's facet counts, sentence, rail summaries) stays small,
 * and the once-per-call reading of "next sprint" and the epic lookup give the same answers as reading them per card. */
import { describe, expect, test } from "bun:test";
import { filterCards, NO_FILTERS, type JiraListFilters } from "../src/components/jira/list/model.ts";
import { facetCounts, GROUPS, railSummary, sentenceParts } from "../src/components/jira/list/filtersV2Model.ts";
import { epicNamesOf } from "../src/components/jira/list/facetsModel.ts";
import { CURRENT, NEXT, NONE, byName, sprintPasses } from "../src/components/jira/list/sprintModel.ts";

const STATUSES = ["Todo", "Doing", "Review", "Done"];
const cards = Array.from({ length: 600 }, (_, i) => {
  const n = i + 1, sub = n % 3 === 0;
  const sp = n % 5;
  return {
    id: `c${n}`, customId: `ORBIT-${n}`, key: `ORBIT-${n}`, title: `Card ${n}`, status: STATUSES[n % 4]!, statusKind: n % 4 === 3 ? "done" : "open",
    tags: [`t${n % 7}`], components: [`comp${n % 4}`], priority: ["high", "low", null][n % 3] ?? null, issueType: sub ? "Sub-task" : "Task",
    assignees: [`u${n % 6}`], assigneeId: `u${n % 6}`, space: `SP${n % 3}`,
    parent: sub ? { key: `ORBIT-${n - 1}`, title: "p" } : n % 4 === 0 ? { key: `EPIC-${n % 9}`, title: `Epic ${n % 9}` } : undefined,
    sprint: sp === 0 ? undefined : `Orbit Sprint ${sp}`, sprintActive: sp === 1, sprintState: sp === 2 ? "closed" : sp === 1 ? "active" : "future", sprintStart: sp >= 3 ? 1_000_000 * sp : undefined, sprintEnd: 9_000_000,
  };
}) as never[];
const f = (p: Partial<JiraListFilters>): JiraListFilters => ({ ...NO_FILTERS, ...p });
const busy = f({ sprintPick: [NEXT, CURRENT], epicPick: ["EPIC-4", "EPIC-8"], tagPick: ["t1", "t2"], notPick: { sprint: [NEXT], epic: ["EPIC-0"] }, query: "card" });
const src = { cards, statuses: STATUSES.map((s) => ({ status: s, type: s === "Done" ? "done" : "open" })) as never, tags: ["t0", "t1", "t2"], team: [] };

function keystroke(filters: JiraListFilters): number {
  const names = { epics: epicNamesOf(cards) };
  const shown = filterCards(cards, filters).length;
  for (const g of GROUPS) { facetCounts(g.id, filters, src); railSummary(filters, g.id, names); }
  sentenceParts(filters, names);
  return shown;
}

describe("filters v2 cost per keystroke, 600 cards, 8 groups", () => {
  test("model work for one keystroke is under 5 ms", () => {
    keystroke(busy); // warm up
    const runs = Array.from({ length: 5 }, () => { const t = performance.now(); keystroke(busy); return performance.now() - t; }).sort((a, b) => a - b);
    const med = runs[2]!;
    console.log(`filters keystroke median ${med.toFixed(1)} ms (runs ${runs.map((r) => r.toFixed(1)).join(", ")})`);
    expect(med).toBeLessThan(5);
  });
  test("next-sprint answers equal the per-card reading", () => {
    const soonest = (all: readonly unknown[]) => {
      const future = (all as { sprint?: string; sprintActive?: boolean; sprintState?: string; sprintStart?: number }[]).filter((t) => t.sprint && !t.sprintActive && t.sprintState !== "closed");
      const min = Math.min(...future.map((t) => t.sprintStart || Infinity));
      return new Set(future.filter((t) => (t.sprintStart || Infinity) === min).map((t) => t.sprint!));
    };
    const soon = soonest(cards);
    for (const pick of [[NEXT], [NEXT, NONE], [CURRENT, byName("Orbit Sprint 2")], []]) {
      for (const t of cards as { sprint?: string; sprintActive?: boolean; sprintState?: string }[]) {
        const k = !t.sprint ? "none" : t.sprintActive ? "active" : t.sprintState === "closed" ? "closed" : "future";
        const want = !pick.length || pick.some((p) => p === CURRENT ? k === "active" : p === NONE ? k === "none" : p === NEXT ? k === "future" && soon.has(t.sprint!) : p === byName(t.sprint ?? "\0"));
        expect(sprintPasses(t as never, pick, cards)).toBe(want);
      }
    }
  });
  test("a changed card list is read again, not remembered", () => {
    const early = cards.map((t) => ({ ...(t as object), sprintStart: 5 })) as never[];
    expect(sprintPasses(cards.find((t) => (t as { sprint?: string }).sprint === "Orbit Sprint 3")!, [NEXT], cards)).toBe(true);
    expect(sprintPasses(cards.find((t) => (t as { sprint?: string }).sprint === "Orbit Sprint 3")!, [NEXT], early)).toBe(true);
    expect(sprintPasses(cards.find((t) => (t as { sprint?: string }).sprint === "Orbit Sprint 4")!, [NEXT], cards)).toBe(false);
  });
});
