/*
 * The board's third pass against the mockup: the saved-view tabs, saved searches (star, menu, palette, timing), the
 * card menu, the folds, and a dock that leaves the board three columns at 1600.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import type { SavedView } from "../../shared/providers.ts";
import { columnsThatFit, trackWidth, BOARD_PAD } from "../src/components/jira/list/boardModel.ts";
import { columnsFor, ROW_FOLD } from "../src/components/jira/list/laneModel.ts";
import {
  clampDockResize, DOCK_MAX, DOCK_MIN, dockResizeKey, dockResizeMax, FOLD, MAX_TABS, dockWidth, fuzzyScore, nameForQuery, queryFor, queryTiming, rankQueries, savedQueries, splitTabs, sprintShort, sprintTab,
} from "../src/components/jira/list/tabsModel.ts";
import { jiraQueriesNow, onJiraQueries, publishJiraQueries } from "../src/lib/jiraQueryPalette.ts";
import { onJiraSearch, setJiraSearch } from "../src/lib/jiraSearchBus.ts";

const at = (rel: string) => Bun.file(new URL(rel, import.meta.url)).text();
const css = await at("../src/index.css");
const doc = await at("../../docs/design-system.md");
const view = await at("../src/components/jira/list/JiraListView.tsx");
const board = await at("../src/components/jira/list/JiraBoard.tsx");
const jiraSearchSrc = await at("../src/components/jira/list/JiraSearch.tsx");
const useJiraListSrc = await at("../src/lib/useJiraList.ts");
const palette = await at("../src/components/CommandPalette.tsx");
const sv = (id: string, name: string, jql?: string): SavedView =>
  ({ id, name, url: jql ? `https://orbit.example/issues/?jql=${encodeURIComponent(jql)}` : "", addedAt: 0 });

describe("saved-view tabs", () => {
  const views = ["My sprint", "Security", "Needs review", "All cards", "Backlog", "Archive", "Old"].map((n, i) => sv(`filter:${i}`, n));
  test("five tabs, the rest fold into More", () => {
    const { tabs, more } = splitTabs(views, null);
    expect(MAX_TABS).toBe(5);
    expect(tabs.map((v) => v.name)).toEqual(["My sprint", "Security", "Needs review", "All cards", "Backlog"]);
    expect(more.map((v) => v.name)).toEqual(["Archive", "Old"]);
  });
  test("the view on screen always has a tab", () => {
    const { tabs, more } = splitTabs(views, "filter:6");
    expect(tabs.at(-1)?.name).toBe("Old");
    expect(more.map((v) => v.name)).toContain("Backlog");
  });
  test("the sprint chip reads 'S14 · 6 days left' and is absent without a sprint", () => {
    const now = Date.UTC(2026, 10, 5, 10);
    const s = { id: "1", name: "Sprint 14", state: "active" as const, start: now - 8 * 864e5, end: now + 6 * 864e5 };
    expect(sprintTab(s, now)?.label).toBe("S14 · 6 days left");
    expect(sprintShort("Orbit Sprint")).toBe("Orbit Sprint");
    expect(sprintTab(undefined, now)).toBeNull();
  });
  test("counts show an em dash while loading (the tab uses countLabel)", async () => {
    const { countLabel } = await import("../src/lib/jiraTree.ts");
    expect(countLabel(undefined)).toBe("—");
    expect(countLabel({ n: 12, more: false })).toBe("12");
  });
});

describe("saved searches", () => {
  const list = [sv("jql:a", "Open security", "project = ORBIT AND labels = security"), sv("jql:b", "Mine", "assignee = currentUser()"), sv("filter:1", "Board filter")];
  test("only searches are queries, with the JQL their address keeps", () => {
    expect(savedQueries(list).map((q) => [q.name, q.jql])).toEqual([["Open security", "project = ORBIT AND labels = security"], ["Mine", "assignee = currentUser()"]]);
  });
  test("the box matches a saved search ignoring spacing and case", () => {
    expect(queryFor(savedQueries(list), "  assignee  = CURRENTUSER()")?.id).toBe("jql:b");
    expect(queryFor(savedQueries(list), "")).toBeNull();
  });
  test("fuzzy: in-order letters, tight first; the saved searches rank before anything else in the palette", () => {
    expect(fuzzyScore("sec", "Open security")).not.toBeNull();
    expect(fuzzyScore("zzz", "Open security")).toBeNull();
    expect(rankQueries(savedQueries(list), "mne").map((q) => q.name)).toEqual(["Mine"]);
    expect(rankQueries(savedQueries(list), "").map((q) => q.name)).toEqual(["Open security", "Mine"]);
    expect(palette).toContain("...saved, ...(q ?");
    expect(palette).toContain("setJiraSearch(s.search)");
  });
  test("the palette store and the search bus hand a query to the board", () => {
    let seen = "";
    const off = onJiraSearch((q) => { seen = q; });
    setJiraSearch("assignee = currentUser()");
    off();
    expect(seen).toBe("assignee = currentUser()");
    let n = 0;
    const un = onJiraQueries(() => { n++; });
    publishJiraQueries([{ id: "jql:b", name: "Mine", jql: "x = 1" }]);
    expect(jiraQueriesNow()).toHaveLength(1);
    publishJiraQueries([]);
    un();
    expect(n).toBe(2);
    expect(view).toContain("onJiraSearch((q) => onFilters({ query: q }))");
  });
  test("the timing line and the one-click name", () => {
    expect(queryTiming(12, 83.6)).toBe("12 cards · 84 ms");
    expect(queryTiming(1, 0.2)).toBe("1 card · 1 ms");
    expect(nameForQuery("project = ORBIT ORDER BY created")).toBe("project = ORBIT");
    expect(nameForQuery("x".repeat(60)).length).toBe(40);
  });
  test("Remove is local only and behind a confirm; the site is never written", async () => {
    const parts = await at("../src/components/jira/list/QueryParts.tsx");
    expect(parts).toContain("Remove (local only)");
    expect(parts).toContain("Nothing in Jira is deleted or changed");
    expect(parts).toContain("setConfirm(true)");
    const hook = await at("../src/lib/useJiraSavedViews.ts");
    expect(hook).toContain("api.jiraRemoveView(id)");
    expect(hook).toContain("api.jiraEditView(id, patch)");
  });
  test("the list pane has no network of its own: every call is in a lib hook", () => {
    const dir = new URL("../src/components/jira/list/", import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".tsx") || x.endsWith(".ts"))) {
      const src = readFileSync(new URL(f, dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(src, f).not.toMatch(/\bapi\.jira|\bfetch\(/);
    }
  });
});

describe("the folds", () => {
  test("the container thresholds are the mockup's, each in the stylesheet and the design doc", () => {
    expect(FOLD).toEqual({ labels: 820, tabs: 800, lanes: 1160, row: 900, stack: 560 });
    for (const [px, name] of [[820, "labels"], [800, "tabs"], [560, "stack"]] as const) {
      expect(css, name).toContain(`@container jcq (max-width: ${px}px)`);
    }
    for (const px of [820, 800, 1160, 900, 560, 380]) expect(doc, String(px)).toContain(String(px));
    expect(ROW_FOLD).toBe(FOLD.row);
  });
  test("under 900 the Agent leaves its column for the line under the title", () => {
    expect(columnsFor(1400).stacked).toBe(false);
    expect(columnsFor(1400).pr).toBe(true);
    const narrow = columnsFor(880);
    expect(narrow.stacked).toBe(true);
    expect(narrow.agent).toBe(false);
    expect(narrow.template.split(" ").length).toBeLessThan(columnsFor(1400).template.split(" ").length);
    expect(columnsFor(0).stacked).toBe(false);
  });
  test("the tabs bar shows an edge fade when the strip scrolls, and the step button label is never hidden", () => {
    expect(css).toContain(".agx-jt-wrap[data-l]::before");
    // No rule block that names the label may hide it, wherever it sits (the old regex's [^}]* stopped at the first closing brace).
    const hiding = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].filter((m) => m[1]!.includes(".agx-jt-lbl") && /display:\s*none/.test(m[2]!));
    expect(hiding.map((m) => m[1]!.trim())).toEqual([]);
  });
  test("the NOW row clips instead of spilling out of a very narrow tile", () => {
    const rule = css.match(/\.agx-jt-now \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/overflow:\s*hidden|flex-wrap:\s*wrap/);
  });
});

describe("a card's menu", () => {
  test("the corner '...' and the right-click raise the same menu (Open, Open in Jira, Copy key, Copy link)", async () => {
    expect(board).toContain('className="agx-jb-dots"');
    expect(board).toContain("onClick={(e) => onMenu(e, t)}");
    expect(board).toContain("onContextMenu={onMenu ? (e) => onMenu(e, t) : undefined}");
    const menu = await at("../src/components/jira/list/menus/menuModel.ts");
    for (const id of ['"open"', '"copyKey"']) expect(menu).toContain(id);
    expect(menu).toContain("openInJira(t)");
    expect(menu).toContain("copyLink(t");
    expect(css).toContain(".agx-jb-card:focus-within .agx-jb-dots");
  });
  test("g then 1-9 is a window listener, so focus on the board does not stop it", async () => {
    const tree = await at("../src/components/jira/JiraTree.tsx");
    expect(tree).toContain('window.addEventListener("keydown", h, true)');
    expect(board).not.toMatch(/key === "g"/);
  });
});

describe("the dock keeps the board three columns at 1600", () => {
  test("a 1600 window with the sidebar docked: the dock is at its floor and three columns still fit", () => {
    const row = 1600 - 280 - 48;
    const w = dockWidth(row, "comfortable");
    expect(w).toBeGreaterThanOrEqual(DOCK_MIN);
    expect(w).toBeLessThan(DOCK_MIN + 20);
    expect(columnsThatFit(row - w, "comfortable")).toBe(3);
  });
  test("a wide window gives the dock the mockup's width and no more", () => {
    expect(dockWidth(2400, "comfortable")).toBe(DOCK_MAX);
    expect(dockWidth(0, "comfortable")).toBe(DOCK_MAX);
  });
  test("never under the floor, so the board's own rule (the rail folds first) decides what yields", () => {
    expect(dockWidth(900, "comfortable")).toBe(DOCK_MIN);
    expect(trackWidth(3, "comfortable") + BOARD_PAD + DOCK_MIN).toBe(1268);
  });
});

describe("the dock's hand-dragged width, left-edge grip", () => {
  test("the ceiling is the mockup's 70% of the row, never under the floor", () => {
    expect(dockResizeMax(1200)).toBe(840);
    expect(dockResizeMax(100)).toBe(DOCK_MIN);
  });
  test("a dragged width is pulled into range, not thrown away", () => {
    expect(clampDockResize(200, 1200)).toBe(DOCK_MIN);
    expect(clampDockResize(2000, 1200)).toBe(dockResizeMax(1200));
    expect(clampDockResize(500, 1200)).toBe(500);
    expect(clampDockResize(Number.NaN, 1200)).toBe(DOCK_MIN);
  });
  test("ArrowLeft on the left-edge grip grows the dock (the edge moves left); ArrowRight shrinks it; Home/End are the ends", () => {
    expect(dockResizeKey("ArrowLeft", false, 500, 1200)).toBe(510);
    expect(dockResizeKey("ArrowLeft", true, 500, 1200)).toBe(540);
    expect(dockResizeKey("ArrowRight", false, 500, 1200)).toBe(490);
    expect(dockResizeKey("Home", false, 500, 1200)).toBe(DOCK_MIN);
    expect(dockResizeKey("End", false, 500, 1200)).toBe(dockResizeMax(1200));
    expect(dockResizeKey("Enter", false, 500, 1200)).toBeNull();
  });
  test("the grip is a real separator, house tooltip, never a native title", async () => {
    const grip = await at("../src/components/jira/list/DockWidthGrip.tsx");
    expect(grip).toContain('role="separator"');
    expect(grip).toContain('aria-orientation="vertical"');
    expect(grip).toContain("data-tip={tipAttr(");
    expect(grip).not.toMatch(/\stitle=\{|\stitle="/);
  });
  test("the CSS grip class exists for both panels, Jira's and the pull request's", () => {
    expect(css).toContain(".agx-jdgrip {");
    expect(css).toContain(".agx-prgrip {");
  });
  test("the list wires the view's own width into the dock, and resets it through the same prefs store", () => {
    expect(view).toContain("widthOf(prefs) != null ? clampDockResize(widthOf(prefs)!, rowW) : dockWidth(rowW, density)");
    expect(view).toContain("updatePrefs(viewId, (p) => setWidth(p, px))");
    expect(view).toContain("updatePrefs(viewId, (p) => setWidth(p, null))");
  });
});

describe("Addendum 2: JQL autocomplete", () => {
  test("a failed site read keeps its sentence instead of being dropped, and a successful one clears it", () => {
    expect(useJiraListSrc).toContain("else if (r.error) setQueryError({ q: typed, at: scopeAt, text: r.error });");
    expect(useJiraListSrc).toContain("setQueryError(null); }");
  });
  test("the search box shows the site's own parse error under it, in place of the timing line", () => {
    expect(jiraSearchSrc).toContain("model?.queryError && model.queryError.q === q.trim()");
    expect(jiraSearchSrc).toContain('data-testid="jira-query-error"');
  });
  test("the box reads the JQL context at the caret and offers field, operator or value rows, never a native title", () => {
    expect(jiraSearchSrc).toContain("jqlCursorContext(q, cursor)");
    expect(jiraSearchSrc).toContain("buildCandidates(ctx, vocab, siteValues)");
    expect(jiraSearchSrc).not.toMatch(/\stitle=\{|\stitle="/);
  });
  test("Up/Down move the highlight, Tab or Enter accepts, Esc dismisses the list without clearing the box", () => {
    const d = jiraSearchSrc.slice(jiraSearchSrc.indexOf("onKeyDown={(e) => {"));
    expect(d).toContain('if (showHelp) {');
    expect(d).toContain('setHot((h) => Math.min(h + 1, candidates.length - 1))');
    expect(d).toContain("pick(candidates[helpHot]!)");
    expect(d).toContain("setDismissed(true)");
  });
  test("a chosen value is debounced and the stale one is aborted, like the search box's own site read", async () => {
    const help = await at("../src/lib/jiraJqlHelp.ts");
    expect(help).toContain("signal.addEventListener(\"abort\"");
    expect(help).toContain("const SUGGEST_MS = 200;");
  });
});
