/* The Sprint group: tokens, Next sprint, the sections and their order, the old sprintOnly read as a pick, and a restart. */
import { describe, expect, test } from "bun:test";
import { filterCards, NO_FILTERS } from "../src/components/jira/list/model.ts";
import { migrateSprintOnly, sprintNarrow, sprintPasses, sprintRows, sprintSentence, byName, boardNextNames, boardOf } from "../src/components/jira/list/sprintModel.ts";
import { pickRest, readLayout } from "../src/components/jira/list/viewsModel.ts";
import { groupRows, railSummary, togglePatch } from "../src/components/jira/list/filtersV2Model.ts";

const NOW = Date.UTC(2026, 10, 14);
const D = 86_400_000;
let n = 0;
const card = (sprint: string | null, extra: Record<string, unknown> = {}) => ({ id: `c${++n}`, title: "t", key: `ORBIT-${1000 + n}`, status: "Doing", statusKind: "open", tags: [], sprint, ...extra }) as never;
const cards = [
  card("Orbit Sprint 12", { sprintActive: true, sprintEnd: NOW + 5 * D }), card("Orbit Sprint 12", { sprintActive: true, sprintEnd: NOW + 5 * D }),
  card("Orbit Sprint 13", { sprintStart: NOW + 6 * D }), card("Orbit Sprint 14", { sprintStart: NOW + 20 * D }),
  card("Orbit Sprint 11", { sprintState: "closed", sprintEnd: NOW - 10 * D }), card("Orbit Sprint 7", { sprintState: "closed", sprintEnd: NOW - 90 * D }),
  card(null), card(null), card(null),
];
const pickOf = (p: string[]) => filterCards(cards, { ...NO_FILTERS, sprintPick: p }).length;

describe("sprint picks", () => {
  test("no picks shows all; each token keeps its own cards", () => {
    expect(pickOf([])).toBe(9);
    expect(pickOf(["@current"])).toBe(2);
    expect(pickOf(["@none"])).toBe(3);
    expect(pickOf([byName("Orbit Sprint 11")])).toBe(1);
  });
  test("Next sprint is only the soonest future one", () => {
    expect(pickOf(["@next"])).toBe(1);
    expect(sprintPasses(cards[3] as never, ["@next"], cards)).toBe(false);
  });
  test("several picks read as any of them", () => expect(pickOf(["@current", "@none"])).toBe(5));
});

describe("sprint rows", () => {
  const rows = sprintRows(cards, ["@current"], NOW);
  test("Now holds current, next, none in that order, with a name and end on the tag", () => {
    expect(rows.slice(0, 3).map((r) => r.id)).toEqual(["@current", "@next", "@none"]);
    expect(rows[0]!.tag).toBe("Orbit Sprint 12 · ends Thu 19");
    expect(rows[1]!.tag).toContain("Orbit Sprint 13");
    expect(rows.slice(0, 3).map((r) => r.count)).toEqual([2, 1, 3]);
    expect(rows[0]!.on).toBe(true);
  });
  test("closed within 6 weeks is recent, older is folded under Older; the next sprint is not listed twice", () => {
    expect(rows.filter((r) => r.section === "Recently closed").map((r) => r.label)).toEqual(["Orbit Sprint 11"]);
    expect(rows.filter((r) => r.section === "Older").map((r) => r.label)).toEqual(["Orbit Sprint 7"]);
    expect(rows.filter((r) => r.section === "Other open sprints").map((r) => r.label)).toEqual(["Orbit Sprint 14"]);
  });
  test("a lone active sprint is not repeated by name; several running are", () => {
    expect(rows.some((r) => r.label === "Orbit Sprint 12")).toBe(false);
    const two = [...cards, card("Orbit Sprint 15", { sprintActive: true })];
    expect(sprintRows(two, [], NOW).filter((r) => r.section === "Other open sprints").map((r) => r.label)).toEqual(["Orbit Sprint 12", "Orbit Sprint 14", "Orbit Sprint 15"]);
  });
  test("group rows and a pick come through the shared popover model", () => {
    const g = groupRows("sprint", { ...NO_FILTERS, sprintPick: ["@none"] }, { cards, statuses: [], tags: [], team: [], now: NOW });
    expect(g.find((r) => r.id === "@none")!.on).toBe(true);
    expect(togglePatch("sprint", NO_FILTERS, "@next")).toEqual({ sprintPick: ["@next"] });
    expect(railSummary({ ...NO_FILTERS, sprintPick: ["@current"] }, "sprint")).toBe("Current");
    expect(sprintSentence(["@current", byName("Orbit Sprint 11")])).toBe("current sprint or Orbit Sprint 11");
  });
});

describe("the old toggle and a restart", () => {
  test("sprintOnly=running reads as Current sprint, a name as that sprint", () => {
    expect(migrateSprintOnly({ sprintOnly: "@running" })).toEqual({ sprintOnly: null, sprintPick: ["@current"] });
    // a named sprint is the epic-scope Display menu's own: it stays in sprintOnly
    expect(migrateSprintOnly({ sprintOnly: "Orbit Sprint 12" })).toEqual({});
    expect(migrateSprintOnly({ sprintOnly: null })).toEqual({});
  });
  test("the site is asked for open sprints only when Current is the one pick", () => {
    expect(sprintNarrow(null, ["@current"])).toBe(true);
    expect(sprintNarrow("@running", [])).toBe(true);
    expect(sprintNarrow(null, ["@current", "@none"])).toBe(false);
    expect(sprintNarrow(null, ["@none"])).toBe(false);
    expect(sprintNarrow(null, [])).toBe(false);
  });
  test("saved state from before still loads, migrated", () => {
    const l = readLayout({ kept: { "v|": { statusPick: ["Doing"], sprintOnly: "@running" } } });
    expect(l.kept["v|"]).toMatchObject({ statusPick: ["Doing"], sprintPick: ["@current"], sprintOnly: null });
  });
  test("a pick is kept across a restart", () => {
    const kept = pickRest({ ...NO_FILTERS, sprintPick: ["@next", "n:Orbit Sprint 11"] });
    expect(readLayout(JSON.parse(JSON.stringify({ kept: { "v|": kept } }))).kept["v|"]!.sprintPick).toEqual(["@next", "n:Orbit Sprint 11"]);
  });
});

describe("sprints from the boards (the card menu's own source)", () => {
  const board = boardOf({ sprint: { name: "Orbit Sprint 12", start: NOW - 9 * D, end: NOW + 5 * D }, futures: [
    { name: "Orbit Sprint 13", start: NOW + 6 * D, end: NOW + 19 * D }, { name: "Orbit Sprint 14", start: NOW + 20 * D, end: NOW + 33 * D }, { name: "Orbit Sprint 15", start: NOW + 34 * D, end: NOW + 47 * D } ] });
  const rows = sprintRows(cards, [], NOW, [board]);
  test("every future sprint is listed with its dates, even with no card (0 is fine)", () => {
    const l15 = rows.find((r) => r.label === "Orbit Sprint 15")!;
    expect(l15.count).toBe(0);
    expect(l15.section).toBe("Other open sprints");
    expect(l15.note).toContain("future");
    expect(l15.note).toMatch(/\d/);
  });
  test("Next sprint is the earliest future sprint of each board, even when it holds no card", () => {
    const empty = boardOf({ futures: [{ name: "Orbit Sprint 13", start: NOW + 6 * D }, { name: "Orbit Sprint 14", start: NOW + 20 * D }] });
    expect(boardNextNames([empty, board])).toEqual(["Orbit Sprint 13", "Orbit Sprint 13"]);
    const onlyLater = [card("Orbit Sprint 14", { sprintStart: NOW + 20 * D })];
    expect(sprintPasses(onlyLater[0] as never, ["@next"], onlyLater)).toBe(true);
    expect(sprintPasses(onlyLater[0] as never, ["@next"], onlyLater, boardNextNames([empty]))).toBe(false);
    expect(rows.find((r) => r.id === "@next")!.tag).toContain("Orbit Sprint 13");
  });
  test("with no boards read the rows are the cards' own, as before", () => {
    expect(sprintRows(cards, [], NOW).find((r) => r.label === "Orbit Sprint 15")).toBeUndefined();
  });
  test("a filter pass keeps Next as the boards say", () => {
    expect(filterCards(cards, { ...NO_FILTERS, sprintPick: ["@next"], nextSprints: ["Orbit Sprint 14"] }).length).toBe(1);
    expect(filterCards(cards, { ...NO_FILTERS, sprintPick: ["@next"], nextSprints: ["Orbit Sprint 15"] }).length).toBe(0);
  });
});
