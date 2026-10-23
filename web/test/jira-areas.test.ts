/*
 * The Areas tree and the Group control's decisions (lib/jiraAreas.ts), against cards shaped like the ones a Jira board
 * read carries: a parent epic, a sprint name, a priority, an assignee.
 */
import { describe, expect, test } from "bun:test";
import { areaCards, areaLine, areaName, areaRows, defaultPref, groupAreas, groupKeyed, parsePref, prefText } from "../src/lib/jiraAreas.ts";
import type { JiraBoardEpic, ProviderTask } from "../../shared/providers.ts";

const card = (id: string, o: Partial<ProviderTask> = {}): ProviderTask =>
  ({ id, customId: `ORBIT-${id}`, title: `Card ${id}`, status: "To Do", statusKind: "open", assignees: [], tags: [], priority: null, ...o } as ProviderTask);
const under = (key: string) => ({ parent: { key, title: `Epic ${key}`, type: "Epic" } });
const EPICS: JiraBoardEpic[] = [{ key: "ORBIT-980", name: "Area: Game" }, { key: "ORBIT-981", name: "Area: Admin", color: "color_3" }, { key: "ORBIT-16", name: "Old launch" }];

describe("the areas of a board", () => {
  const tasks = [
    card("1", { ...under("ORBIT-980"), sprint: "Sprint 1" }), card("2", { ...under("ORBIT-980"), sprint: "Sprint 1", statusKind: "done" }),
    card("3", under("ORBIT-980")), card("4", { ...under("ORBIT-16"), sprint: "Sprint 1" }), card("5"),
  ];
  test("the epics named Area: are the areas, counted in the sprint and in all, an empty one kept", () => {
    expect(areaRows(EPICS, tasks, "Sprint 1")).toEqual([
      { key: "ORBIT-980", name: "Game", total: 3, inSprint: 2, done: 1 },
      { key: "ORBIT-981", name: "Admin", color: "color_3", total: 0, inSprint: 0, done: 0 },
    ]);
  });
  test("a board whose epics are not named as areas gets the epics that hold a card", () => {
    expect(areaRows([{ key: "ORBIT-16", name: "Old launch" }, { key: "ORBIT-17", name: "Nothing" }], tasks, undefined).map((r) => [r.key, r.total, r.inSprint]))
      .toEqual([["ORBIT-16", 1, 0]]);
  });
  test("an area's cards are the ones under that epic, any sprint", () => {
    expect(areaCards(tasks, "ORBIT-980").map((t) => t.id)).toEqual(["1", "2", "3"]);
    expect(areaCards(tasks, "ORBIT-999")).toEqual([]);
  });
  test("the header line says how many are in the sprint, and 'at least' for a read that was cut", () => {
    expect(areaLine(60, 5, "Sprint 1", false)).toBe("5 in Sprint 1 of 60");
    expect(areaLine(300, 5, "Sprint 1", true)).toBe("5 in Sprint 1 of at least 300");
    expect(areaLine(1, 0, undefined, false)).toBe("1 card");
    expect(areaName("Area: Tests & chores")).toBe("Tests & chores");
    expect(areaName("Area:")).toBe("Area:");
  });
  test("area groups wear the epic's name, and the bare cards are 'No area'", () => {
    const g = groupAreas(tasks, EPICS);
    expect(g.map((x) => x.title)).toEqual(["Game", "Old launch", "No area"]);
  });
});

describe("grouping by something other than status", () => {
  test("priority by weight with none last, sprint and person by name with none last", () => {
    const rows = [card("1", { priority: "low" }), card("2", { priority: "urgent" }), card("3"), card("4", { priority: "normal" })];
    expect(groupKeyed(rows, "priority").map((g) => g.title)).toEqual(["Urgent", "Medium", "Low", "No priority"]);
    const s = [card("1", { sprint: "Sprint 2" }), card("2"), card("3", { sprint: "Sprint 1" })];
    expect(groupKeyed(s, "sprint").map((g) => g.title)).toEqual(["Sprint 1", "Sprint 2", "No sprint"]);
    const p = [card("1", { assignees: ["Ravi K."] }), card("2"), card("3", { assignees: ["Dana L."] })];
    expect(groupKeyed(p, "person").map((g) => g.title)).toEqual(["Dana L.", "Ravi K.", "Unassigned"]);
  });
  test("each card is in one group and the done ones are counted", () => {
    const g = groupKeyed([card("1", { priority: "high", statusKind: "done" }), card("2", { priority: "high" })], "priority");
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ done: 1 });
    expect(g[0]!.rows.map((t) => t.id)).toEqual(["1", "2"]);
  });
});

describe("what is remembered of the grouping", () => {
  const def = defaultPref(false);
  test("a round trip keeps the choice; nothing kept is the default", () => {
    expect(parsePref(prefText({ by: "area", split: "status" }), true, def)).toEqual({ by: "area", split: "status" });
    expect(parsePref(null, true, def)).toEqual(def);
    expect(parsePref("{broken", true, def)).toEqual(def);
  });
  test("the first version's bare word still reads, and 'parent' is 'area'", () => {
    expect(parsePref("parent", true, def)).toEqual({ by: "area", split: "none" });
    expect(parsePref("status", true, def)).toEqual({ by: "status", split: "none" });
  });
  test("a choice that needs areas on a board with none falls back, and a second level cannot repeat the first", () => {
    expect(parsePref("parent", false, def)).toEqual(def);
    expect(parsePref(prefText({ by: "status", split: "area" }), false, def)).toEqual({ by: "status", split: "none" });
    expect(parsePref(prefText({ by: "status", split: "status" }), true, def)).toEqual({ by: "status", split: "none" });
    expect(parsePref(prefText({ by: "priority", split: "area" }), true, def)).toEqual({ by: "priority", split: "none" });
    expect(parsePref(JSON.stringify({ by: "nonsense", split: "none" }), true, def)).toEqual(def);
  });
  test("the sprint view starts as status then area", () => { expect(defaultPref(true)).toEqual({ by: "status", split: "area" }); });
});
