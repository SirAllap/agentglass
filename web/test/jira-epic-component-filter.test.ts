import { describe, expect, test } from "bun:test";
import type { ProviderTask } from "../../shared/providers.ts";
import { componentChoices, epicChipLabel, epicChoices, epicNamesOf } from "../src/components/jira/list/facetsModel.ts";
import { facetRows, filterCount } from "../src/components/jira/list/headerModel.ts";
import { filterCards, NO_FILTERS, type JiraListFilters } from "../src/components/jira/list/model.ts";
import { activeChips, pickKept, readLayout, restoreKept } from "../src/components/jira/list/viewsModel.ts";
import { narrowedBy } from "../src/components/jira/list/laneModel.ts";

const card = (key: string, o: { epic?: [string, string]; components?: string[]; people?: string[] }): ProviderTask => ({
  id: key, key, title: `Card ${key}`, status: "In progress", statusKind: "progress", tags: [], assignees: o.people ?? [],
  parent: o.epic ? { key: o.epic[0], title: o.epic[1], type: "Epic" } : undefined, components: o.components,
}) as unknown as ProviderTask;

const AUTH: [string, string] = ["ORBIT-10", "Auth hardening"];
const BILL: [string, string] = ["ORBIT-20", "Billing revamp"];
const cards = [
  card("ORBIT-1", { epic: AUTH, components: ["API", "Web"], people: ["u1"] }),
  card("ORBIT-2", { epic: AUTH, components: ["API"], people: ["u2"] }),
  card("ORBIT-3", { epic: BILL, components: ["Web"], people: ["u1"] }),
  card("ORBIT-4", { people: ["u3"] }),
];
const F = (o: Partial<JiraListFilters> = {}): JiraListFilters => ({ ...NO_FILTERS, ...o });
const keys = (f: JiraListFilters) => filterCards(cards, f).map((c) => c.id);

describe("epic and component choices", () => {
  test("only what the cards carry, with counts, by name", () => {
    expect(epicChoices(cards, [])).toEqual([
      { id: "ORBIT-10", name: "Auth hardening", count: 2, on: false },
      { id: "ORBIT-20", name: "Billing revamp", count: 1, on: false },
    ]);
    expect(componentChoices(cards, [])).toEqual([
      { id: "API", name: "API", count: 2, on: false },
      { id: "Web", name: "Web", count: 2, on: false },
    ]);
  });
  test("a pick with no card left still shows, at 0, and is on", () => {
    expect(epicChoices(cards.slice(2), ["ORBIT-10"]).find((r) => r.id === "ORBIT-10")).toEqual({ id: "ORBIT-10", name: "ORBIT-10", count: 0, on: true });
  });
  test("the menu search matches epic and component names", () => {
    const rows = facetRows(epicChoices(cards, []).map((e) => ({ ...e, label: e.name })), "AUTH", false).rows;
    expect(rows.map((r) => r.id)).toEqual(["ORBIT-10"]);
    expect(facetRows(componentChoices(cards, []).map((c) => ({ ...c, label: c.name })), "we", false).rows.map((r) => r.id)).toEqual(["Web"]);
  });
});

describe("the epic and component picks narrow the cards", () => {
  test("one epic keeps only its cards", () => expect(keys(F({ epicPick: ["ORBIT-10"] }))).toEqual(["ORBIT-1", "ORBIT-2"]));
  test("two epics are any-of", () => expect(keys(F({ epicPick: ["ORBIT-10", "ORBIT-20"] }))).toEqual(["ORBIT-1", "ORBIT-2", "ORBIT-3"]));
  test("a component keeps its cards; epic and component together are both required", () => {
    expect(keys(F({ componentPick: ["Web"] }))).toEqual(["ORBIT-1", "ORBIT-3"]);
    expect(keys(F({ epicPick: ["ORBIT-10"], componentPick: ["Web"] }))).toEqual(["ORBIT-1"]);
  });
  test("inside a default tab (Team, People: 4 on) an epic still narrows that tab's cards", () => {
    expect(keys(F({ assigneePick: ["u1", "u2"], epicPick: ["ORBIT-10"] }))).toEqual(["ORBIT-1", "ORBIT-2"]);
    expect(keys(F({ assigneePick: ["u1"], epicPick: ["ORBIT-10"] }))).toEqual(["ORBIT-1"]);
  });
});

describe("chips, counts, clear and the view's kept filters", () => {
  test("chip names", () => {
    const names = epicNamesOf(cards);
    expect(epicChipLabel(["ORBIT-10"], names)).toBe("Epic: Auth hardening");
    expect(epicChipLabel(["ORBIT-10", "ORBIT-20"], names)).toBe("Epics: 2");
    const labels = activeChips(F({ epicPick: ["ORBIT-10"], componentPick: ["API", "Web"], assigneePick: ["u1"] }), undefined, {}, names).map((c) => c.label);
    expect(labels).toEqual(expect.arrayContaining(["Epic: Auth hardening", "Components: 2", "People: 1"]));
  });
  test("each chip clears only itself", () => {
    const c = activeChips(F({ epicPick: ["ORBIT-10"] }), undefined).find((x) => x.id === "epic")!;
    expect(c.clear).toEqual({ epicPick: [] });
  });
  test("the footer count and the empty-state words include them", () => {
    expect(filterCount(F({ epicPick: ["ORBIT-10"], componentPick: ["API", "Web"] }))).toBe(3);
    expect(narrowedBy(F({ epicPick: ["ORBIT-10"] }))).toContain("1 epic");
  });
  test("a default tab keeps and restores them; an older saved layout has none", () => {
    const kept = pickKept({ ...F({ epicPick: ["ORBIT-10"], componentPick: ["API"] }) });
    expect(restoreKept(kept)).toMatchObject({ epicPick: ["ORBIT-10"], componentPick: ["API"] });
    expect(restoreKept(undefined)).toMatchObject({ epicPick: [], componentPick: [] });
    const old = readLayout({ filters: { team: { spaces: [], statusPick: [], people: ["u1"], tags: [] } } });
    expect(restoreKept(old.filters.team)).toMatchObject({ epicPick: [], componentPick: [] });
    expect(readLayout(JSON.parse(JSON.stringify({ filters: { team: kept } }))).filters.team).toMatchObject({ epics: ["ORBIT-10"], components: ["API"] });
  });
});

describe("a sub-task sits in its parent's epic, as the swimlanes read it", () => {
  const story = { ...card("ORBIT-123", { epic: ["ORBIT-122", "Orbit RBAC"] }) };
  const sub = { ...card("ORBIT-131", {}), issueType: "Sub-task", parent: { key: "ORBIT-123", title: "Story", type: "Story" } } as unknown as ProviderTask;
  const all = [story, sub];
  test("filtering by the epic keeps the sub-task, and the count includes it", () => {
    expect(filterCards(all, F({ epicPick: ["ORBIT-122"] })).map((c) => c.id)).toEqual(["ORBIT-123", "ORBIT-131"]);
    expect(epicChoices(all, [])).toEqual([{ id: "ORBIT-122", name: "Orbit RBAC", count: 2, on: false }]);
  });
});

describe("an epic board holds its sub-tasks, in their own status, and counts them", () => {
  test("11 cards + 5 sub-tasks of ORBIT-123 read 16, sub-tasks in their status", () => {
    const stories = Array.from({ length: 11 }, (_, i) => ({ ...card(`ORBIT-${200 + i}`, {}), status: "To Do", statusKind: "todo" }) as unknown as ProviderTask);
    const subs = [131, 132, 133, 134, 135].map((n) => ({ ...card(`ORBIT-${n}`, {}), issueType: "Sub-task", status: "In progress", epic: { key: "ORBIT-122", title: "Orbit RBAC" }, parent: { key: "ORBIT-123", title: "S", type: "Story" } }) as unknown as ProviderTask);
    const shown = filterCards([...stories, ...subs], F());
    expect(shown).toHaveLength(16);
    expect(shown.filter((t) => t.status === "In progress").map((t) => t.id)).toEqual(["ORBIT-131", "ORBIT-132", "ORBIT-133", "ORBIT-134", "ORBIT-135"]);
  });
});
