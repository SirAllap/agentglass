import { beforeEach, describe, expect, test } from "bun:test";
import { BOARD_MIN_PX, clampDock, DOCK_BIG_STEP_PX, DOCK_MIN_PX, DOCK_PX, DOCK_STEP_PX, dockKeyWidth, dockMax, dockWidth, FULL_ONLY_PX, LANE_PX } from "../src/lib/prDock.ts";
import { dockPref, setDockPref } from "../src/lib/prDockPref.ts";
import { globalStubs } from "./stubGlobal.ts";

/* The grip on the docked detail's left edge: what its range is, what a key does, what is remembered. */

describe("the range of the dock", () => {
  test("the narrowest is derived from the full-screen-only width, which 2B measured at 320", () => {
    expect(DOCK_MIN_PX).toBe(FULL_ONLY_PX - BOARD_MIN_PX);
    expect(DOCK_MIN_PX).toBe(320);
  });
  test("the widest leaves a whole lane (card 336, air each side, a rail, the scroller's padding) beside it", () => {
    expect(LANE_PX).toBe(336 + 2 * 8 + 7 + 26 + 24);
    expect(dockMax(1400)).toBe(1400 - LANE_PX);
  });
  test("a panel too small for both gets the narrowest, never a negative range", () => {
    expect(dockMax(FULL_ONLY_PX + 1)).toBe(DOCK_MIN_PX);
    expect(dockMax(0)).toBe(DOCK_MIN_PX);
  });
  test("clamps to the range and rounds", () => {
    expect(clampDock(10, 1400)).toBe(DOCK_MIN_PX);
    expect(clampDock(5000, 1400)).toBe(1400 - LANE_PX);
    expect(clampDock(500.6, 1400)).toBe(501);
    expect(clampDock(Number.NaN, 1400)).toBe(DOCK_PX);
  });
  test("a chosen width is the dock's width, clamped to a smaller window rather than rewritten", () => {
    expect(dockWidth(1400, 900)).toBe(900);
    expect(dockWidth(1000, 900)).toBe(1000 - LANE_PX);
    expect(dockWidth(1400, 900)).toBe(900);
    expect(dockWidth(FULL_ONLY_PX, 900)).toBeNull();
  });
});

describe("keys on the focused grip", () => {
  test("ArrowLeft moves the edge left, so the dock grows; ArrowRight shrinks it", () => {
    expect(dockKeyWidth("ArrowLeft", false, 620, 1400)).toBe(620 + DOCK_STEP_PX);
    expect(dockKeyWidth("ArrowRight", false, 620, 1400)).toBe(620 - DOCK_STEP_PX);
  });
  test("Shift is the big step", () => {
    expect(dockKeyWidth("ArrowLeft", true, 620, 1400)).toBe(620 + DOCK_BIG_STEP_PX);
    expect(dockKeyWidth("ArrowRight", true, 620, 1400)).toBe(620 - DOCK_BIG_STEP_PX);
  });
  test("a step stops at the ends", () => {
    expect(dockKeyWidth("ArrowRight", true, DOCK_MIN_PX + 3, 1400)).toBe(DOCK_MIN_PX);
    expect(dockKeyWidth("ArrowLeft", true, dockMax(1400) - 3, 1400)).toBe(dockMax(1400));
  });
  test("Home is the narrowest, End the widest", () => {
    expect(dockKeyWidth("Home", false, 620, 1400)).toBe(DOCK_MIN_PX);
    expect(dockKeyWidth("End", false, 620, 1400)).toBe(dockMax(1400));
  });
  test("any other key is not the grip's", () => {
    expect(dockKeyWidth("a", false, 620, 1400)).toBeNull();
    expect(dockKeyWidth("Tab", false, 620, 1400)).toBeNull();
  });
});

describe("what is remembered", () => {
  const stubGlobal = globalStubs();
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  });
  test("nothing stored is the default", () => {
    expect(dockPref()).toBe(DOCK_PX);
  });
  test("a dragged width comes back", () => {
    setDockPref(733);
    expect(dockPref()).toBe(733);
  });
  test("the default is not written down", () => {
    setDockPref(733); setDockPref(DOCK_PX);
    expect(store.size).toBe(0);
  });
  test("junk in storage is the default", () => {
    store.set("agentglass.pr.dockWidth", "wide");
    expect(dockPref()).toBe(DOCK_PX);
  });
});

/* There is no renderer here: the grip's contract is asserted against its source. */
const grip = await Bun.file(new URL("../src/components/prs/DockGrip.tsx", import.meta.url)).text();
const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
const code = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");

describe("the grip", () => {
  const g = code(grip);
  test("is a vertical separator with its range and a tab stop", () => {
    for (const a of ['role="separator"', 'aria-orientation="vertical"', "aria-valuenow=", "aria-valuemin={DOCK_MIN_PX}", "aria-valuemax=", "tabIndex={0}"]) expect(g).toContain(a);
  });
  test("tracks the pointer by capture, writes the edge directly, and hands the width back on release", () => {
    expect(g).toContain("setPointerCapture(e.pointerId)");
    expect(g).toContain("dock.current.style.flexBasis");
    expect(g).toContain('window.addEventListener("pointermove", move)');
    expect(g).toContain('window.addEventListener("pointerup", up)');
  });
  test("is out of the window's drag region, resets on double-click, and Esc cancels a drag", () => {
    expect(g).toContain("style={NO_DRAG}");
    expect(g).toContain("onDoubleClick={onReset}");
    expect(g).toContain('ev.key === "Escape"');
    expect(g).toContain('window.addEventListener("keydown", esc, true)');
  });
  test("is drawn only on a docked detail, and nothing animates the dock's width", () => {
    expect(code(panel)).toContain('{layout.detail === "docked" && dockPx !== null && (');
    expect(code(panel)).toContain("<DockGrip ");
    expect(css).not.toMatch(/\[data-dock\][^{]*\{[^}]*transition/);
    expect(css).toMatch(/\.agx-prgrip\[data-dragging\]::after/);
  });
  test("the width is read from the person's pref and written on commit and reset", () => {
    const p = code(panel);
    expect(p).toContain("useState(dockPref)");
    expect(p).toContain("setDockPref(px)");
    expect(p).toContain("setDockPref(DOCK_PX)");
  });
});
