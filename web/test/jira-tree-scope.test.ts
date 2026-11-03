/*
 * A click in the Jira tree opens that place's cards in the centre. The row used
 * to light up and nothing else changed, because no pane read the selection.
 * What a row opens is decided in lib/jiraTree.ts; that the panel acts on it is
 * asserted against source, since there is no renderer here.
 */
import { describe, expect, test } from "bun:test";
import type { JiraSpace, JiraSpaceTree, JiraTreeComponent, JiraTreeEpic } from "../../shared/jiraSpaces.ts";
import { apply, fieldsOf, valuesOf } from "../src/components/tasks/filters.ts";
import { parseScope, scopeId, scopeJql } from "../../shared/jiraScope.ts";
import { EMPTY_PREFS, buildRows, keyC, keyS, parsePrefs, parseShapes, scopeIdOf, shapeOf, shapesText, targetOf, type TreeInput } from "../src/lib/jiraTree.ts";

const epic = (n: number, comps: string[]): JiraTreeEpic =>
  ({ key: `ORB-${n}`, id: String(n), summary: `Vector index fold ${n}`, status: { name: "In Progress", category: "open" }, done: 1, total: 4, components: comps });
const comp = (name: string, epics: JiraTreeEpic[]): JiraTreeComponent => ({ id: name, name, issues: 4, empty: false, noEpic: 0, epics });
// One epic with cards in three components.
const spanning = epic(1, ["Api", "Web", "Docs"]);
const tree: JiraSpaceTree = { space: "ORB", noEpic: 0, total: 12, done: 2, hidDone: 0, readAt: 1, components: [comp("Api", [spanning]), comp("Web", [spanning]), comp("Docs", [spanning, epic(2, ["Docs"])])] };
const space: JiraSpace = { key: "ORB", name: "Orbit" };
const input = (shape?: "epics"): TreeInput => ({
  spaces: [space], reads: { ORB: { state: "ready", tree } },
  prefs: { ...EMPTY_PREFS, last: null, shape: shape ? { ORB: shape } : {}, open: { [keyS("ORB")]: true, [keyC("ORB", "Api")]: true, [keyC("ORB", "Web")]: true, [keyC("ORB", "Docs")]: true } } as TreeInput["prefs"], q: "", views: [], looked: 0, listed: true,
});

describe("what a tree row opens", () => {
  test("space, component, no component, epic, epic under a component, no epic", () => {
    expect(scopeIdOf({ kind: "space", space: "ORB" })).toBe("scope:ORB");
    expect(scopeIdOf({ kind: "component", space: "ORB", component: "Web" })).toBe("scope:ORB|c:Web");
    expect(scopeIdOf({ kind: "component", space: "ORB" })).toBe("scope:ORB|c:");
    expect(scopeIdOf({ kind: "epic", space: "ORB", epic: "ORB-1" })).toBe("scope:ORB|e:ORB-1");
    expect(scopeIdOf({ kind: "epic", space: "ORB", component: "Api", epic: "ORB-1" })).toBe("scope:ORB|c:Api|e:ORB-1");
    expect(scopeIdOf({ kind: "noepic", space: "ORB", component: "Web" })).toBe("scope:ORB|c:Web|n");
    expect(scopeIdOf({ kind: "view", space: "ORB", view: "board:3" })).toBeNull();
  });

  test("the id round-trips and refuses what it did not write", () => {
    for (const s of [{ space: "ORB" }, { space: "ORB", component: "" }, { space: "ORB", component: "Web", epic: "ORB-1" }, { space: "ORB", noEpic: true }]) expect(parseScope(scopeId(s))).toEqual(s);
    for (const bad of ["scope:orb", "scope:ORB|e:1", "scope:ORB|x", "board:3", "scope:"]) expect(parseScope(bad)).toBeNull();
  });

  test("a component name with a quote cannot leave its string", () => {
    expect(scopeJql({ space: "ORB", component: 'a" OR project = X OR "b' })).toContain('component = "a\\" OR project = X OR \\"b"');
  });
});

describe("the two layouts", () => {
  test("Components: the epic is under each component, and each copy opens that component's share", () => {
    const rows = buildRows(input());
    const copies = rows.filter((r) => r.kind === "epic" && r.epic.key === "ORB-1");
    expect(copies.length).toBe(3);
    expect(copies.map((r) => scopeIdOf(targetOf(r)!))).toEqual(["scope:ORB|c:Api|e:ORB-1", "scope:ORB|c:Web|e:ORB-1", "scope:ORB|c:Docs|e:ORB-1"]);
  });

  test("Epics: the epic appears once and opens all of its cards", () => {
    const rows = buildRows(input("epics"));
    const copies = rows.filter((r) => r.kind === "epic" && r.epic.key === "ORB-1");
    expect(copies.length).toBe(1);
    expect(scopeIdOf(targetOf(copies[0]!)!)).toBe("scope:ORB|e:ORB-1");
    expect(rows.some((r) => r.kind === "component")).toBe(false);
  });

  test("both layouts keep the header row that holds the switch", () => {
    for (const shape of [undefined, "epics" as const]) {
      const cap = buildRows(input(shape)).find((r) => r.kind === "components");
      expect(cap).toMatchObject({ kind: "components", shape: shape ?? "both" });
    }
  });

  test("the choice is per space, survives a reload, and only the two layouts are kept", () => {
    expect(shapesText({ ORB: "epics", OPS: "both" })).toBe("ORB:epics"); // "both" is the default and is not written
    expect(parseShapes("ORB:epics")).toEqual({ ORB: "epics" });
    expect(parseShapes("ORB:flat")).toBeNull();
    expect(shapeOf(parsePrefs(JSON.stringify({ shape: { ORB: "epics", OPS: "flat" } })), "OPS")).toBe("both");
    expect(shapeOf(parsePrefs(JSON.stringify({ shape: { ORB: "epics" } })), "ORB")).toBe("epics");
  });
});

const panel = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const tree_ = await Bun.file(new URL("../src/components/jira/JiraTree.tsx", import.meta.url)).text();
describe("the panel acts on a pick", () => {
  test("onPicked loads the place's own list", () => {
    const at = panel.indexOf("onPicked:");
    const body = panel.slice(at, panel.indexOf("},\n", at));
    expect(body).toContain("scopeIdOf(s)");
    expect(body).toContain("load(id, false, true)");
  });
  test("the header draws the two-way switch and writes through setShape", () => {
    expect(tree_).toContain('role="radiogroup"');
    expect(tree_).toContain("api.setShape(r.space, x.id)");
  });
});

describe("the list's filters know components and epics", () => {
  const card = (key: string, components: string[], epicKey?: string): any => ({
    id: key, customId: key, title: key, status: "To Do", statusKind: "open", tags: [], assignees: [], components,
    ...(epicKey ? { parent: { key: epicKey, title: "Reports", type: "Epic" } } : {}),
  });
  // One epic with cards in three components, and a sub-task whose parent is a card, not an epic.
  const cards = [card("ORB-10", ["Api"], "ORB-1"), card("ORB-11", ["Web"], "ORB-1"), card("ORB-12", ["Docs", "Web"], "ORB-1"), card("ORB-13", ["Api"], "ORB-2"), { ...card("ORB-14", ["Api"]), parent: { key: "ORB-10", title: "x", type: "Story" } }];
  const rule = (field: string, values: string[]) => ({ join: "and" as const, rules: [{ id: field, field, op: "is" as const, values }] });

  test("both are offered, the epic once however many components it spans", () => {
    const f = fieldsOf(cards);
    expect(f.find((x) => x.key === "component")!.options.map((o) => o.value).sort()).toEqual(["Api", "Docs", "Web"]);
    expect(f.find((x) => x.key === "epic")!.options.map((o) => o.value).sort()).toEqual(["ORB-1", "ORB-2"]);
  });
  test("a sub-task's parent is not an epic", () => expect(valuesOf(cards[4], "epic")).toEqual([]));
  test("component X with epic Y, and epic Y with component X, are the same cards", () => {
    const both = { join: "and" as const, rules: [{ id: "c", field: "component", op: "is" as const, values: ["Web"] }, { id: "e", field: "epic", op: "is" as const, values: ["ORB-1"] }] };
    const swapped = { join: "and" as const, rules: [...both.rules].reverse() };
    expect(apply(cards, both).map((c) => c.customId)).toEqual(["ORB-11", "ORB-12"]);
    expect(apply(cards, swapped).map((c) => c.customId)).toEqual(["ORB-11", "ORB-12"]);
    expect(apply(cards, rule("component", ["Api", "Docs"])).length).toBe(4);
  });
});
