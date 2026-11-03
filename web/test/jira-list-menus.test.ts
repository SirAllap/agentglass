/*
 * The Jira list's right-click menus: what each one offers and why a row is off (menuModel.ts), the keys that press
 * rows, what a view remembers (pinned / hidden / sidebar names), the request a menu leaves for the card pane, and the
 * source rules that keep the wiring honest (the PR menu's skin, no native title, ClickUp's menu untouched).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ProviderTask } from "../../shared/providers.ts";
import type { JiraLane } from "../src/components/jira/list/model.ts";
import { __resetDockIntent, askDock, getDockIntent, INTENT_MS, takeDockIntent } from "../src/components/jira/list/menus/dockIntent.ts";
import {
  cardMenu, changeRows, jqlUrl, keyAction, keyLabel, keySpec, laneMenu, LETTER, meMenu, menuHead, sortMenu, subtaskMenu, viewMenu, walkIds,
  type JiraMenu, type JiraMenuItem,
} from "../src/components/jira/list/menus/menuModel.ts";
import {
  __resetViewPrefs, arrangeLane, getPrefs, hideCard, NO_PREFS, renameView, setRailHidden, showCards, togglePin, updatePrefs, visibleCards, withPrefs,
} from "../src/components/jira/list/menus/viewPrefs.ts";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();

const card = (id: string, o: Partial<ProviderTask> = {}): ProviderTask =>
  ({
    id, customId: `ORB-${id}`, title: `Card ${id}`, status: "In progress", statusKind: "open", assignees: [], tags: [],
    url: `https://acme.example.net/browse/ORB-${id}`, priority: null, due: null, updated: 0, ...o,
  } as ProviderTask);
const items = (m: JiraMenu): JiraMenuItem[] => [...m.rows.filter((r): r is JiraMenuItem => r.kind === "item"), ...m.more, ...(m.close ? [m.close] : [])];
const byId = (m: JiraMenu, id: string): JiraMenuItem => items(m).find((i) => i.id === id)!;
const press = (key: string, shift = false) => ({ key, shiftKey: shift, ctrlKey: false, metaKey: false, altKey: false });

describe("the card menu", () => {
  const m = cardMenu(card("52", { assignees: ["Ben Okafor"] }), { pr: null, pinned: false });

  test("offers the rows of the mockup, in its sections", () => {
    expect(items(m).map((i) => i.id)).toEqual(["open", "openJira", "move", "assign", "comment", "copyKey", "copyLink", "copyBranch", "pr", "pin", "reread", "hide"]);
    expect(m.rows.filter((r) => r.kind === "heading").map((r) => (r as { text: string }).text)).toEqual(["Card · ORB-52", "Change", "Copy", "Linked"]);
    expect(m.more.length).toBe(3);
  });

  test("the pull request row is off with its reason until a pull request is linked", () => {
    expect(byId(m, "pr").why).toBe("No pull request linked yet");
    const linked = cardMenu(card("52"), { pr: 412, pinned: false });
    expect(byId(linked, "pr").why).toBeUndefined();
    expect(byId(linked, "pr").label).toBe("Open pull request #412");
  });

  test("a pinned card offers to unpin it", () => {
    expect(byId(cardMenu(card("1"), { pr: null, pinned: true }), "pin").label).toBe("Unpin from the top");
  });

  test("the branch name is the house one (case kept, id first)", () => {
    expect(byId(cardMenu(card("52", { title: "Fold 00 shards" }), { pr: null, pinned: false }), "copyBranch").sub).toBe("ORB-52-Fold-00-shards");
  });

  test("no address: open and copy link are off and say so", () => {
    const bare = cardMenu(card("7", { url: "" }), { pr: null, pinned: false });
    expect(byId(bare, "openJira").why).toBe("It has no address");
    expect(byId(bare, "copyLink").why).toBe("It has no address");
  });

  test("the head is the key and the title cut at 30", () => {
    expect(menuHead("ORB-52", "Short")).toBe("ORB-52 · Short");
    const long = menuHead("ORB-52", "Fold 00 shards fail checksum on cold start");
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBe(31);
  });
});

describe("the sub-task menu", () => {
  test("Move to says why a finished sub-task has no step, and Open parent says when it cannot", () => {
    const done = subtaskMenu(card("45", { statusKind: "done", status: "Done" }), { key: "ORB-44", openable: false }, { moves: { to: [] } });
    expect(byId(done, "move").why).toBe("No step from Done");
    expect(byId(done, "parent").why).toBe("Not in this list");
    const open = subtaskMenu(card("46"), { key: "ORB-44", openable: true });
    expect(byId(open, "move").why).toBeUndefined();
    expect(byId(open, "parent").label).toBe("Open parent ORB-44");
    expect(open.more).toEqual([]);
  });
});

describe("the lane menu", () => {
  const lane = (cards: ProviderTask[], o: Partial<Parameters<typeof laneMenu>[0]> = {}) =>
    laneMenu({ status: "In progress", cards, folded: false, sort: "rank", hidden: 0, ...o });

  test("copies and opens the keys of its cards; an empty lane cannot", () => {
    const m = lane([card("44"), card("47"), card("49")]);
    expect(m.head).toBe("In progress · 3 cards");
    expect(byId(m, "copyKeys").label).toBe("Copy the 3 keys");
    expect(byId(m, "copyKeys").sub).toBe("ORB-44, ORB-47, ORB-49");
    const empty = lane([]);
    expect(byId(empty, "copyKeys").why).toBe("No cards in it");
    expect(byId(empty, "openJql").why).toBe("No cards in it");
  });

  test("a folded lane offers to open, and hidden cards offer to come back", () => {
    expect(byId(lane([card("1")], { folded: true }), "collapse").label).toBe("Open lane");
    expect(items(lane([card("1")])).some((i) => i.id === "unhide")).toBe(false);
    expect(byId(lane([card("1")], { hidden: 2 }), "unhide").label).toBe("Show the 2 hidden");
  });

  test("the sort menu marks the current sort and has one letter each", () => {
    const m = sortMenu("In progress", "priority");
    expect(byId(m, "sort:priority").strong).toBe(true);
    const keys = items(m).map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("a search with the keys is built on the first card that has an address", () => {
    const u = jqlUrl([card("1", { url: "" }), card("2")])!;
    expect(u.startsWith("https://acme.example.net/issues/?jql=")).toBe(true);
    expect(decodeURIComponent(u)).toContain("key in (ORB-1, ORB-2)");
    expect(jqlUrl([card("1", { url: "javascript:alert(1)" })])).toBeNull();
    expect(jqlUrl([])).toBeNull();
  });
});

describe("the sidebar menus", () => {
  test("a filter: Edit the search is always off, Take off this bar only for one that is on the bar by itself", () => {
    const own = viewMenu({ name: "Open bugs", listName: undefined }, { cards: 9, address: "https://acme.example.net/issues/?filter=1", own: true });
    expect(byId(own, "edit").why).toBe("Change it in Jira");
    expect(own.close?.id).toBe("takeOff");
    expect(own.close?.danger).toBe(true);
    expect(byId(own, "open").sub).toBe("9 cards");
    const fromFolder = viewMenu({ name: "Open bugs", listName: undefined }, { cards: null, address: undefined, own: false });
    expect(fromFolder.close).toBeNull();
    expect(byId(fromFolder, "copyAddress").why).toBe("It has no address");
  });

  test("Assigned to me: open, read again, and hide (it comes back from the + menu)", () => {
    const m = meMenu(14);
    expect(m.head).toBe("Assigned to me · 14");
    expect(items(m).map((i) => i.id)).toEqual(["open", "reread", "hideRail"]);
    expect(byId(m, "hideRail").why).toBeUndefined();
    expect(byId(m, "hideRail").sub).toBe("Comes back from the + menu");
    expect(byId(meMenu(3, false), "hideRail").why).toBe("Already hidden");
  });
});

describe("the keys", () => {
  const m = cardMenu(card("52"), { pr: null, pinned: false });

  test("a letter presses its row, a disabled one does nothing, Enter is the focused row's", () => {
    expect(keyAction(m, keySpec(press("m")))).toBe("move");
    expect(keyAction(m, keySpec(press("K")))).toBe("copyKey");
    expect(keyAction(m, keySpec(press("p")))).toBeNull();
    expect(keyAction(m, keySpec(press("Enter")))).toBeNull();
  });

  test("the rows folded under More answer to their letters too", () => {
    expect(keyAction(m, "t")).toBe("pin");
    expect(keyAction(m, "h")).toBe("hide");
  });

  test("Ctrl, Meta and Alt are not ours", () => {
    expect(keySpec({ ...press("c"), ctrlKey: true })).toBeNull();
    expect(keySpec({ ...press("c"), metaKey: true })).toBeNull();
    expect(keySpec({ ...press("c"), altKey: true })).toBeNull();
  });

  test("the lane's fold keys are arrows", () => {
    const lane = laneMenu({ status: "Done", cards: [card("1")], folded: false, sort: "rank", hidden: 0 });
    expect(keyAction(lane, keySpec(press("ArrowLeft")))).toBe("collapse");
    expect(keyAction(lane, keySpec(press("ArrowLeft", true)))).toBe("collapseAll");
    expect(keyLabel("Shift+ArrowLeft")).toBe("⇧←");
  });

  test("no letter is bound twice inside a menu, and a letter is the same action's everywhere it appears", () => {
    const menus = [
      m, cardMenu(card("1"), { pr: 3, pinned: true }), subtaskMenu(card("2"), { key: "ORB-1", openable: true }),
      laneMenu({ status: "Done", cards: [card("1")], folded: false, sort: "rank", hidden: 1 }),
      meMenu(null), viewMenu({ name: "x", listName: undefined }, { cards: 1, address: "https://a.example/x", own: true }),
    ];
    for (const menu of menus) {
      const keys = items(menu).map((i) => i.key).filter(Boolean);
      expect(new Set(keys).size).toBe(keys.length);
    }
    const letterOf = new Map<string, string>();
    for (const menu of menus) for (const i of items(menu)) {
      if (!i.key || i.key === LETTER.open) continue;
      const family = i.id.replace(/^(copyKeys)$/, "copyKey").replace(/^openJql$/, "openJira").replace(/^(unhide|hideRail)$/, "hide").replace(/^copyAddress$/, "copyLink");
      const was = letterOf.get(i.key);
      if (was) expect(was).toBe(family);
      letterOf.set(i.key, family);
    }
  });

  test("the arrows walk the rows that are on, then More, then its rows when open", () => {
    expect(walkIds(m, false)).toEqual(["open", "openJira", "move", "assign", "comment", "copyKey", "copyLink", "copyBranch", "more"]);
    expect(walkIds(m, true).slice(-4)).toEqual(["more", "pin", "reread", "hide"]);
  });
});

describe("what a view remembers", () => {
  const lane = (cards: ProviderTask[], sub?: JiraLane[]): JiraLane =>
    ({ status: "In progress", color: undefined, done: false, points: 0, cards, ...(sub ? { sub } : {}) });
  const [a, b, c] = [card("1"), card("2"), card("3")];

  test("pinning puts a card first, the latest pin on top; pinning again lets go", () => {
    let p = togglePin(NO_PREFS, "3");
    p = togglePin(p, "2");
    expect(arrangeLane(lane([a, b, c]), p).cards.map((t) => t.id)).toEqual(["2", "3", "1"]);
    expect(togglePin(p, "2").pinned).toEqual(["3"]);
  });

  test("a hidden card is gone from the lane and from its sub-lanes, and comes back", () => {
    const p = hideCard(NO_PREFS, "2");
    const l = arrangeLane(lane([a, b, c], [lane([b, c])]), p);
    expect(l.cards.map((t) => t.id)).toEqual(["1", "3"]);
    expect(l.sub![0]!.cards.map((t) => t.id)).toEqual(["3"]);
    expect(visibleCards([a, b, c], showCards(p, ["2"])).length).toBe(3);
  });

  test("hiding a pinned card unpins it", () => {
    expect(hideCard(togglePin(NO_PREFS, "2"), "2").pinned).toEqual([]);
  });

  test("prefs that touch nothing hand back the same lane and the same model", () => {
    const l = lane([a, b]);
    expect(arrangeLane(l, NO_PREFS)).toBe(l);
    expect(arrangeLane(l, hideCard(NO_PREFS, "99"))).toBe(l);
    const model = { cards: [a, b], lanes: [l] };
    expect(withPrefs(model, NO_PREFS)).toBe(model);
    expect(withPrefs(model, hideCard(NO_PREFS, "1")).cards.map((t) => t.id)).toEqual(["2"]);
  });

  describe("kept between visits", () => {
    const mem = new Map<string, string>();
    beforeEach(() => {
      mem.clear();
      stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } });
      __resetViewPrefs();
    });

    test("per view, written to localStorage, and a change that changes nothing writes nothing", () => {
      updatePrefs("view-1", (p) => togglePin(p, "1"));
      expect(getPrefs("view-1").pinned).toEqual(["1"]);
      expect(getPrefs("view-2")).toBe(NO_PREFS);
      expect(JSON.parse(mem.get("agentglass.jira.listPrefs")!)["view-1"].pinned).toEqual(["1"]);
      mem.clear();
      updatePrefs("view-1", (p) => p);
      expect(mem.size).toBe(0);
    });

    test("a sidebar row taken off stays off between visits and comes back", () => {
      setRailHidden("me:assigned", true);
      setRailHidden("me:assigned", true);
      expect(JSON.parse(mem.get("agentglass.jira.railHidden")!)).toEqual(["me:assigned"]);
      __resetViewPrefs();
      setRailHidden("me:assigned", false);
      expect(JSON.parse(mem.get("agentglass.jira.railHidden")!)).toEqual([]);
    });

    test("a sidebar name is kept and a blank one forgets it", () => {
      renameView("view-1", "  Mine  ");
      expect(JSON.parse(mem.get("agentglass.jira.viewNames")!)).toEqual({ "view-1": "Mine" });
      renameView("view-1", " ");
      expect(JSON.parse(mem.get("agentglass.jira.viewNames")!)).toEqual({});
    });
  });
});

describe("the card pane's request", () => {
  beforeEach(__resetDockIntent);
  test("each ask is numbered so asking the same thing twice arrives twice", () => {
    expect(getDockIntent()).toBeNull();
    askDock("1", "assign");
    const first = getDockIntent()!;
    askDock("1", "assign");
    expect(getDockIntent()!.seq).toBe(first.seq + 1);
    expect(getDockIntent()).toMatchObject({ id: "1", what: "assign" });
  });
  test("the pane takes it once, only for its own card, and an old one is dropped", () => {
    askDock("1", "move");
    expect(takeDockIntent("2")).toBeNull();
    expect(getDockIntent()).not.toBeNull();
    expect(takeDockIntent("1")).toBe("move");
    expect(takeDockIntent("1")).toBeNull();
    askDock("1", "comment");
    expect(takeDockIntent("1", Date.now() + INTENT_MS + 1)).toBeNull();
    expect(getDockIntent()).toBeNull();
  });
});

describe("Move to / Assign to / Comment", () => {
  const t = card("9", { status: "In progress", assignees: ["Ben Okafor"] });
  test("Move names the next steps, or the real reason it has none", () => {
    expect(byId(cardMenu(t, { pr: null, pinned: false, moves: "reading" }), "move").sub).toBe("Reading the steps…");
    const to = [{ status: "In review", asks: false }, { status: "Done", asks: true }, { status: "Done", asks: false }, { status: "Blocked", asks: false }];
    expect(byId(cardMenu(t, { pr: null, pinned: false, moves: { to } }), "move").sub).toBe("In review, Done +1");
    expect(byId(cardMenu(t, { pr: null, pinned: false, moves: { to: [] } }), "move").why).toBe("No step from In progress");
    expect(byId(cardMenu(t, { pr: null, pinned: false, moves: { error: "x" } }), "move").sub).toBe("Could not read the steps");
  });
  test("with changes off all three say so, and the move reading is not asked", () => {
    const rows = changeRows(t, { writable: false, moves: "reading" }, "c");
    expect(rows.map((r) => r.why)).toEqual(["Changes to Jira are off", "Changes to Jira are off", "Changes to Jira are off"]);
  });
  test("a long status list is one line", () => {
    const m = byId(cardMenu(t, { pr: null, pinned: false, moves: { to: [{ status: "Waiting for the customer", asks: false }, { status: "Ready for release", asks: false }] } }), "move");
    expect(m.sub!.length).toBeLessThanOrEqual(31);
  });
});

describe("the wiring, read as source", () => {
  const dir = new URL("../src/components/jira/list/", import.meta.url);
  const src = (f: string) => readFileSync(new URL(f, dir), "utf8");
  const code = (t: string) => t.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
  const body = (t: string, head: string): string => {
    const at = t.indexOf(head);
    expect(at).toBeGreaterThanOrEqual(0);
    let depth = 0, i = t.indexOf("{", at);
    for (const start = i; i < t.length; i++) {
      if (t[i] === "{") depth++;
      else if (t[i] === "}" && --depth === 0) return t.slice(start, i + 1);
    }
    throw new Error(`no closing brace for ${head}`);
  };

  test("the menu is the PR menu's skin: the shared shell and its row classes, a short list with no drawn scroll thumb", () => {
    const t = code(src("menus/JiraMenu.tsx"));
    expect(t).toContain("<ContextMenu pop");
    for (const c of ["agx-pcm-head", "agx-pcm-item", "agx-pcm-h", "agx-pcm-rule", "agx-pcm-more", "agx-pcm-key"]) expect(t).toContain(c);
  });

  test("no native title tooltip in any menu file", () => {
    for (const f of ["menus/JiraMenu.tsx", "menus/JiraMenuHost.tsx", "menus/JiraRailMenu.tsx"]) expect(code(src(f))).not.toMatch(/\btitle=/);
  });

  test("Move / Assign / Comment open the card and ask the pane for the control", () => {
    const pick = body(src("menus/JiraMenuHost.tsx"), "const onPick = ");
    expect(pick).toMatch(/case "move": case "assign": case "comment": onOpen\(t\); askDock\(t\.id, id\)/);
  });

  test("the card pane takes the request and lands on the control the dock draws", () => {
    const comp = new URL("../src/components/", import.meta.url);
    const card = code(readFileSync(new URL("jira/JiraCard.tsx", comp), "utf8"));
    expect(card).toContain("useDockIntent(t.id,");
    expect(card).toContain("`[data-slot=\"dock\"] [data-dock=\"${land}\"]`");
    expect(card).toContain('data-dock="comment"');
    expect(code(readFileSync(new URL("TrackerStatusPick.tsx", comp), "utf8"))).toContain('data-dock={chip ? "move" : undefined}');
    expect(code(readFileSync(new URL("TrackerPeoplePick.tsx", comp), "utf8"))).toContain('data-dock={bare ? "assign" : undefined}');
  });

  test("Hide takes the built-in row off the rail, the + dialog gives it back, and a copy says so in the footer note", () => {
    const comp = new URL("../src/components/", import.meta.url);
    const panel = code(readFileSync(new URL("TasksPanel.tsx", comp), "utf8"));
    expect(panel).toContain('source.id === "jira" ? all.filter((v) => !railOff.includes(v.id)) : all');
    expect(code(src("menus/JiraRailMenu.tsx"))).toContain('case "hideRail": setRailHidden(v.id, true); return;');
    expect(code(readFileSync(new URL("jira/AddBar.tsx", comp), "utf8"))).toContain("setRailHidden(id, false)");
    const host = code(src("menus/JiraMenuHost.tsx"));
    expect(host).toContain("onNote?.(copiedNote(what))");
    expect(code(src("JiraListView.tsx"))).toContain("onNote: setNote");
  });

  test("the host reads the steps for the menu it raises, and only when changes are on", () => {
    const host = code(src("menus/JiraMenuHost.tsx"));
    expect(host).toContain("TRACKERS.jira.statusOptions(about)");
    expect(host).toContain("if (!about || !writable) return;");
  });

  test("the list wires the handlers into the lanes and the dock and draws the one host", () => {
    const t = code(src("JiraListView.tsx"));
    expect(t).toContain("useJiraMenus(");
    for (const tag of ["JiraLanes", "JiraDock"]) expect(t.match(new RegExp(`<${tag} [\\s\\S]*?/>`))?.[0]).toContain("{...menus.handlers}");
    expect(t).toContain("{menus.host}");
  });

  test("the sidebar draws the Jira menu for Jira and keeps ClickUp's own menu as it was", () => {
    const t = readFileSync(new URL("../src/components/TasksPanel.tsx", import.meta.url), "utf8");
    expect(t).toContain('{menu && source.id === "jira" && (');
    expect(t).toContain('{menu && source.id !== "jira" && (');
    expect(t).toContain("<MenuItem danger onClick={() => void dropBoard(menu.v)}>Take off this bar</MenuItem>");
    expect(t).toContain("Change address…");
  });

  test("the Jira sidebar menu sits outside the ClickUp board pane, which a source with a Main never draws", () => {
    const t = readFileSync(new URL("../src/components/TasksPanel.tsx", import.meta.url), "utf8");
    const pane = t.indexOf("{!Main && <div className=\"flex flex-col min-w-0\" style={{ gridColumn: 2, gridRow: 1 }}>");
    const menu = t.indexOf('{menu && source.id === "jira" && (');
    expect(pane).toBeGreaterThan(0);
    expect(menu).toBeGreaterThan(pane);
    expect(t.slice(pane, menu)).toContain("\n      </div>}\n");
  });
});
