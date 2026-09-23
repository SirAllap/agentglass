/*
 * The strip grouped by project: the group you are in open, the others folded
 * into chips that still say what their agents are doing.
 *
 * The decisions — which group a window is in, in what order, what a chip says —
 * are in lib/tabGroups.ts and tested there. The strip and the settings row are
 * checked at source level: the panel mounts xterm and a socket.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { TmuxWindow } from "../../shared/types.ts";

const store = new Map<string, string>();
const hadStorage = "localStorage" in globalThis;
const realStorage = (globalThis as { localStorage?: Storage }).localStorage;
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage;
afterAll(() => {
  if (hadStorage) (globalThis as unknown as { localStorage?: Storage }).localStorage = realStorage;
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

const lib = await import("../src/lib/tabGroups.ts");
const { buildGroups, groupOf, parseRules, worthGrouping, OTHER } = lib;

const panel = await Bun.file(new URL("../src/components/TerminalPanel.tsx", import.meta.url).pathname).text();
const settings = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url).pathname).text();

let n = 0;
const win = (over: Partial<TmuxWindow>): TmuxWindow => {
  n++;
  return { id: `@${n}`, index: n, name: `AI0${n}`, active: false, flags: "", ...over };
};

describe("which group a window is in", () => {
  test("its project, by the root's folder name — every worktree answers the main checkout", () => {
    expect(groupOf(win({ repo: "/home/dev/code/orbit" }), [])).toBe("orbit");
  });

  test("the manual override beats everything", () => {
    const w = win({ group: "ops", repo: "/home/dev/code/orbit", name: "agx-bench" });
    expect(groupOf(w, parseRules("agx=acme"))).toBe("ops");
  });

  test("a prefix rule beats the folder — the orchestrator that lives in another repository", () => {
    const w = win({ name: "Agx-orchestrator", repo: "/home/dev/code/acme" });
    expect(groupOf(w, parseRules("agx=orbit"))).toBe("orbit");
    expect(groupOf(w, [])).toBe("acme");
  });

  test("no repository is 'other'", () => {
    expect(groupOf(win({ repo: null }), [])).toBe(OTHER);
    expect(groupOf(win({}), [])).toBe(OTHER);
  });

  test("while the server is still resolving a new directory, the last group holds", () => {
    const w = win({ repo: undefined, cwd: "/home/dev/code/orbit-new" });
    expect(groupOf(w, [], new Map([[w.id, "orbit"]]))).toBe("orbit");
    // A directory in no repository is an answer, not a wait.
    expect(groupOf({ ...w, repo: null }, [], new Map([[w.id, "orbit"]]))).toBe(OTHER);
  });
});

describe("rules from Settings", () => {
  test("pairs, by comma or line; anything else dropped", () => {
    expect(parseRules("agx=agentglass, ops = infra\nbroken\n=x\ny=")).toEqual([
      { prefix: "agx", group: "agentglass" },
      { prefix: "ops", group: "infra" },
    ]);
    expect(parseRules("")).toEqual([]);
  });
});

describe("the groups", () => {
  const ws = [
    win({ index: 1, name: "acme-api", repo: "/c/acme", status: "working" }),
    win({ index: 2, name: "orbit-a", repo: "/c/orbit", status: "done" }),
    win({ index: 3, name: "orbit-b", repo: "/c/orbit-fix", group: "orbit", status: "waiting" }),
    win({ index: 4, name: "notes", repo: null }),
    win({ index: 5, name: "orbit-c", repo: "/c/orbit", pinned: true }),
    win({ index: 6, name: "acme-ci", repo: "/c/acme", status: "idle" }),
  ];
  const gs = buildGroups(ws, []);

  test("in strip order, by each group's lowest index", () => {
    expect(gs.map((g) => g.label)).toEqual(["acme", "orbit", OTHER]);
  });

  test("the override joins the group of the same name, whatever case", () => {
    const orbit = gs.find((g) => g.key === "orbit")!;
    expect(orbit.windows.map((w) => w.name)).toEqual(["orbit-c", "orbit-a", "orbit-b"]);
    const mixed = buildGroups([win({ repo: "/c/Orbit" }), win({ group: "orbit" })], []);
    expect(mixed).toHaveLength(1);
  });

  test("a label is cut the way the server stores a group name, so a drop lands in the same group", () => {
    const long = "/c/" + "a".repeat(40);
    expect(groupOf(win({ repo: long }), [])).toHaveLength(32);
    expect(parseRules("x=" + "b".repeat(31) + " c")[0]!.group).toBe("b".repeat(31));
  });

  test("pinned first inside a group, then tmux's order", () => {
    expect(gs.find((g) => g.key === "orbit")!.windows[0]!.pinned).toBe(true);
  });

  test("a chip carries the most urgent status and every non-idle one, in urgency order", () => {
    const orbit = gs.find((g) => g.key === "orbit")!;
    expect(orbit.status).toBe("waiting");
    expect(orbit.marks).toEqual(["waiting", "done"]);
    const acme = gs.find((g) => g.key === "acme")!;
    expect(acme.marks).toEqual(["working"]);
    expect(gs.find((g) => g.key === OTHER)!.status).toBeUndefined();
  });

  test("one group is no grouping", () => {
    expect(worthGrouping(buildGroups([win({ repo: "/c/orbit" }), win({ repo: "/c/orbit" })], []))).toBe(false);
    expect(worthGrouping(gs)).toBe(true);
  });
});

describe("preferences", () => {
  test("on unless switched off, and a change is announced", () => {
    let told = 0;
    const off = lib.subscribeTabGroups(() => { told++; });
    const v = lib.tabGroupsVersion();
    expect(lib.tabGroupsOn()).toBe(true);
    lib.setTabGroupsOn(false);
    expect(lib.tabGroupsOn()).toBe(false);
    lib.setTabGroupsOn(true);
    expect(store.has("agentglass.tabGroups")).toBe(false); // on is the absence of a key
    expect(told).toBe(2);
    expect(lib.tabGroupsVersion()).toBe(v + 2);
    off();
  });

  test("groups kept open are per tmux session", () => {
    lib.setOpenGroups("desk", new Set(["acme"]));
    expect([...lib.openGroups("desk")]).toEqual(["acme"]);
    expect(lib.openGroups("scratch").size).toBe(0);
    lib.setOpenGroups("desk", new Set());
    expect(lib.openGroups("desk").size).toBe(0);
  });
});

describe("the strip draws them", () => {
  test("flat when grouping is off or there is one group", () => {
    expect(panel).toContain("if (!tabGroups) return tmuxWindows.map(renderTab);");
    expect(panel).toContain("return worthGrouping(gs) ? gs : null;");
  });

  test("the group you are in and the kept-open ones are open; the rest are chips", () => {
    expect(panel).toContain("if (here || keptOpen.has(g.key)) return (");
    expect(panel).toContain("{g.marks.slice(0, 3).map((m) => <StatusMark key={m} status={m} />)}");
  });

  test("a chip names its count and its states in words, not only in colour", () => {
    expect(panel).toMatch(/aria-label=\{`\$\{g\.label\}, \$\{g\.windows\.length\}/);
  });

  test("folded chips sit outside the scrolling row, so an open group cannot push them off screen", () => {
    const scroller = panel.indexOf("<div ref={tabStrip.ref}");
    const chips = panel.indexOf(".map(renderChip)");
    expect(scroller).toBeGreaterThan(-1);
    expect(chips).toBeGreaterThan(scroller);
    // Between the scroller and the bar's right end, and in neither.
    expect(panel.slice(scroller, chips)).not.toContain("{barRight}");
    const between = panel.slice(scroller, chips);
    expect(between.lastIndexOf("{tabGroups && tabGroups.some(")).toBeGreaterThan(between.lastIndexOf("Use tmux's bar"));
    expect(panel.indexOf("{barRight}</div>", chips)).toBeGreaterThan(chips);
  });

  test("Shift+click keeps a group open; a click lists it", () => {
    expect(panel).toContain("if (e.shiftKey) { toggleKeptOpen(g.key); return; }");
    expect(panel).toContain("setGroupMenu({ key: g.key");
  });

  test("dropping a tab on a group or on another group's tab sets @agx-group, and moves nothing", () => {
    expect(panel).toContain('tmuxCmd({ cmd: "group", window: from, name: g.label })');
    const at = panel.indexOf("if (to && groupOfWindow.get(from)?.key !== to.key) {");
    expect(at).toBeGreaterThan(-1);
    const end = panel.indexOf('tmuxCmd({ cmd: "move", window: from, name: String(w.index) });', at);
    expect(end).toBeGreaterThan(at);
    const branch = panel.slice(at, end);
    expect(branch).toContain('tmuxCmd({ cmd: "group", window: from, name: to.label });');
    expect(branch).toContain("return;");
  });

  test("a menu whose group or window has gone is closed, not left to pop back up", () => {
    expect(panel).toContain("if (tabMenu && !tmuxWindows.some((w) => w.id === tabMenu.id)) setTabMenu(null);");
  });

  test("the chips are capped, so many projects cannot squeeze the open tabs to nothing", () => {
    expect(panel).toContain('className="min-w-0 max-w-[45%] flex items-center gap-1 pl-2 overflow-x-auto agw-noscrollbar"');
  });

  test("a tab's menu pins it and moves it between groups", () => {
    expect(panel).toContain('tmuxCmd({ cmd: "pin", window: w.id, after: !w.pinned })');
    expect(panel).toContain('tmuxCmd({ cmd: "group", window: w.id })');
  });

  test("folding does not animate", () => {
    const at = panel.indexOf("const renderChip = (g: TabGroup) => {");
    expect(at).toBeGreaterThan(-1);
    const block = panel.slice(at, panel.indexOf("\n  };\n", at));
    expect(block).not.toContain("motion.");
    expect(block).not.toContain("animation");
  });

  test("Settings can switch it off and hold the name rules", () => {
    expect(settings).toContain('label="Group tabs by project"');
    expect(settings).toContain("onBlur={() => setTabGroupRulesText(groupRules)}");
  });
});
