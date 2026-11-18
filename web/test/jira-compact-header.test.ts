/*
 * The compact Jira board header (the approved mockup): two rows, a chips line only while something is applied, one Filters
 * popover, one Display popover, JQL editing in the box. The decisions as pure functions; the layout asserted on the source text.
 */
import { GROUPS, SIGNALS, togglePatch } from "../src/components/jira/list/filtersV2Model.ts";
import { describe, expect, test } from "bun:test";
import { chipsLine, countLine, countText, showTabCount, editCaption, FACETS_OFF, filterCount, QUICK_TOGGLES } from "../src/components/jira/list/headerModel.ts";
import { NO_FILTERS } from "../src/components/jira/list/model.ts";
import { loadChip } from "../src/components/jira/list/viewsModel.ts";

const dir = "../src/components/jira/list/";
const read = async (f: string) => (await Bun.file(new URL(dir + f, import.meta.url)).text()).replace(/\/\*[\s\S]*?\*\//g, "");
const view = await read("JiraListView.tsx");
const tabs = await read("JiraTabs.tsx");
const search = await read("JiraSearch.tsx");
const filtersMenu = await read("JiraFiltersMenu.tsx");
const displayMenu = await read("JiraDisplayMenu.tsx");
const line = await read("ActiveFilters.tsx");
const f = { ...NO_FILTERS, showDone: false };

describe("A. closed: two rows", () => {
  test("row 1 is the tabs, row 2 the search with Filters, Display and the count; no third row until something is applied", () => {
    expect(view).toContain("<JiraTabs");
    expect(view).toContain('data-slot="finding"');
    for (const part of ["<JiraSearch", "<JiraFiltersMenu", "<JiraDisplayMenu"]) expect(view).toContain(part);
    // The count and "read Ns ago" are said once, in the footer; the header carries neither.
    expect(view).not.toContain('data-testid="jira-count"');
    expect(view).toContain("countText={countText(count, say.count)}");
    expect(view.indexOf("<JiraSearch")).toBeLessThan(view.indexOf("<ActiveFilters"));
    expect(view.indexOf("<ActiveFilters")).toBeLessThan(view.indexOf("<JiraFiltersMenu"));
    expect(view.indexOf("<JiraTabs")).toBeLessThan(view.indexOf('data-slot="finding"'));
  });
  test("the count reads '14 of 45 · 31 hidden', and drops the hidden part when nothing is hidden", () => {
    expect(countLine(14, 45, false)).toEqual({ head: "14 of 45", hidden: "31 hidden" });
    expect(countLine(45, 45, false)).toEqual({ head: "45 of 45", hidden: null });
    expect(countLine(14, 45, true).head).toBe("14 of 45+");
  });
  test("the old header controls are gone", () => {
    for (const gone of ["<JiraChips", "<AssigneePicker", "<Segmented", "Swimlanes", "agx-jb-lanes", "Comfortable", "search the site"]) expect(view, gone).not.toContain(gone);
    expect(search).not.toContain("search the site");
    expect(search).not.toContain("<QueryTools");
    expect(tabs).not.toContain("Save to view");
    expect(tabs).not.toContain("More views ▾");
  });
  test("the search shows the '/' hint only while empty, and no native title", () => {
    expect(search).toContain("{!q && <span className=\"agx-jm-keys\" aria-hidden><kbd>/</kbd></span>}");
    expect(filtersMenu + displayMenu + line + tabs).not.toMatch(/\stitle=\{|\stitle="/);
  });
  test("tabs: hover grip, the ⋯ menu with Rename / Duplicate / Delete view, More and a '+'", () => {
    expect(tabs).toContain('className="agx-jt-grip"');
    for (const row of [">Rename</MenuRow>", ">Duplicate</MenuRow>", ">Delete view</MenuRow>"]) expect(tabs, row).toContain(row);
    expect(tabs).toContain('aria-label="More views"');
    expect(tabs).toContain('aria-label="Save view"');
    expect(view).toContain('label: "Undo"');
  });
});

describe("the chips line (E)", () => {
  test("hidden with nothing applied; the default Hide done alone does not open it", () => {
    expect(chipsLine(f, "Assigned to me").show).toBe(false);
    expect(chipsLine(NO_FILTERS, "Assigned to me").show).toBe(false);
  });
  test("shown when a view's JQL or any removable chip is applied; the board's own chip leads the rest", () => {
    expect(chipsLine({ ...f, viewJql: "assignee = currentUser()" }, undefined).show).toBe(true);
    const l = chipsLine({ ...f, spaces: ["ORBIT"], blockedOnly: true }, "Assigned to me");
    expect(l.show).toBe(true);
    expect(l.board).toMatchObject({ label: "Assigned to me", board: true });
    expect(l.chips.map((c) => c.id)).toEqual(["spaces", "blocked", "done"]);
    expect(l.chips.every((c) => c.clear)).toBe(true);
  });
  test("the view JQL is its own purple chip, not one of the removable ones", () => {
    const l = chipsLine({ ...f, viewJql: "project = ORBIT", mineOnly: true }, "Board");
    expect(l.jql).toBe("project = ORBIT");
    expect(l.chips.map((c) => c.id)).toEqual(["mine", "done"]);
  });
  test("chips wrap on the search row; JQL chip, board mark, removable chips, Clear all", () => {
    expect(line).toContain("agx-jf-line");
    expect(line).toContain("flex-wrap");
    expect(line).toContain("onClick={onEditJql}");
    expect(line).toContain("<i>board</i>");
    expect(line).toContain("Clear all");
    expect(view).toContain("{!editing && <ActiveFilters");
  });
});

describe("one count, no zero tab counts", () => {
  test("countText joins head, hidden and changed", () => {
    expect(countText(countLine(11, 47, false), "3 changed")).toBe("11 of 47 · 36 hidden · 3 changed");
    expect(countText(countLine(47, 47, false))).toBe("47 of 47");
  });
  test("a tab count of 0 is left off; unknown stays", () => {
    expect(showTabCount({ n: 0 })).toBe(false);
    expect(showTabCount({ n: 2 })).toBe(true);
    expect(showTabCount("err")).toBe(true);
    expect(showTabCount(undefined)).toBe(false);
  });
});

describe("B. Filters popover", () => {
  test("the badge counts every facet", () => {
    expect(filterCount(f)).toBe(0);
    expect(filterCount({ ...f, spaces: ["ORBIT", "ACME"], assigneePick: ["a"], statusPick: ["Doing"], tagPick: ["ux"], blockedOnly: true, quick: ["q1"] })).toBe(7);
  });
  test("it holds a rail group for Space, People, Status, Label and Signals (the quick toggles), and applies on click", () => {
    const ids: string[] = GROUPS.map((g) => g.id);
    for (const id of ["space", "people", "status", "label", "signals"]) expect(ids).toContain(id);
    expect(QUICK_TOGGLES.map((q) => q.label)).toEqual(["Flagged", "Blocked", "Has due date", "Quiet 14 days", "Live worker", "Needs you"]);
    expect(filtersMenu).toContain("Kept after restart");
    expect(filtersMenu).toContain("Clear all");
    expect(filtersMenu).toContain("<AnchoredMenu anchor={btn}");
  });
  test("nothing that worked is dead: Show done and the is / is not rules are set from the popover", () => {
    expect(SIGNALS.map((x) => x.id)).toContain("showDone");
    expect(togglePatch("signals", NO_FILTERS, "showDone")).toEqual({ showDone: true });
    expect(filtersMenu).toContain("<FilterPanel");
  });
  test("Hide done shows as a removable chip beside the others, and its × brings the done cards back", () => {
    const l = chipsLine({ ...NO_FILTERS, spaces: ["ORBIT"] }, "Board");
    const done = l.chips.find((c) => c.id === "done");
    expect(done?.label).toBe("Hide done");
    expect(done?.clear).toEqual({ showDone: true });
  });
  test("a lit quick filter (Show done) is a chip like a label, counted, and its × turns it off", () => {
    const on = { ...NO_FILTERS, showDone: true };
    const l = chipsLine(on, "Board");
    expect(l.show).toBe(true);
    const chip = l.chips.find((c) => c.id === "showdone");
    expect(chip?.label).toBe("Show done");
    expect(chip?.clear).toEqual({ showDone: false });
    expect(l.chips.some((c) => c.id === "done")).toBe(false);
    expect(filterCount(on)).toBe(1);
    expect(filterCount({ ...on, ...chip!.clear })).toBe(0);
  });
  test("its Clear all turns off its facets only, never the search or the view's JQL", () => {
    expect(FACETS_OFF).toMatchObject({ spaces: [], assigneePick: [], statusPick: [], tagPick: [], blockedOnly: false, quick: [] });
    expect("query" in FACETS_OFF).toBe(false);
    expect("viewJql" in FACETS_OFF).toBe(false);
  });
});

describe("C. the view's JQL chip, clicked", () => {
  test("its search moves into the box and the view stops holding it twice", () => {
    expect(loadChip({ viewJql: "project = ORBIT" })).toEqual({ query: "project = ORBIT", viewJql: null });
  });
  test("Save to view and Cancel take the place of Filters and Display, with the caption", () => {
    expect(view).toContain("const editing = editFrom !== null && typedJql !== \"\";");
    expect(view).toContain(">Save to view</Ctl>");
    expect(view).toContain(">Cancel</Ctl>");
    expect(view).toContain("editCaption(");
    expect(editCaption("Mine", 14, 45)).toBe("Editing the JQL of “Mine”. Count stays 14 of 45 until saved.");
  });
  test("Cancel puts the view's own JQL back", () => {
    expect(view).toContain('onFilters({ query: "", viewJql: editFrom || null })');
  });
});

describe("D. Display popover and the card menu", () => {
  test("Layout, Density and Swimlanes live in it; Board and List both offered", () => {
    for (const s of ['name="Layout"', 'name="Density"', 'name="Swimlanes"']) expect(displayMenu, s).toContain(s);
    expect(displayMenu).toContain('{ id: "board", label: "Board" }');
    expect(displayMenu).toContain('{ id: "list", label: "List" }');
    expect(displayMenu).toContain('data-testid="jira-display-popover"');
  });
  test("Sprint only / All n lives in Display, for an open epic with a sprint", () => {
    expect(displayMenu).toContain('name="Scope"');
    expect(displayMenu).toContain("sprintOnly");
    expect(view).toContain('scope={areaId && !areaId.startsWith("@") && model.sprint');
  });
  test("the card menu still offers Move to current sprint", async () => {
    expect(await read("menus/menuModel.ts")).toContain('"Move to current sprint"');
  });
  test("the b and d keys still switch layout and density", () => {
    expect(view).toContain('if (k === "mode") setMode(mode === "board" ? "list" : "board")');
    expect(view).toContain('else if (k === "density") setDensity(density === "compact" ? "comfortable" : "compact")');
    expect(view).toContain("openJiraJump()");
  });
});
