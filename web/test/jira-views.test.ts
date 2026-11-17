/* The board's views: where a view's JQL lives, what a count says, the default views and their layout, the filters kept with a view, and Move to current sprint. */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProviderTask } from "../../shared/providers.ts";
import { JiraTabs } from "../src/components/jira/list/JiraTabs.tsx";
import { effectiveJql, filterCards, NO_FILTERS } from "../src/components/jira/list/model.ts";
import { changeRows } from "../src/components/jira/list/menus/menuModel.ts";
import {
  CLEAR_ALL, DEFAULT_VIEWS, NO_LAYOUT, activeChips, hideView, showView, keepFilters, layoutViews, loadChip, moveView, pickKept, readLayout, renameView, resetLayout, restoreKept,
  jqlScope, saveToView, teamFromFavourites, NO_VIEW_FILTERS, sprintMoveAsk, tabCounts, viewJql, viewTabs, meViewTab,
} from "../src/components/jira/list/viewsModel.ts";

const card = (id: string, o: Partial<ProviderTask> = {}): ProviderTask => ({ id, customId: id, title: id, status: "Open", statusKind: "open", tags: [], assignees: [], ...o }) as unknown as ProviderTask;

describe("1. a view's JQL is the chip's, never the box's", () => {
  const backlog = "assignee = currentUser() AND sprint in openSprints()";
  test("the view's search is the one the site is asked, and the box stays empty", () => {
    const f = { ...NO_FILTERS, query: "", viewJql: backlog };
    expect(effectiveJql(f)).toBe(backlog);
    expect(f.query).toBe("");
  });
  test("a JQL typed in the box replaces the view's; plain words never do", () => {
    expect(effectiveJql({ query: "project = ORBIT", viewJql: backlog })).toBe("project = ORBIT");
    expect(effectiveJql({ query: "login bug", viewJql: backlog })).toBe(backlog);
  });
  test("the site's answer for the view's search narrows the list, with the box empty", () => {
    const cards = [card("ORBIT-1"), card("ORBIT-2")];
    const f = { ...NO_FILTERS, viewJql: backlog, site: { q: backlog, keys: ["ORBIT-2"] } };
    expect(filterCards(cards, f).map((t) => t.id)).toEqual(["ORBIT-2"]);
  });
  test("clicking the chip loads its JQL into the box, editable, and the chip lets go", () => {
    expect(loadChip({ viewJql: backlog })).toEqual({ query: backlog, viewJql: null });
  });
});

describe("2. a count is what the tab shows on this board, or nothing", () => {
  test("only the tab on screen has a count, and it is the shown cards", () => {
    expect(tabCounts("tab:mine", 8, false)).toEqual({ "tab:mine": { n: 8, more: false } });
    expect(tabCounts(null, 8, false)).toEqual({});
  });
  const stub = { views: [], queries: [], save: async () => ({ ok: false }), edit: async () => ({ ok: false }), duplicate: async () => ({ ok: false }), remove: async () => ({ ok: false }) };
  test("a tab with no count draws no number at all", () => {
    const html = renderToStaticMarkup(React.createElement(JiraTabs, {
      views: viewTabs(NO_LAYOUT).map((t) => ({ id: t.id, name: t.name, url: "", addedAt: 0 })), max: 4, current: "tab:mine", counts: tabCounts("tab:mine", 8, false), ctl: stub, canSave: false, onPick() {}, onSaveCurrent() {},
    }));
    expect(html.match(/agx-jt-n /g)?.length).toBe(1);
    expect(html).toContain(">8<");
    expect(html).not.toContain("—");
  });
});

describe("3. the default views", () => {
  test("Mine and Team, each with a sprint twin", () => {
    expect(DEFAULT_VIEWS.map((v) => v.name)).toEqual(["Mine", "Mine · sprint", "Team", "Team · sprint"]);
  });
  test("Mine is me across all spaces; the sprint twin adds the open sprints", () => {
    const [mine, mineSprint] = viewTabs(NO_LAYOUT);
    expect(mine!.jql).toBe("assignee = currentUser()");
    expect(mineSprint!.jql).toBe("assignee = currentUser() AND sprint in openSprints()");
  });
  test("Team is the people picked and only cards that have an assignee", () => {
    const team = DEFAULT_VIEWS.find((v) => v.id === "tab:team")!;
    expect(viewJql(team, { spaces: [], statusPick: [], people: ["acc-1", "acc-2"], tags: [] })).toBe('assignee in ("acc-1", "acc-2") AND assignee is not EMPTY');
    expect(viewJql(team)).toBe("assignee is not EMPTY");
    expect(viewJql(DEFAULT_VIEWS.find((v) => v.id === "tab:team-sprint")!)).toBe("assignee is not EMPTY AND sprint in openSprints()");
  });
  test("spaces narrow the search: one, several, or all", () => {
    const mine = DEFAULT_VIEWS[0]!;
    expect(viewJql(mine, { spaces: ["ORBIT", "ACME"], statusPick: [], people: [], tags: [] })).toBe('assignee = currentUser() AND project in ("ORBIT", "ACME")');
    expect(viewJql(mine)).not.toContain("project");
  });
  test("every view can be dragged, renamed, hidden and restored", () => {
    let l = moveView(NO_LAYOUT, "tab:team", "tab:mine");
    expect(layoutViews(l).map((v) => v.id)).toEqual(["tab:team", "tab:mine", "tab:mine-sprint", "tab:team-sprint"]);
    l = renameView(l, "tab:mine", "My work");
    l = hideView(l, "tab:team-sprint");
    expect(layoutViews(l).map((v) => v.name)).toEqual(["Team", "My work", "Mine · sprint"]);
    expect(layoutViews(resetLayout(l)).map((v) => v.name)).toEqual(["Mine", "Mine · sprint", "Team", "Team · sprint"]);
  });
  test("a layout read back broken is the defaults", () => {
    expect(layoutViews(readLayout({ order: 3, names: [1], hidden: "x" })).length).toBe(4);
    expect(layoutViews(readLayout(null)).length).toBe(4);
  });
});

describe("4. filters set inside a view are kept with it", () => {
  const set = { spaces: ["ORBIT"], statusPick: ["In review"], assigneePick: ["acc-1"], tagPick: ["ux"] };
  test("what is picked comes back on the next visit", () => {
    const l = keepFilters(NO_LAYOUT, "tab:team", pickKept(set));
    expect(restoreKept(readLayout(JSON.parse(JSON.stringify(l))).filters["tab:team"])).toEqual({ ...set, epicPick: [], componentPick: [] });
  });
  test("another view does not get them, and a reset keeps them", () => {
    const l = keepFilters(NO_LAYOUT, "tab:team", pickKept(set));
    expect(restoreKept(l.filters["tab:mine"])).toEqual({ spaces: [], statusPick: [], assigneePick: [], tagPick: [], epicPick: [], componentPick: [] });
    expect(resetLayout(l).filters["tab:team"]).toBeDefined();
  });
  test("the kept spaces and people are in the view's own search", () => {
    const l = keepFilters(NO_LAYOUT, "tab:team", pickKept(set));
    expect(viewTabs(l).find((t) => t.id === "tab:team")!.jql).toBe('assignee in ("acc-1") AND assignee is not EMPTY AND project in ("ORBIT")');
  });
  test("the spaces filter narrows the cards on the list", () => {
    const cards = [card("ORBIT-1"), card("ACME-2")];
    expect(filterCards(cards, { ...NO_FILTERS, spaces: ["ACME"] }).map((t) => t.id)).toEqual(["ACME-2"]);
    expect(filterCards(cards, NO_FILTERS).length).toBe(2);
  });
});

describe("5. Move to current sprint", () => {
  test("names the board's active sprint and the cards", () => {
    expect(sprintMoveAsk({ id: "42", name: "Sprint 14" }, ["ORBIT-1042"])).toEqual({ ok: true, id: "42", keys: ["ORBIT-1042"], said: "Moved ORBIT-1042 to Sprint 14" });
    const many = sprintMoveAsk({ id: "42", name: "Sprint 14" }, ["ORBIT-1", "ORBIT-2"]);
    expect(many.ok && many.said).toBe("Moved 2 cards to Sprint 14");
  });
  test("no active sprint: the action says so and sends nothing", () => {
    expect(sprintMoveAsk(undefined, ["ORBIT-1"])).toEqual({ ok: false, error: "This board has no active sprint to move cards to" });
  });
  test("the card menu offers it, off with the reason when writes are off or there is no sprint", () => {
    const t = card("ORBIT-1");
    const row = (f: Parameters<typeof changeRows>[1]) => changeRows(t, f, "c").find((r) => r.id === "sprint");
    expect(row({ sprint: { name: "Sprint 14" } })?.sub).toBe("Sprint 14");
    expect(row({ sprint: null })?.why).toBe("No active sprint on this board");
    expect(row({ sprint: { name: "Sprint 14" }, writable: false })?.why).toBe("Changes to Jira are off");
    expect(row({})).toBeUndefined();
  });
});

describe("7. deleting a view is obvious and can be undone", () => {
  test("a default view can be deleted and brought back", () => {
    const gone = hideView(NO_LAYOUT, "tab:mine");
    expect(layoutViews(gone).map((v) => v.id)).not.toContain("tab:mine");
    expect(layoutViews(showView(gone, "tab:mine")).map((v) => v.id)).toContain("tab:mine");
  });
  test("the tab menu says Delete, a ⋯ button is on the tab, and the toast carries Undo", async () => {
    const tabs = await Bun.file(new URL("../src/components/jira/list/JiraTabs.tsx", import.meta.url)).text();
    expect(tabs).toContain(">Delete view</MenuRow>");
    expect(tabs).toContain(">Duplicate</MenuRow>");
    expect(tabs).toContain("(isQuery || isDefault(v.id))");
    const view = await Bun.file(new URL("../src/components/jira/list/JiraListView.tsx", import.meta.url)).text();
    expect(view).toContain('label: "Undo"');
  });
});

describe("9. every narrowing is a chip", () => {
  const board = "Assigned to me";
  test("the board's own filter is the first chip and cannot be removed", () => {
    const c = activeChips(NO_FILTERS, board);
    expect(c[0]).toMatchObject({ label: board, board: true });
    expect(c[0]!.clear).toBeUndefined();
  });
  test("personal board + Team view: no board chip, the view's search has no currentUser()", () => {
    const jql = viewJql({ team: true, sprint: true });
    expect(jql).not.toContain("currentUser()");
    const c = activeChips({ ...NO_FILTERS, viewJql: jql, viewCross: true }, board);
    expect(c.some((x) => x.board)).toBe(false);
    expect(c.find((x) => x.id === "view")?.label).toContain("assignee is not EMPTY");
  });
  test("Hide done is a chip by default - the 14 of 45 case", () => {
    expect(activeChips(NO_FILTERS, board).map((c) => c.label)).toEqual([board, "Hide done"]);
    expect(activeChips({ ...NO_FILTERS, showDone: true }, board).map((c) => c.label)).toEqual([board, "Show done"]);
  });
  test("each narrowing names itself and removes only itself", () => {
    const f = { ...NO_FILTERS, mineOnly: true, readyOnly: true, tagPick: ["ux"], statusPick: ["In review"], spaces: ["ORBIT"], assigneePick: ["a"], viewJql: "assignee = currentUser()", query: "login" };
    const by = Object.fromEntries(activeChips(f, board).map((c) => [c.id, c]));
    expect(Object.keys(by)).toEqual(["board", "view", "query", "mine", "people", "spaces", "ready", "tag", "status"]);
    expect(by.mine!.clear).toEqual({ mineOnly: false });
    expect(by.status!.label).toBe("Status: In review");
    expect(by.view!.clear).toEqual({ viewJql: null });
  });
  test("a quick filter of the board is a chip too", () => {
    const c = activeChips({ ...NO_FILTERS, showDone: true, quick: ["q1"] }, board, { q1: "Only my team" });
    expect(c.at(-1)).toMatchObject({ label: "Only my team", clear: { quick: [] } });
  });
  test("Clear all turns every narrowing off, so only the board's scope is left", () => {
    const f = { ...NO_FILTERS, mineOnly: true, readyOnly: true, tagPick: ["ux"], statusPick: ["x"], spaces: ["A"], assigneePick: ["a"], viewJql: "a = b", query: "q", flaggedOnly: true, quick: ["q1"] };
    const after = activeChips({ ...f, ...CLEAR_ALL }, board);
    expect(after.map((c) => c.id)).toEqual(["board", "done"]);
  });
});

describe("10. Mine runs across all spaces", () => {
  const read = (p: string) => require("node:fs").readFileSync(new URL(p, import.meta.url), "utf8") as string;
  test("every default view says its search is cross-space; the site is asked without the board's scope", () => {
    expect(DEFAULT_VIEWS.every((v) => v.cross)).toBe(true);
    expect(jqlScope("board-1", { viewCross: true }, ["q1"])).toEqual({ id: "board-1", quick: ["q1"], cross: true });
    expect(jqlScope("board-1", { viewCross: false }, ["q1"])).toEqual({ id: "board-1", quick: ["q1"] });
    expect(jqlScope(null, { viewCross: true }, [])).toBeUndefined();
  });
  test("the cross flag travels: api adds cross=1, the server skips the board scope for it", () => {
    expect(read("../src/lib/api.ts")).toContain('view.cross ? "&cross=1"');
    expect(read("../../server/src/index.ts")).toContain('url.searchParams.get("cross") !== "1"');
  });
});

describe("11. Save to view", () => {
  const mine = DEFAULT_VIEWS[0]!;
  test("a search typed in the box becomes the view's own, and the tab runs it", () => {
    const l = saveToView(NO_LAYOUT, mine.id, "assignee = currentUser() AND labels = orbit", viewJql(mine, undefined));
    expect(viewTabs(l).find((t) => t.id === mine.id)?.jql).toBe("assignee = currentUser() AND labels = orbit");
    expect(viewTabs(l).find((t) => t.id === DEFAULT_VIEWS[1]!.id)?.jql).toBe(viewJql(DEFAULT_VIEWS[1]!, undefined));
  });
  test("the same text as the built search drops the override; a reset drops it; it survives a reload", () => {
    const l = saveToView(NO_LAYOUT, mine.id, "labels = orbit", viewJql(mine, undefined));
    expect(saveToView(l, mine.id, viewJql(mine, undefined), viewJql(mine, undefined)).jql).toEqual({});
    expect(resetLayout(l).jql).toEqual({});
    expect(readLayout(JSON.parse(JSON.stringify(l))).jql[mine.id]).toBe("labels = orbit");
  });
});

describe("12. Team seeded from a starred filter", () => {
  test("the first filter that is only 'assignee in (...)' gives the people", () => {
    const favs = [{ jql: "project = ORBIT" }, { jql: 'assignee in ("ana", bob, "cy") ORDER BY created' }, { jql: "assignee in (zed)" }];
    expect(teamFromFavourites(favs)).toEqual(["ana", "bob", "cy"]);
  });
  test("no such filter, or one with more clauses or a function, gives nobody (the picker stays)", () => {
    expect(teamFromFavourites([{ jql: "assignee in (ana) AND project = ORBIT" }, { jql: "assignee in membersOf(\"orbit\")" }, { jql: "assignee = ana" }])).toEqual([]);
    expect(teamFromFavourites([])).toEqual([]);
  });
  test("the seeded team is in the Team view's search", () => {
    const team = DEFAULT_VIEWS.find((v) => v.team && !v.sprint)!;
    expect(viewJql(team, { ...NO_VIEW_FILTERS, people: teamFromFavourites([{ jql: "assignee in (ana, bob)" }]) })).toContain('assignee in ("ana", "bob")');
  });
});

describe("Assigned to me is the Mine view", () => {
  test("the sidebar entry maps to the cross-space Mine tab, no board filter", () => {
    const id = meViewTab("me:assigned")!;
    const spec = DEFAULT_VIEWS.find((v) => v.id === id)!;
    expect(spec.name).toBe("Mine");
    expect(spec.cross).toBe(true);
    expect(viewJql(spec)).toBe("assignee = currentUser()");
    expect(meViewTab("board:ORB-1")).toBeNull();
    expect(meViewTab(null)).toBeNull();
  });
});
