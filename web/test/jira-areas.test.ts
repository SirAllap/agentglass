/*
 * The Areas tree and the Group control's decisions (lib/jiraAreas.ts), against cards shaped like the ones a Jira board
 * read carries: a parent epic, a sprint name, a priority, an assignee.
 */
import { describe, expect, test } from "bun:test";
import { headChips, areaCards, areaLine, areaName, areaRows, epicLabel, defaultPref, groupAreas, groupKeyed, parsePref, prefText } from "../src/lib/jiraAreas.ts";
import { OPEN_EPICS_MAX, countCell, emptyBodyText, railTitle, underClause } from "../../shared/jiraAreas.ts";
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
      { key: "ORBIT-980", name: "Game", group: "area", total: 3, inSprint: 2, done: 1 },
      { key: "ORBIT-981", name: "Admin", color: "color_3", group: "area", total: 0, inSprint: 0, done: 0 },
      { key: "ORBIT-16", name: "Old launch", group: "epic", total: 1, inSprint: 1, done: 0 },
    ]);
  });
  test("an open epic beside the areas is a row of its own; a done one and one past the cap are not", () => {
    const epics: JiraBoardEpic[] = [
      { key: "ORBIT-980", name: "Area: Game" }, { key: "ORBIT-1042", name: "[EPIC] Design system (tokens, components)" },
      { key: "ORBIT-17", name: "QA runs", done: true },
      ...Array.from({ length: 12 }, (_, n) => ({ key: `ORBIT-${200 + n}`, name: `Spike ${n}` })),
    ];
    const rows = areaRows(epics, [card("9", under("ORBIT-1042"))], undefined);
    expect(rows.find((r) => r.key === "ORBIT-1042")).toMatchObject({ name: "Design system (tokens, components)", group: "epic", total: 1 });
    expect(rows.find((r) => r.key === "ORBIT-17")).toBeUndefined();
    expect(rows.filter((r) => r.group === "epic")).toHaveLength(OPEN_EPICS_MAX);
    expect(rows[0]).toMatchObject({ key: "ORBIT-980", group: "area" });
  });
  test("a rail count is open over total, a finished row is a check, a truncated read says at least", () => {
    expect(countCell({ total: 110, done: 109 }, false)).toEqual({ done: false, lead: "1", rest: " / 110", title: "1 open of 110; 109 done" });
    expect(countCell({ total: 4, done: 4 }, false)).toMatchObject({ done: true, lead: "✓", rest: " 4" });
    expect(countCell({ total: 0, done: 0 }, false)).toEqual({ done: false, lead: "0", rest: "", title: "no cards read" });
    expect(countCell({ total: 110, done: 109 }, true).title).toBe("1 open of at least 110; 109 done");
  });
  test("a rail title is the whole name minus its tag, never cut", () => {
    const long = "[GAME][EPIC] Align game engine and the new payment flow across every screen of the old checkout";
    expect(railTitle(long)).toBe(long);
    expect(railTitle("[EPIC] Design system as a code library (tokens, components)")).toBe("Design system as a code library (tokens, components)");
    expect(railTitle("Area: Mobile")).toBe("Mobile");
  });
  test("the header and the rail never use the 28-character cut", async () => {
    const strip = (t: string) => t.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
    expect(strip(await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text())).not.toContain("epicLabel(");
    expect(strip(await Bun.file(new URL("../src/components/jira/JiraAreas.tsx", import.meta.url)).text())).not.toContain("epicLabel(");
    expect(railTitle("[EPIC] Align game engine and cards with the rulebook")).toBe("Align game engine and cards with the rulebook");
  });
  test("an empty table speaks of the epic when one is selected, of the board otherwise", () => {
    expect(emptyBodyText(true)).toBe("This epic has no cards in the read.");
    expect(emptyBodyText(false)).toBe("This board has nothing open.");
  });
  test("an epic header's chips: open, done, and the sprint's own count", () => {
    expect(headChips({ total: 9, done: 5, inSprint: 1 }, "Sprint 1", true)).toEqual({ open: "4 open", done: "5 done", sprint: "1 in Sprint 1 of at least 9" });
    expect(headChips({ total: 9, done: 9, inSprint: 0 }, undefined, false)).toEqual({ open: "0 open", done: "9 done", sprint: null });
  });
  test("the kept read asks for the areas and the open epics beside them, never a done one", () => {
    const epics: JiraBoardEpic[] = [{ key: "ORBIT-980", name: "Area: Game" }, { key: "ORBIT-1042", name: "Design system" }, { key: "ORBIT-17", name: "QA runs", done: true }];
    expect(underClause(epics)).toBe("parent in (ORBIT-980, ORBIT-1042)");
    expect(underClause([{ key: "ORBIT-1042", name: "Design system" }])).toBe("parent is not EMPTY");
    expect(underClause([])).toBe("parent is not EMPTY");
    const many = [{ key: "ORBIT-980", name: "Area: Game" }, ...Array.from({ length: 15 }, (_, n) => ({ key: `ORBIT-${300 + n}`, name: `Spike ${n}` }))];
    expect(underClause(many).split(",")).toHaveLength(1 + OPEN_EPICS_MAX);
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

describe("an epic's name in a narrow rail", () => {
  test("the [EPIC] tag goes and the name is cut at the first ' (' with the key left to the row", () => {
    expect(epicLabel("[EPIC] Design system (tokens, components, /design page, screen migration)")).toBe("Design system");
    expect(epicLabel("[epic]Billing")).toBe("Billing");
    expect(epicLabel("Area: Mobile")).toBe("Mobile");
  });
  test("a long name with no bracket is cut at 28 characters with an ellipsis, a short one is left alone", () => {
    const l = epicLabel("Migrate every screen of the old checkout to the new payment flow");
    expect(l).toBe("Migrate every screen of the…");
    expect(l.length).toBeLessThanOrEqual(28);
    expect(epicLabel("Design system")).toBe("Design system");
  });
  test("a name that is only the tag keeps something to show", () => {
    expect(epicLabel("[EPIC]")).toBe("[EPIC]");
  });
});

describe("the sprint count of an epic whose kept read is older than the sprint", () => {
  const epics: JiraBoardEpic[] = [{ key: "ORBIT-1135", name: "[EPIC] Design system (tokens)" }];
  const kept = [card("1", { ...under("ORBIT-1135") }), card("2", under("ORBIT-1135"))];
  test("a child that the kept read has without a sprint but the board's own read has in it is counted once", () => {
    const fresh = [card("1", { ...under("ORBIT-1135"), sprint: "Sprint 1" })];
    expect(areaRows(epics, kept, "Sprint 1", fresh)[0]).toMatchObject({ total: 2, inSprint: 1 });
    expect(areaRows(epics, [{ ...kept[0]!, sprint: "Sprint 1" }, kept[1]!], "Sprint 1", fresh)[0]).toMatchObject({ total: 2, inSprint: 1 });
  });
  test("a card only the board's read has still counts in the total, so the line never says 1 of 0", () => {
    const fresh = [card("9", { ...under("ORBIT-1135"), sprint: "Sprint 1" })];
    expect(areaRows(epics, [kept[1]!], "Sprint 1", fresh)[0]).toMatchObject({ total: 2, inSprint: 1 });
  });
  test("a card in another sprint, or under another epic, is not counted", () => {
    const fresh = [card("1", { ...under("ORBIT-1135"), sprint: "Sprint 0" }), card("5", { ...under("ORBIT-16"), sprint: "Sprint 1" })];
    expect(areaRows(epics, kept, "Sprint 1", fresh)[0]!.inSprint).toBe(0);
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
