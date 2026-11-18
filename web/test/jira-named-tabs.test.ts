import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SavedView } from "../../shared/providers.ts";
import { MAX_VIEW_TABS, orderTabs, savedQueries, tabRoom, splitTabs } from "../src/components/jira/list/tabsModel.ts";
import { viewTabs, NO_LAYOUT } from "../src/components/jira/list/viewsModel.ts";
import { JiraTabs } from "../src/components/jira/list/JiraTabs.tsx";

const view = (n: number, tab = false): SavedView => ({ id: "jql:" + n, name: "Search " + n, url: "https://orbit.atlassian.net/issues/?jql=" + encodeURIComponent("project = ORBIT AND labels = l" + n), addedAt: 1, ...(tab ? { tab: true } : {}) });

describe("saved searches as tabs, 8 at most", () => {
  const named = viewTabs(NO_LAYOUT);
  test("every search and starred filter is a tab while there is room, a checked one first; a board never is", () => {
    const fav: SavedView = { id: "filter:10042", name: "Orbit team", url: "", addedAt: 0 };
    const board: SavedView = { id: "board:3", name: "ORBIT board", url: "", addedAt: 0 };
    const { list, shown } = orderTabs(named, [view(1), view(2, true), board, fav]);
    expect(list.slice(0, shown).map((v) => v.id)).toEqual([...named.map((n) => n.id), "jql:2", "jql:1", "filter:10042"]);
    expect(list.slice(shown).map((v) => v.id)).toEqual(["board:3"]);
  });
  test("with one default view left, a starred filter sits beside it, not behind More", () => {
    const { list, shown } = orderTabs(named.slice(0, 1), [{ id: "filter:7", name: "Mine and Ada", url: "", addedAt: 0 }]);
    expect(shown).toBe(2);
    expect(list.map((v) => v.id)).toEqual([named[0]!.id, "filter:7"]);
  });
  test("past the cap a checked search stays in More, and the box is out of room", () => {
    const many = [1, 2, 3, 4, 5].map((n) => view(n, true));
    const { shown } = orderTabs(named, many);
    expect(shown).toBe(MAX_VIEW_TABS);
    expect(tabRoom(5, 2)).toBe(true);
    expect(tabRoom(5, 3)).toBe(false);
    expect(tabRoom(4, 3)).toBe(true);
  });
  test("the strip splits where the tabs end, and the tab on screen always has a slot", () => {
    const { list, shown } = orderTabs(named, [view(1), view(2, true)]);
    expect(splitTabs(list, "jql:2", shown).tabs.length).toBe(shown);
    expect(splitTabs(list, "jql:1", shown).tabs.some((v) => v.id === "jql:1")).toBe(true);
  });
  test("the flag survives into the saved query the dialog edits", () => {
    expect(savedQueries([view(1, true), view(2)]).map((q) => !!q.tab)).toEqual([true, false]);
  });
});

describe("the board header's More views menu (already built with the saved-view tabs)", () => {
  const stubCtl = { views: [], queries: [], save: async () => ({ ok: false }), edit: async () => ({ ok: false }), duplicate: async () => ({ ok: false }), remove: async () => ({ ok: false }) };
  test("overflow views are off the strip, and the button names how many: the handoff's board-header ask is this same bar, not a second one", () => {
    const named = viewTabs(NO_LAYOUT);
    const { list, shown } = orderTabs(named, [1, 2, 3, 4, 5, 6].map((n) => view(n)));
    const html = renderToStaticMarkup(React.createElement(JiraTabs, {
      views: list, max: shown, current: "tab:mine", counts: {}, ctl: stubCtl, canSave: false,
      onPick() {}, onSaveCurrent() {},
    }));
    expect(html).toContain("Search 1");
    expect(html).not.toContain("Search 6");
    expect(html).toMatch(/aria-label="More views"/);
    expect(html).toContain(`${list.length - shown} more saved views`);
  });
});

describe("leaving a default tab for a saved search", () => {
  test("the tab's search chip and people go, the space stays", async () => {
    const { leaveTab } = await import("../src/components/jira/list/viewsModel.ts");
    expect(leaveTab(["ORBIT"])).toMatchObject({ spaces: ["ORBIT"], statusPick: [], assigneePick: [], tagPick: [], epicPick: [], componentPick: [], query: "", viewJql: null, viewCross: false });
  });
  test("a list picked in the left bar drops the tab's filters from the board it left, and so does a tab pick", async () => {
    const src = (await Bun.file(new URL("../src/components/jira/list/JiraListView.tsx", import.meta.url)).text() + "\n" + await Bun.file(new URL("../src/components/jira/list/useJiraFilterState.ts", import.meta.url)).text()).split("\n").filter((l) => !l.trim().startsWith("/*") && !l.trim().startsWith("*")).join("\n");
    const effect = src.slice(src.indexOf("const leftKey = useRef(filterKey);"), src.indexOf("}, [filterKey]);", src.indexOf("const leftKey = useRef(filterKey);")));
    expect(effect).toContain("tabOn.current");
    expect(effect).toContain("leaveTab(");
    expect(src).toContain("if (activeTab) onFilters(leaveTab(filters.spaces));");
  });
});
