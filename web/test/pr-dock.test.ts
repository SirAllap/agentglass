import { describe, expect, test } from "bun:test";
import { afterEsc, BOARD_MIN_PX, DOCK_PX, detailBand, dockWidth, escStep, FULL_ONLY_PX, LANE_PX, mastheadPlan, NOTHING_OPEN, openPr, parts, toggleMaximized, type Dock } from "../src/lib/prDock.ts";

const docked: Dock = { selected: 1042, maximized: false };
const full: Dock = { selected: 1042, maximized: true };

describe("opening", () => {
  test("a click docks the pull request beside the board", () => {
    expect(openPr(NOTHING_OPEN, 1042)).toEqual(docked);
  });
  test("a double-click takes the whole panel", () => {
    expect(openPr(NOTHING_OPEN, 1042, "dblclick")).toEqual(full);
    expect(openPr(docked, 1042, "dblclick")).toEqual(full);
  });
  test("another pull request opened from the dock stays docked", () => {
    expect(openPr(docked, 1047)).toEqual({ selected: 1047, maximized: false });
  });
  test("another pull request opened from full screen stays full screen", () => {
    expect(openPr(full, 1047)).toEqual({ selected: 1047, maximized: true });
  });
  test("a panel with no room for a board beside the detail opens full screen on a click", () => {
    expect(openPr(NOTHING_OPEN, 1042, "click", FULL_ONLY_PX)).toEqual(full);
    expect(openPr(NOTHING_OPEN, 1042, "click", FULL_ONLY_PX + 1)).toEqual(docked);
  });
});

describe("the header button", () => {
  test("maximizes a docked pull request and restores a maximized one, keeping the selection", () => {
    expect(toggleMaximized(docked)).toEqual(full);
    expect(toggleMaximized(full)).toEqual(docked);
  });
  test("with nothing open there is nothing to maximize", () => {
    expect(toggleMaximized(NOTHING_OPEN)).toEqual(NOTHING_OPEN);
  });
  test("a panel too narrow for a dock cannot restore into one", () => {
    expect(toggleMaximized(full, FULL_ONLY_PX)).toEqual(full);
  });
});

describe("docked width", () => {
  test("is the mockup's 620 when the panel has room", () => {
    expect(DOCK_PX).toBe(620);
    expect(dockWidth(1400)).toBe(620);
  });
  test("leaves the board a whole lane in a smaller panel (it used to leave only the 240 floor)", () => {
    expect(dockWidth(1000)).toBe(1000 - LANE_PX);
  });
  test("just wider than full-screen-only it is the narrowest dock, which keeps the board's floor", () => {
    expect(dockWidth(FULL_ONLY_PX + 1)).toBe(FULL_ONLY_PX - BOARD_MIN_PX);
  });
  test("is none when the panel is narrow enough that only full screen fits", () => {
    expect(dockWidth(FULL_ONLY_PX)).toBeNull();
    expect(dockWidth(0)).toBeNull();
    expect(dockWidth(Number.NaN)).toBeNull();
  });
});

describe("what is drawn", () => {
  test("nothing open: the list under its own bar", () => {
    expect(parts(NOTHING_OPEN)).toEqual({ list: true, listBar: true, detail: "none" });
  });
  test("docked: the list stays, under the same bar, with the detail beside it", () => {
    expect(parts(docked)).toEqual({ list: true, listBar: true, detail: "docked" });
  });
  test("full screen: the detail replaces the list and brings its own bar with the way back", () => {
    expect(parts(full)).toEqual({ list: false, listBar: false, detail: "full" });
  });
});

describe("Esc, one rung per press", () => {
  const ctx = (o: Partial<Parameters<typeof escStep>[0]> = {}) => ({ dock: docked, overlay: false, typing: false, searchText: false, ...o });
  test("a menu or dialog that is open owns the key", () => {
    expect(escStep(ctx({ overlay: true, searchText: true, dock: full }))).toBe("none");
  });
  test("a field with the caret in it owns the key", () => {
    expect(escStep(ctx({ typing: true }))).toBe("none");
  });
  test("then the search text, before any layout", () => {
    expect(escStep(ctx({ searchText: true, dock: full }))).toBe("clear-search");
  });
  test("then full screen goes back to the dock", () => {
    expect(escStep(ctx({ dock: full }))).toBe("restore");
    expect(afterEsc(full, "restore")).toEqual(docked);
  });
  test("then the dock closes and the selection with it", () => {
    expect(escStep(ctx())).toBe("close");
    expect(afterEsc(docked, "close")).toEqual(NOTHING_OPEN);
  });
  test("with nothing open Esc does nothing", () => {
    expect(escStep(ctx({ dock: NOTHING_OPEN }))).toBe("none");
  });
  test("the rungs walk full -> docked -> nothing in three presses", () => {
    let cur: Dock = full;
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = escStep(ctx({ dock: cur }));
      seen.push(s);
      cur = afterEsc(cur, s);
    }
    expect(seen).toEqual(["restore", "close", "none"]);
    expect(cur).toEqual(NOTHING_OPEN);
  });
  test("clearing the search leaves the layout alone", () => {
    expect(afterEsc(docked, "clear-search")).toEqual(docked);
  });
});

/* The docked header at its real default width (620px) was four lines: the title took a row of its own, and the second row wrapped its worktree sentence, the stack twin, the card and the pin onto a third. */
describe("the header's plan per band", () => {
  test("the default dock is the narrow band, and that band keeps the title on the action row, one line, with the meta row on one line", () => {
    expect(detailBand(DOCK_PX - 32)).toBe("narrow");
    expect(mastheadPlan("narrow")).toEqual({ titleOneLine: true, metaOneRow: true, showQuiet: false });
  });
  test("the wider bands keep today's header: a title that wraps and a meta row that wraps, with every cell drawn", () => {
    for (const b of ["mid", "wide"] as const) expect(mastheadPlan(b)).toEqual({ titleOneLine: false, metaOneRow: false, showQuiet: true });
  });
});
