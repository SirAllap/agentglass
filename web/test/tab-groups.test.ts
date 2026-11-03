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
  // The drawing moved out of the panel into terminal/ (TermStrip, WindowTab,
  // ProjectChip, GoList): same behaviours, new place. Which groups, in what
  // order, with which numbers is lib/stripZones.ts and lib/goList.ts, tested there.
  const dir = (f: string) => readFileSync(new URL(`../src/components/terminal/${f}`, import.meta.url).pathname, "utf8");
  const strip = dir("TermStrip.tsx");
  const chip = dir("ProjectChip.tsx");
  const goList = dir("GoList.tsx");

  test("flat when grouping is off: one project named after the session", () => {
    expect(panel).toContain("if (!groupsOn) return [{ key: sessionKey, label: sessionLabel");
    // The strip is told whether projects exist; off, no labels, keep switches or project menu.
    expect(panel).toContain("projects={groupsOn}");
    // Pin is offered on every strip (flat ones say "Pin first"); the project menu only with projects.
    expect(strip).toContain('{w.pinned ? "Unpin" : projects ? "Pin first in its project" : "Pin first"}');
    expect(strip).toContain("{projects && (");
  });

  test("the project you are in and the kept-open ones are open; the rest live in the Go list", () => {
    expect(strip).toContain("stripZones({ groups, current: p.activeGroup, kept, locked: lockedSession })");
    expect(goList).toContain("Keep in strip");
    expect(goList).toContain("onToggleKept");
  });

  test("the project chip names its count in words, not only in a number", () => {
    expect(chip).toMatch(/aria-label=\{`\$\{name\}, \$\{count\} \$\{count === 1 \? "window" : "windows"\}/);
  });

  test("the Go list is a popover over the strip, so an open project cannot push anything off screen", () => {
    expect(goList).toContain("Portal");
    expect(goList).toContain("NO_DRAG");
    // No folded-chips column left in the row.
    expect(strip).not.toContain("max-w-[45%]");
    expect(panel).not.toContain("renderChip");
  });

  test("Shift+click is gone: keeping a project open is a switch in the Go list, or the project menu", () => {
    expect(panel).not.toContain("e.shiftKey) { toggleKeptOpen");
    expect(strip).toContain("p.onToggleKept(g.key)");
  });

  test("dropping a tab on a project label or on another project's tab sets @agx-group, and moves nothing", () => {
    expect(strip).toContain('cmd({ cmd: "group", window: from, name: g.label })');
    const at = strip.indexOf("if (projects && to && groupOfWindow.get(from)?.key !== to.key) {");
    expect(at).toBeGreaterThan(-1);
    const end = strip.indexOf('cmd({ cmd: "move", window: from, name: String(w.index) });', at);
    expect(end).toBeGreaterThan(at);
    const branch = strip.slice(at, end);
    expect(branch).toContain('cmd({ cmd: "group", window: from, name: to.label });');
    expect(branch).toContain("return;");
  });

  test("a menu whose project or window has gone is closed, not left to pop back up", () => {
    expect(strip).toContain("if (tabMenu && !windows.some((w) => w.id === tabMenu.id)) setTabMenu(null);");
    expect(strip).toContain("if (projMenu && !groups.some((g) => g.key === projMenu.key)) setProjMenu(null);");
  });

  test("a tab's menu pins it and moves it between projects", () => {
    expect(strip).toContain('cmd({ cmd: "pin", window: w.id, after: !w.pinned })');
    expect(strip).toContain('cmd({ cmd: "group", window: w.id })');
  });

  test("a project's menu renames it, keeps it open, empties it into Other, closes it", () => {
    expect(strip).toContain("Rename project");
    expect(strip).toContain("Keep open in the strip");
    expect(strip).toContain('name: "Other"');
    expect(strip).toContain("Close all windows");
  });

  test("the tabs slide 160 ms on a project change, and not at all with reduced motion", () => {
    expect(strip).toContain("agx-strip-swap");
    const css = readFileSync(new URL("../src/index.css", import.meta.url).pathname, "utf8");
    expect(css).toContain("animation: agx-strip-swap 160ms");
    expect(css).toMatch(/prefers-reduced-motion[\s\S]*\.agx-strip-swap > \* \{ animation: none; \}/);
  });

  test("Settings can switch it off and hold the name rules", () => {
    expect(settings).toContain('label="Group tabs by project"');
    expect(settings).toContain(`onBlur={() => { setting("terminal.tabGroupRules").set(groupRules); }}`);
  });
});
