/*
 * The count line equals what the board draws: model, then the person's display prefs, then the changed chip, on a
 * board of 355 cards. Measured: three cards hidden in Display still counted as shown.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderTask } from "../../shared/providers.ts";
import { onlyCards } from "../src/lib/jiraChanged.ts";
import { withPrefs, NO_PREFS } from "../src/components/jira/list/menus/viewPrefs.ts";
import { NO_FILTERS, filterCards, laneCounts, lanesOf, type JiraLane } from "../src/components/jira/list/model.ts";

const card = (n: number, status: string): ProviderTask => ({ id: String(1000 + n), customId: `ORBIT-${n}`, title: `Card ${n}`, status, statusKind: "open", assignees: [], tags: [] } as unknown as ProviderTask);
const many = Array.from({ length: 355 }, (_, i) => card(i + 1, i % 2 ? "Doing" : "To Do"));
const modelOf = (cards: ProviderTask[]) => {
  const shown = filterCards(cards, NO_FILTERS);
  return { cards: shown, lanes: lanesOf(shown, [{ status: "To Do" }, { status: "Doing" }] as never) as JiraLane[], counts: laneCounts(cards, shown.length) };
};
const prefs = (hidden: string[]) => ({ pinned: [], hidden, width: null });

describe("filters composed", () => {
  test("changed chip: one changed card of 355 draws one card, in the lanes and in the count", () => {
    const m = onlyCards(withPrefs(modelOf(many), prefs(["1002"])), (id) => id === "1007");
    expect(m.lanes.flatMap((l) => l.cards)).toHaveLength(1);
    expect(m.counts.shown).toBe(1);
  });
  test("display prefs: the count says what is drawn once cards are hidden", () => {
    const m = withPrefs(modelOf(many), prefs(["1001", "1002", "1003"]));
    expect(m.lanes.flatMap((l) => l.cards)).toHaveLength(352);
    expect(m.counts.shown).toBe(352);
    expect(m.counts.total).toBe(355);
  });
  test("display prefs: no hidden card leaves the model untouched", () => {
    const m = modelOf(many);
    expect(withPrefs(m, NO_PREFS)).toBe(m);
  });
});
