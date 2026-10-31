/*
 * What the Jira list pane draws from one read: which cards the page holds (the board, an open epic, the sprint), which
 * of them the filters keep, and the lanes and counts. Pure rules, run here without a renderer.
 */
import { describe, expect, test } from "bun:test";
import type { ListStatus, ProviderTask } from "../../shared/providers.ts";
import { NO_FILTERS, filterCards, laneCounts, lanesOf, lookedModel, pageCards } from "../src/components/jira/list/model.ts";

const st = (status: string, i: number, type: ListStatus["type"] = "open"): ListStatus => ({ status, type, orderindex: i });
const card = (id: string, status: string, o: Partial<ProviderTask> = {}): ProviderTask =>
  ({ id, customId: `ORB-${id}`, title: `Card ${id}`, status, statusKind: "open", assignees: [], tags: [], ...o } as ProviderTask);

const STATUSES = [st("To do", 0), st("In progress", 1), st("Review", 2), st("Done", 3, "done")];
const CARDS = [
  card("1", "To do", { parent: { key: "ORB-9", title: "Checkout" } as ProviderTask["parent"], mine: true, order: "a" }),
  card("2", "In progress", { tags: ["web"], sprint: "Sprint 4", order: "b" }),
  card("3", "In progress", { parent: { key: "ORB-9", title: "Checkout" } as ProviderTask["parent"], sprint: "Sprint 4", order: "a" }),
  card("4", "Done", { statusKind: "done", mine: true }),
];

describe("the cards of the page", () => {
  test("the whole view, an epic's cards, or the sprint's", () => {
    const base = { tasks: CARDS, areaTasks: CARDS, sprintName: "Sprint 4" };
    expect(pageCards({ ...base, areaId: null }).map((t) => t.id)).toEqual(["1", "2", "3", "4"]);
    expect(pageCards({ ...base, areaId: "ORB-9" }).map((t) => t.id)).toEqual(["1", "3"]);
    expect(pageCards({ ...base, areaId: "@sprints" }).map((t) => t.id)).toEqual(["2", "3"]);
  });

  test("an epic whose read has not arrived holds nothing, not the whole board", () => {
    expect(pageCards({ tasks: CARDS, areaTasks: undefined, sprintName: undefined, areaId: "ORB-9" })).toEqual([]);
  });

  test("a card the pane changed wins over the read", () => {
    const moved = card("2", "Review");
    expect(pageCards({ tasks: CARDS, areaTasks: undefined, sprintName: undefined, areaId: null, over: { "2": moved } })[1]).toBe(moved);
  });
});

describe("the filters", () => {
  test("finished work is hidden unless asked for, or a status is picked", () => {
    expect(filterCards(CARDS, NO_FILTERS).map((t) => t.id)).toEqual(["1", "2", "3"]);
    expect(filterCards(CARDS, { ...NO_FILTERS, showDone: true })).toHaveLength(4);
    expect(filterCards(CARDS, { ...NO_FILTERS, statusPick: ["Done"] }).map((t) => t.id)).toEqual(["4"]);
  });

  test("assigned to me, a label and the text narrow what is left", () => {
    expect(filterCards(CARDS, { ...NO_FILTERS, showDone: true, mineOnly: true }).map((t) => t.id)).toEqual(["1", "4"]);
    expect(filterCards(CARDS, { ...NO_FILTERS, tag: "web" }).map((t) => t.id)).toEqual(["2"]);
    expect(filterCards(CARDS, { ...NO_FILTERS, query: "card 3" }).map((t) => t.id)).toEqual(["3"]);
  });
});

describe("lanes and counts", () => {
  test("a lane per status in the workflow's order, empty ones kept, cards in the site's rank", () => {
    const lanes = lanesOf(filterCards(CARDS, NO_FILTERS), STATUSES);
    expect(lanes.map((l) => l.status)).toEqual(["To do", "In progress", "Review", "Done"]);
    expect(lanes[1]!.cards.map((t) => t.id)).toEqual(["3", "2"]); // "a" before "b"
    expect(lanes[2]!.cards).toEqual([]);
    expect(lanes[3]!.done).toBe(true);
  });

  test("counts are over the whole page, not over what the filters left", () => {
    expect(laneCounts(CARDS, 3)).toMatchObject({ total: 4, shown: 3, open: 3, done: 1, mine: 1 });
  });
});

describe("Looked up", () => {
  const model = { phase: "ready", cards: CARDS, lanes: lanesOf(CARDS, STATUSES), counts: laneCounts(CARDS, 4), assigned: true } as Parameters<typeof lookedModel>[0];
  test("the cards found by id are one flat lane, whatever the view says and whatever the filters keep", () => {
    const m = lookedModel(model, [CARDS[3]!, CARDS[0]!]);
    expect(m.lanes.map((l) => [l.status, l.cards.map((t) => t.id), l.flat, l.folded])).toEqual([["Looked up", ["4", "1"], true, false]]);
    expect(m.cards.length).toBe(2);
    expect([m.counts.total, m.counts.shown, m.phase, m.assigned]).toEqual([2, 2, "ready", false]);
  });
  test("with none it is empty, not the view's lanes", () => {
    expect(lookedModel(model, []).phase).toBe("empty");
  });
});
