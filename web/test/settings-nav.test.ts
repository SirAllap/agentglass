/*
 * The decisions behind the Settings shell (lib/settingsNav.ts): which marks the
 * nav draws, what a shut group says, how a search is grouped and walked, and
 * what "On this page" lists. All pure, so all asserted here; the components
 * only draw what these return.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_SHUT, NAV_GROUPS, NO_FACTS, buildNav, currentToc, groupSearch, headerChips, highlightParts, jumpTarget,
  moveSelection, navMarks, openGroupOf, parseShut, rollup, searchSummary, serializeShut, synonymsUsed, tocItems,
  type NavFacts, type NavGroupId,
} from "../src/lib/settingsNav.ts";

const PAGES = [
  { id: "prefs", label: "Window & startup", group: "General", kw: "" },
  { id: "terminal", label: "Terminal", group: "Workspace", kw: "terminal" },
  { id: "tmux", label: "Pane engine (tmux)", group: "Workspace", kw: "" },
  { id: "hooks", label: "Agents", group: "Agents", kw: "" },
  { id: "plugins", label: "Plugins", group: "Library", kw: "" },
  { id: "notifications", label: "Notifications", group: "General", kw: "sound" },
  { id: "privacy", label: "Data & privacy", group: "System", kw: "" },
  { id: "about", label: "About", group: "System", kw: "" },
  { id: "log", label: "Activity", group: "", kw: "" },
];
const facts = (f: Partial<NavFacts>): NavFacts => ({ ...NO_FACTS, ...f });

describe("the groups", () => {
  test("five that collapse, in the order drawn; System is not among them", () => {
    expect(NAV_GROUPS.map((g) => g.id)).toEqual(["general", "workspace", "agents", "library", "connections"]);
  });

  test("a page is filed under the group its entry names, and System is its own pinned section", () => {
    const m = buildNav(PAGES, {}, new Set());
    expect(m.sections.map((s) => [s.group.id, s.pages.map((p) => p.id)])).toEqual([
      ["general", ["prefs", "notifications"]],
      ["workspace", ["terminal", "tmux"]],
      ["agents", ["hooks"]],
      ["library", ["plugins"]],
    ]);
    expect(m.system?.pages.map((p) => p.id)).toEqual(["privacy", "about"]);
  });

  test("a page in no group (Activity) is in no section; a group with no page is dropped", () => {
    const m = buildNav(PAGES, {}, new Set());
    expect([...m.sections.flatMap((s) => s.pages), ...(m.system?.pages ?? [])].some((p) => p.id === "log")).toBe(false);
    expect(m.sections.some((s) => s.group.id === "connections")).toBe(false);
  });

  test("System never shuts, even if asked", () => {
    const m = buildNav(PAGES, {}, new Set(["system" as NavGroupId]));
    expect(m.system?.shut).toBe(false);
  });
});

describe("a shut group", () => {
  test("remembers nothing but its own ids, and falls back to the default on garbage", () => {
    expect([...parseShut(null)]).toEqual([...DEFAULT_SHUT]);
    expect([...parseShut("not json")]).toEqual([...DEFAULT_SHUT]);
    expect([...parseShut('{"a":1}')]).toEqual([...DEFAULT_SHUT]);
    expect([...parseShut('["agents","system","nope"]')]).toEqual(["agents"]);
    expect(serializeShut(new Set<NavGroupId>(["agents", "general"]))).toBe('["general","agents"]');
    expect([...parseShut("[]")]).toEqual([]);
  });

  test("going to a page opens its group and leaves the others as they were", () => {
    const next = openGroupOf(new Set<NavGroupId>(["library", "agents"]), "library");
    expect([...next]).toEqual(["agents"]);
  });

  test("it carries the number of its pages that want you, and an open one still has it computed", () => {
    const marks = { hooks: { state: "needs", count: 1 } as const, tmux: { state: "needs", count: 1 } as const, terminal: { state: "on" } as const };
    const m = buildNav(PAGES, marks, new Set<NavGroupId>(["workspace"]));
    const ws = m.sections.find((s) => s.group.id === "workspace")!;
    expect(ws.shut).toBe(true);
    expect(ws.rollup).toBe(1);
    expect(m.sections.find((s) => s.group.id === "agents")!.rollup).toBe(1);
    expect(rollup([{ state: "on" }, { state: "off" }, { state: "update" }, { state: "none" }])).toBe(0);
  });
});

describe("the marks come from real facts, and only those", () => {
  test("nothing read yet is nothing drawn", () => {
    expect(navMarks(NO_FACTS)).toEqual({});
  });

  test("hooks and tmux: wired is on, missing wants you", () => {
    expect(navMarks(facts({ hooksWired: true, tmuxOk: true })).hooks).toEqual({ state: "on" });
    const m = navMarks(facts({ hooksWired: false, tmuxOk: false }));
    expect(m.hooks).toMatchObject({ state: "needs", count: 1 });
    expect(m.tmux).toMatchObject({ state: "needs", count: 1 });
  });

  test("Tools & services shows its count only when something wants you", () => {
    expect(navMarks(facts({ connectionsNeed: 0 })).connections).toBeUndefined();
    expect(navMarks(facts({ connectionsNeed: 3 })).connections).toMatchObject({ state: "needs", count: 3 });
  });

  test("on and off for the pages that are switched: remote, jira, lantern, notifications", () => {
    const m = navMarks(facts({ remoteLive: false, jiraConnected: true, lanternWatching: false, notificationsOn: true }));
    expect(m.remote).toEqual({ state: "off" });
    expect(m.jira).toEqual({ state: "on" });
    expect(m.lantern).toEqual({ state: "off" });
    expect(m.notifications).toEqual({ state: "on" });
  });

  test("ClickUp has a mark only while connected (its page is only there then)", () => {
    expect(navMarks(facts({ clickupConnected: true })).clickup).toEqual({ state: "on" });
    expect(navMarks(facts({ clickupConnected: false })).clickup).toBeUndefined();
  });

  test("About: a log with something in it outranks an update, an update outranks nothing", () => {
    expect(navMarks(facts({ logNeed: 2, updateAvailable: true })).about).toMatchObject({ state: "needs", count: 2 });
    expect(navMarks(facts({ logNeed: 0, updateAvailable: true })).about).toMatchObject({ state: "update" });
    expect(navMarks(facts({ logNeed: 0, updateAvailable: false })).about).toBeUndefined();
  });

  test("a page with no fact behind it never gets a mark, whatever else is true", () => {
    const all = navMarks(facts({ hooksWired: true, tmuxOk: true, connectionsNeed: 2, remoteLive: true, logNeed: 1, clickupConnected: true, jiraConnected: true, lanternWatching: true, updateAvailable: true, notificationsOn: true }));
    for (const id of ["prefs", "appearance", "rail", "keys", "terminal", "diff", "browser", "tasks", "engines", "orchestration", "understudy", "budgets", "recipes", "review-prompts", "saved-replies", "plugins", "privacy"]) {
      expect(all[id]).toBeUndefined();
    }
  });
});

describe("page header chips follow the mark", () => {
  test("on and off use the page's own words; a page with none says nothing", () => {
    expect(headerChips("hooks", { state: "on" })).toEqual([{ tone: "ok", text: "Hooks wired" }]);
    expect(headerChips("jira", { state: "off" })).toEqual([{ tone: "off", text: "Not connected" }]);
    expect(headerChips("terminal", { state: "on" })).toEqual([]);
    expect(headerChips("terminal", { state: "none" })).toEqual([]);
  });

  test("needs-you is a count in the right grammar", () => {
    expect(headerChips("hooks", { state: "needs", count: 1 })).toEqual([{ tone: "warn", text: "1 needs you" }]);
    expect(headerChips("connections", { state: "needs", count: 3 })).toEqual([{ tone: "warn", text: "3 need you" }]);
  });

  test("an update is a chip", () => {
    expect(headerChips("about", { state: "update" })).toEqual([{ tone: "info", text: "Update available" }]);
  });
});

describe("search, grouped", () => {
  const model = groupSearch("sound", PAGES, "help");

  test("a page header per page, with its group, and the matching rows under it", () => {
    const n = model.pages.find((p) => p.pane === "notifications")!;
    expect(n.group?.id).toBe("general");
    expect(n.hits.length).toBeGreaterThan(0);
    expect(n.hits.every((h) => h.pane === "notifications")).toBe(true);
    expect(model.flat.length).toBe(model.pages.reduce((a, p) => a + p.hits.length, 0));
  });

  test("the page whose best row ranks first comes first", () => {
    expect(model.pages[0]!.pane).toBe("notifications");
  });

  test("a row carries its hint, so the panel can show the help under the name", () => {
    const h = model.flat.find((x) => x.label === "Notification sound")!;
    expect(h.hint).toContain("Which sound notifications make");
    expect(h.row).toBe("notification-sound");
  });

  test("Names narrows to rows whose own label answers; Names + help also reads hints and sections", () => {
    const help = groupSearch("permissions", PAGES, "help").flat.length;
    const names = groupSearch("permissions", PAGES, "names").flat.length;
    expect(names).toBeLessThan(help);
    for (const h of groupSearch("deny", PAGES, "names").flat) expect(h.label.toLowerCase()).toContain("deny");
  });

  test("a query nothing answers is an empty model", () => {
    const m = groupSearch("zzzqqq", PAGES, "help");
    expect(m.flat).toEqual([]);
    expect(m.pages).toEqual([]);
  });

  test("the summary counts rows and pages in the right plural", () => {
    expect(searchSummary({ pages: [{ pane: "a", label: "A", group: null, hits: [] }], flat: [{ pane: "a", row: "x", label: "x", section: "", hint: "" }] }, " deny ")).toBe("1 setting on 1 page for “deny”");
    expect(searchSummary(groupSearch("zzzqqq", PAGES, "help"), "zzzqqq")).toBe("0 settings on 0 pages for “zzzqqq”");
  });

  test("a word reached only through a synonym is named once", () => {
    const m = groupSearch("chime", PAGES, "help");
    expect(synonymsUsed("chime", m)).toContain("sound");
    expect(synonymsUsed("sound", groupSearch("sound", PAGES, "help"))).not.toContain("sound");
  });
});

describe("the keyboard over results", () => {
  test("↑ and ↓ wrap at both ends and an empty list stays at 0", () => {
    expect(moveSelection(0, 1, 3)).toBe(1);
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(0, -1, 3)).toBe(2);
    expect(moveSelection(0, 1, 0)).toBe(0);
  });

  test("Enter reads the selected row's page and row, or nothing from an empty list", () => {
    const m = groupSearch("sound", PAGES, "help");
    const t = jumpTarget(m, 0)!;
    expect(t.pane).toBe(m.flat[0]!.pane);
    expect(t.row).toBe(m.flat[0]!.row);
    expect(jumpTarget(m, 999)).toEqual({ pane: m.flat.at(-1)!.pane, row: m.flat.at(-1)!.row });
    expect(jumpTarget({ pages: [], flat: [] }, 0)).toBeNull();
  });
});

describe("highlight", () => {
  test("the matched word is flagged wherever it falls, any case", () => {
    expect(highlightParts("Always deny", "deny")).toEqual([{ t: "Always ", hit: false }, { t: "deny", hit: true }]);
    expect(highlightParts("Deny posting, deny it", "deny").filter((p) => p.hit).length).toBe(2);
  });

  test("a regex character in the query is a letter, not a pattern", () => {
    expect(highlightParts("a (b) c", "(b)").filter((p) => p.hit).map((p) => p.t)).toEqual(["(b)"]);
    expect(highlightParts("anything", "")).toEqual([{ t: "anything", hit: false }]);
  });
});

describe("On this page", () => {
  test("one entry per titled card, with the card's badge as its dot", () => {
    const t = tocItems([
      { title: "Claude Code hooks", tone: "ok" },
      { title: "Gate", tone: "warn" },
      { title: "New chats", tone: null },
      { title: "Lost", tone: "checking" },
      { title: "", tone: "ok" },
    ]);
    expect(t.map((x) => [x.label, x.dot])).toEqual([["Claude Code hooks", "ok"], ["Gate", "warn"], ["New chats", null], ["Lost", null]]);
    expect(t[0]!.id).toBe("c-claude-code-hooks");
  });

  test("two cards with one title get distinct anchors", () => {
    const t = tocItems([{ title: "Rules", tone: null }, { title: "Rules", tone: null }]);
    expect(new Set(t.map((x) => x.id)).size).toBe(2);
  });

  test("fewer than two titled cards is no index at all", () => {
    expect(tocItems([{ title: "Only", tone: null }])).toEqual([]);
    expect(tocItems([])).toEqual([]);
  });

  test("the current entry is the last card whose top has reached the header's edge", () => {
    expect(currentToc([300, 700, 1100], 100)).toBe(0);
    expect(currentToc([-50, 400, 900], 120)).toBe(0);
    expect(currentToc([-800, -20, 900], 120)).toBe(1);
    expect(currentToc([-800, -700, -20], 120)).toBe(2);
    // Two columns: the second column's first card (-90) is nearer the line than the
    // first column's second (-100), though it comes later in the DOM than the third (600).
    expect(currentToc([-100, 200, 600, -90, 300], 120)).toBe(3);
    // Equal tops: the earlier card.
    expect(currentToc([40, 40], 120)).toBe(0);
  });
});

describe("the components wire these decisions and nothing else", () => {
  const read = (f: string) => readFileSync(new URL(`../src/components/${f}`, import.meta.url).pathname, "utf8");
  const nav = read("SettingsNav.tsx");
  const modal = read("SettingsModal.tsx");

  test("every page button carries its pane id and says which page is current", () => {
    expect(nav).toContain("data-settings-page={p.id}");
    expect(nav).toContain('aria-current={current === p.id ? "page" : undefined}');
  });

  test("the shut groups are read and written inside try/catch, and drawn from buildNav", () => {
    expect(nav).toMatch(/try \{ return parseShut\(localStorage\.getItem\(NAV_SHUT_KEY\)\)/);
    expect(nav).toMatch(/try \{ localStorage\.setItem\(NAV_SHUT_KEY, serializeShut\(s\)\)/);
    expect(nav).toContain("buildNav(pages, marks, shut)");
  });

  test("the modal draws marks and chips from navMarks, with no mark invented in the component", () => {
    expect(modal).toContain("navMarks({");
    expect(modal).toContain("headerChips(navTab.id, marks[navTab.id] ?? NO_MARK)");
    expect(nav).not.toMatch(/state: "on"|state: "needs"/);
  });

  test("Esc in the box clears the query before the page-level Escape sees it", () => {
    const panel = read("SettingsSearchPanel.tsx");
    expect(panel).toContain('if (e.key === "Escape" && open) { e.stopPropagation(); onQ(""); return; }');
  });

  test("Enter lands through the same path a deep link uses, and flashes the row", () => {
    expect(modal).toContain("onLand={landOnResult}");
    expect(modal).toMatch(/const landOnResult = useCallback\(\(r: \{ pane: string; row: string \}\) => \{\s*setPane\(r\.pane as Pane\);\s*setQ\(""\);\s*if \(r\.row\) setFlashRow\(r\.row\);/);
  });
});

describe("the Plugins page's mark", () => {
  test("waiting on approval beats running, and both come from real counts", () => {
    expect(navMarks(facts({ pluginsRunning: 2, pluginsNeed: 1 })).plugins).toMatchObject({ state: "needs", count: 1 });
    expect(navMarks(facts({ pluginsRunning: 2, pluginsNeed: 0 })).plugins).toMatchObject({ state: "on", count: 2 });
    expect(navMarks(facts({ pluginsRunning: 0, pluginsNeed: 0 })).plugins).toBeUndefined();
    expect(navMarks(NO_FACTS).plugins).toBeUndefined();
  });
  test("the header says how many run", () => {
    expect(headerChips("plugins", { state: "on", count: 2 })).toEqual([{ tone: "ok", text: "2 running" }]);
    expect(headerChips("plugins", { state: "needs", count: 1 })).toEqual([{ tone: "warn", text: "1 needs you" }]);
  });
});
