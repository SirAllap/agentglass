/*
 * What the Jira list pane draws from one read: which cards the page holds (the board, an open epic, the sprint), which
 * of them the filters keep, and the lanes and counts. Pure rules, run here without a renderer.
 */
import { describe, expect, test } from "bun:test";
import { awaitingTabRead } from "../src/components/jira/list/laneModel.ts";
import type { ListStatus, ProviderTask } from "../../shared/providers.ts";
import { NO_FILTERS, filterCards, laneCounts, lanesOf, lookedModel, pageCards, withSiteCards } from "../src/components/jira/list/model.ts";

const st = (status: string, i: number, type: ListStatus["type"] = "open"): ListStatus => ({ status, type, orderindex: i });
const card = (id: string, status: string, o: Partial<ProviderTask> = {}): ProviderTask =>
  ({ id, customId: `ORB-${id}`, title: `Card ${id}`, status, statusKind: "open", assignees: [], tags: [], ...o } as ProviderTask);

const STATUSES = [st("To do", 0), st("In progress", 1), st("Review", 2), st("Done", 3, "done")];
const CARDS = [
  card("1", "To do", { parent: { key: "ORB-9", title: "Checkout" } as ProviderTask["parent"], mine: true, order: "a" }),
  card("2", "In progress", { tags: ["web"], sprint: "Sprint 4", order: "b", assignees: ["acc-2"] }),
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
    expect(filterCards(CARDS, { ...NO_FILTERS, tagPick: ["web"] }).map((t) => t.id)).toEqual(["2"]);
    expect(filterCards(CARDS, { ...NO_FILTERS, query: "card 3" }).map((t) => t.id)).toEqual(["3"]);
  });

  test("Mine and the people chip pressed together is a union: me, or any of them - never both at once", () => {
    // Card 1 and 4 are mine, card 2 is acc-2's, card 3 is neither: picking Mine + acc-2 keeps 1, 2 and 4, not only a card that is both.
    expect(filterCards(CARDS, { ...NO_FILTERS, showDone: true, mineOnly: true, assigneePick: ["acc-2"] }).map((t) => t.id).sort())
      .toEqual(["1", "2", "4"]);
    // The people chip alone still narrows on its own.
    expect(filterCards(CARDS, { ...NO_FILTERS, assigneePick: ["acc-2"] }).map((t) => t.id)).toEqual(["2"]);
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

describe("JQL the site answered", () => {
  // The site's keys were only ever looked up among the cards the board had read (its first 150), so a query whose matches
  // sat past that page showed "0 of 150+ cards" while the site had answered with hundreds.
  test("a card the site matched that the page never read is shown, not dropped", () => {
    const page = [card("1", "To do"), card("2", "To do")];
    const fromSite = [card("2", "To do"), card("900", "Done")];
    const cards = withSiteCards(page, fromSite);
    expect(cards.map((t) => t.id)).toEqual(["1", "2", "900"]);
    const f = { ...NO_FILTERS, query: "component = orbit", site: { q: "component = orbit", keys: ["ORB-2", "ORB-900"] } };
    expect(filterCards(cards, f).map((t) => t.id)).toEqual(["2", "900"]);
  });
  test("a cross view (Team over a personal board) is the site's answer alone, not the board's cards ANDed in", () => {
    const board = [card("1", "To do")];
    const team = [card("2", "To do"), card("3", "To do")];
    expect(withSiteCards(board, team, true).map((t) => t.id)).toEqual(["2", "3"]);
  });
  test("with no site answer the page is the page", () => {
    const page = [card("1", "To do")];
    expect(withSiteCards(page, undefined)).toBe(page);
  });
});

describe("awaitingTabRead", () => {
  test("a tab whose site answer is another tab's is still being read", () => {
    expect(awaitingTabRead({ fromView: true, typed: "assignee = a", siteQ: "assignee in (a, b)", failed: false })).toBe(true);
    expect(awaitingTabRead({ fromView: true, typed: "assignee = a", siteQ: undefined, failed: false })).toBe(true);
  });
  test("answered, failed, or not a tab: nothing to wait for", () => {
    expect(awaitingTabRead({ fromView: true, typed: "x", siteQ: "x", failed: false })).toBe(false);
    expect(awaitingTabRead({ fromView: true, typed: "x", siteQ: undefined, failed: true })).toBe(false);
    expect(awaitingTabRead({ fromView: false, typed: "x", siteQ: undefined, failed: false })).toBe(false);
  });
});
