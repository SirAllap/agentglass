/*
 * Delivery 2, the board's leftovers and the panel's modes: the dock's three places (docked, float, pop out) and maximize,
 * how they are remembered, kept inside the screen and left with the keyboard; the closed spaces' rings; the sprint chip.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { globalStubs } from "./stubGlobal";

const stubGlobal = globalStubs();
const store = new Map<string, string>();
stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000", search: "" });
const M = await import("../src/lib/jiraDockMode.ts");
const { DockLayout, DOCK_W } = await import("../src/components/jira/list/JiraDock.tsx");
const { nextRingRead, RING_READS } = await import("../src/lib/jiraTree.ts");
const { sprintTab } = await import("../src/components/jira/list/tabsModel.ts");
const { dockWidth, DOCK_MIN } = await import("../src/components/jira/list/tabsModel.ts");

const at = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const task = {
  id: "10001", customId: "ORB-9", title: "Merge small segments in a background worker", status: "In progress", statusColor: "#e5a50a", statusKind: "other",
  priority: "High", due: null, updated: 1_700_000_000_000, tags: ["index"], list: "Orbit", assignees: ["Ada Example"], people: [], sprint: "Sprint 18", points: 5,
  parent: { key: "ORB-1", title: "Vector index fold", type: "Epic" }, issueType: "Story", url: "https://acme.example/browse/ORB-9", mine: false,
} as never;
const chromeOf = (html: string) => html.match(/data-slot="dock-chrome".*?<\/span>/s)?.[0] ?? "";
const ctl = (o: Record<string, unknown> = {}) => ({ mode: "dock", maximized: false, at: null, setMode() {}, back() {}, cycle() {}, toggleMax() {}, setMax() {}, moveTo() {}, ...o }) as never;
const draw = (o: Record<string, unknown>) => renderToStaticMarkup(React.createElement(DockLayout, { source: {} as never, card: task, writable: false, onTask() {}, onClose() {}, onAllow() {}, over: false, ...o }));

describe("the modes", () => {
  test("Ctrl+Shift+D cycles dock, float, pop out, bottom and back", () => {
    expect(M.nextMode("dock")).toBe("float");
    expect(M.nextMode("float")).toBe("pop");
    expect(M.nextMode("pop")).toBe("bottom");
    expect(M.nextMode("bottom")).toBe("dock");
  });

  test("the keys: Ctrl+Shift+D cycles, a bare f maximizes, nothing else does", () => {
    const k = (key: string, o: Record<string, boolean> = {}) => M.dockKey({ key, ctrlKey: false, shiftKey: false, metaKey: false, altKey: false, ...o });
    expect(k("D", { ctrlKey: true, shiftKey: true })).toBe("cycle");
    expect(k("d", { ctrlKey: true, shiftKey: true })).toBe("cycle");
    expect(k("f")).toBe("max");
    expect(k("f", { ctrlKey: true })).toBeNull();
    expect(k("F", { shiftKey: true })).toBeNull();
    expect(k("d", { ctrlKey: true })).toBeNull();
  });

  test("Esc undoes the maximize, then returns a pop-out to the dock, then closes", () => {
    expect(M.escStep("pop", true)).toBe("restore");
    expect(M.escStep("dock", true)).toBe("restore");
    expect(M.escStep("pop", false)).toBe("return");
    expect(M.escStep("dock", false)).toBe("close");
    expect(M.escStep("float", false)).toBe("close");
    expect(M.escStep("bottom", false)).toBe("close");
  });

  test("what the window kept is read defensively and written back whole", () => {
    expect(M.parseSaved(null)).toEqual({ mode: "dock", at: null });
    expect(M.parseSaved("not json")).toEqual({ mode: "dock", at: null });
    expect(M.parseSaved('{"mode":"pop"}')).toEqual({ mode: "dock", at: null });
    expect(M.parseSaved('{"mode":"float","at":{"x":120.4,"y":"7"}}')).toEqual({ mode: "float", at: null });
    expect(M.parseSaved('{"mode":"float","at":{"x":120.4,"y":80}}')).toEqual({ mode: "float", at: { x: 120, y: 80 } });
    expect(M.parseSaved('{"mode":"bottom"}')).toEqual({ mode: "bottom", at: null });
  });

  test("storage that throws is never fatal", () => {
    stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} });
    M.__resetDockMode();
    expect(renderToStaticMarkup(React.createElement(DockLayout, { source: {} as never, card: null, writable: false, onTask() {}, onClose() {}, onAllow() {}, over: false }))).toBe("");
    stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
    M.__resetDockMode();
  });

  test("the choice is written under one key, with the float's place", () => {
    expect(at("../src/lib/jiraDockMode.ts")).toContain('"agentglass.jira.dock"');
  });
});

describe("the floating window stays whole inside the screen", () => {
  const view = { w: 1280, h: 800 };
  const size = M.floatSize(view);
  test("size: 520 wide and two thirds tall, shrunk on a narrow screen but never under the dock's 380", () => {
    expect(size).toEqual({ w: 520, h: 528 });
    expect(M.floatSize({ w: 400, h: 600 }).w).toBe(384);
    expect(M.floatSize({ w: 300, h: 600 }).w).toBe(M.FLOAT_MIN_W);
  });
  test("every edge is held", () => {
    expect(M.clampFloat({ x: -50, y: -20 }, size, view)).toEqual({ x: 0, y: 0 });
    expect(M.clampFloat({ x: 5000, y: 5000 }, size, view)).toEqual({ x: 1280 - 520, y: 800 - 528 });
    expect(M.clampFloat({ x: 300, y: 100 }, size, view)).toEqual({ x: 300, y: 100 });
  });
  test("a window bigger than the screen sits at the corner, not off it", () => {
    expect(M.clampFloat({ x: 40, y: 40 }, { w: 900, h: 900 }, { w: 600, h: 600 })).toEqual({ x: 0, y: 0 });
  });
  test("it first opens at the right, under the top bar, and inside", () => {
    expect(M.floatHome(view)).toEqual({ x: 1280 - 520 - 16, y: 90 });
    const h = M.floatHome({ w: 500, h: 400 });
    expect(h.x).toBeGreaterThanOrEqual(0);
    expect(h.y).toBeLessThanOrEqual(400 - M.floatSize({ w: 500, h: 400 }).h);
  });
});

describe("the layout", () => {
  test("docked is the column it was, with the header's one group (side panel, pop out, maximize) in the card", () => {
    const html = draw({ mode: "dock", ctl: ctl() });
    expect(html).toContain('data-mode="dock"');
    expect(html).toContain(`width:${DOCK_W}px`);
    expect(html).toContain('data-slot="dock-chrome"');
    for (const name of ["Dock right", "Pop out", "Maximize", "Move panel"]) expect(html).toContain(name);
    /* Float and the bottom strip are rows of the "..." menu now, not squares. */
    for (const name of ["Dock bottom", "aria-label=\"Float\""]) expect(html).not.toContain(name);
    expect(html).toContain("Merge small segments");
  });
  test("the width rule is the round-3 one: the dock never under 380, the board keeps three columns", () => {
    expect(DOCK_MIN).toBe(380);
    expect(dockWidth(700, "comfortable")).toBe(DOCK_MIN);
    expect(draw({ mode: "dock", width: 300, ctl: ctl() })).toContain(`min-width:${DOCK_MIN}px`);
  });
  test("float is a fixed window inside the screen and no longer takes room from the board", () => {
    const html = draw({ mode: "float", ctl: ctl({ mode: "float", at: { x: 9999, y: 9999 } }) });
    expect(html).toContain('data-mode="float"');
    expect(html).toContain("position:fixed");
    expect(html).not.toContain(`width:${DOCK_W}px`);
    expect(html).toMatch(/left:(\d+)px;top:(\d+)px/);
    const [, l, t] = /left:(\d+)px;top:(\d+)px/.exec(html)!;
    expect(Number(l)).toBeLessThanOrEqual(1280 - 520);
    expect(Number(t)).toBeLessThanOrEqual(800 - 528);
  });
  test("with no card neither the float nor the dock draws anything", () => {
    expect(draw({ mode: "float", card: null })).toBe("");
    expect(draw({ mode: "dock", card: null })).toBe("");
  });
  test("bottom is a strip under the board, full width, no longer the dock's column width", () => {
    const html = draw({ mode: "bottom", ctl: ctl({ mode: "bottom" }) });
    expect(html).toContain('data-mode="bottom"');
    expect(html).toContain("position:absolute");
    expect(html).toContain(`height:${M.BOTTOM_H}px`);
    expect(html).toContain("bottom:0");
    expect(html).not.toContain(`width:${DOCK_W}px`);
    expect(draw({ mode: "bottom", card: null })).toBe("");
  });
  test("pop out is the dialog over the list, wider than the dock, with the same strip", () => {
    const html = draw({ over: true, ctl: ctl({ mode: "pop" }) });
    expect(html).toContain('data-testid="jira-card-over"');
    expect(html).toContain('data-mode="pop"');
    expect(html).toContain("min(1100px, 100%)");
    expect(html).toContain('data-slot="dock-chrome"');
  });
  test("maximize fills the list pane in the dock and in the float", () => {
    for (const mode of ["dock", "float"]) {
      const html = draw({ mode, maximized: true, ctl: ctl({ mode, maximized: true }) });
      expect(html).toContain('data-mode="max"');
      expect(html).toContain("position:absolute");
      expect(html).toContain("inset:0");
    }
  });
  test("the grip cannot drag a pop-out, a bottom dock or a maximized panel", () => {
    expect(draw({ over: true, ctl: ctl({ mode: "pop" }) })).toMatch(/<button[^>]*aria-label="Move panel"[^>]*disabled/);
    expect(draw({ mode: "dock", maximized: true, ctl: ctl({ maximized: true }) })).toMatch(/<button[^>]*aria-label="Move panel"[^>]*disabled/);
    expect(draw({ mode: "bottom", ctl: ctl({ mode: "bottom" }) })).toMatch(/<button[^>]*aria-label="Move panel"[^>]*disabled/);
    expect(draw({ mode: "float", ctl: ctl({ mode: "float" }) })).not.toMatch(/<button[^>]*aria-label="Move panel"[^>]*disabled/);
  });
  test("the dock and the float are one element, so a drag out of the dock keeps what was typed", () => {
    const src = at("../src/components/jira/list/JiraDock.tsx");
    expect(src.match(/<aside ref=\{box\}/g)).toHaveLength(1);
  });
  test("every icon-only control has a tip and a label and no native title", () => {
    const html = draw({ mode: "dock", ctl: ctl() });
    const c = chromeOf(html);
    expect(c).not.toMatch(/\btitle="/);
    expect(c.match(/<button/g)).toHaveLength(6);
    expect(c.match(/aria-label=/g)!.length).toBeGreaterThanOrEqual(6);
    expect(c.match(/data-tip=/g)!.length).toBeGreaterThanOrEqual(6);
  });
  test("the chrome and the dock carry no colour literal", () => {
    for (const f of ["../src/components/jira/list/DockChrome.tsx", "../src/components/jira/list/JiraDock.tsx", "../src/lib/jiraDockMode.ts"]) {
      expect(at(f).replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
    }
  });
  test("the css block is appended last and uses tokens only", () => {
    const css = at("../src/index.css");
    const from = css.indexOf("/* jira dock d2 */");
    expect(from).toBeGreaterThan(0);
    expect(css.slice(from)).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/);
  });
});

describe("closed spaces get their ring", () => {
  const sp = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `S${i}` }));
  test("the first unread space is read, one at a time", () => {
    expect(nextRingRead(sp(3), {})).toBe("S0");
    expect(nextRingRead(sp(3), { S0: { state: "ready" } })).toBe("S1");
    expect(nextRingRead(sp(3), { S0: { state: "loading" } })).toBeNull();
    expect(nextRingRead(sp(3), { S0: { state: "ready" }, S1: { state: "error" }, S2: { state: "ready" } })).toBeNull();
  });
  test("an errored space is not asked again, and no more than 8 are read", () => {
    expect(nextRingRead(sp(2), { S0: { state: "error" } })).toBe("S1");
    expect(RING_READS).toBe(8);
    const all = Object.fromEntries(sp(8).map((s) => [s.key, { state: "ready" }]));
    expect(nextRingRead(sp(12), all)).toBeNull();
  });
});

describe("the sprint chip", () => {
  const DAY = 86_400_000;
  test("reads 'S4 · 6 days left' for the fake site's lively sprint, and is absent without one", () => {
    const now = Date.UTC(2026, 10, 5, 10);
    const s = { id: "41", name: "Sprint 4", state: "active", start: now - 8 * DAY, end: now + 6 * DAY, goal: "" } as never;
    expect(sprintTab(s, now)?.label).toBe("S4 · 6 days left");
    expect(sprintTab(undefined, now)).toBeNull();
  });
});
