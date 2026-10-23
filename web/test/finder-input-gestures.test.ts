/*
 * Strata's three gestures that are neither a click nor a key: the rubber band,
 * the slow click that renames, and Ctrl with the wheel. Each decision is pulled
 * out of the screen and tested cell by cell; the wiring is read from source, as
 * there is no renderer here, and scripts/finder-input-drive.ts presses it for real.
 */
import { describe, expect, test } from "bun:test";
import { boxOf, marqueeChoice, single, touches, type Choice } from "../src/lib/finderSelect.ts";
import { MARQUEE_SLOP, SLOW_CLICK_MS, slowClickRenames, startsMarquee, wheelTextStep } from "../src/lib/finderPointer.ts";
import type { Row } from "../src/lib/finderMiller.ts";

const row = (name: string): Row => ({ name, kind: "file", bytes: 1, items: null, mtime: 0, hidden: false });
const rows = ["a", "b", "c", "d", "e"].map(row);
const set = (c: Choice) => [...c.names].sort();

describe("the rubber band", () => {
  test("a box is the same whichever corner the drag started from, and touching is overlap, not containment", () => {
    expect(boxOf({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({ left: 10, top: 20, right: 50, bottom: 80 });
    expect(touches({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 9, top: 9, right: 30, bottom: 30 })).toBe(true);
    expect(touches({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 10, top: 0, right: 30, bottom: 30 })).toBe(false);
  });
  test("no key: the rows touched are the selection, anchor the first and cursor the last in the folder's order", () => {
    const c = marqueeChoice(rows, new Set(["d", "b", "c"]), single("a"), { ctrl: false, shift: false });
    expect(set(c)).toEqual(["b", "c", "d"]);
    expect(c.anchor).toBe("b");
    expect(c.cursor).toBe("d");
  });
  test("Shift adds them to what was selected; Ctrl flips each one against it", () => {
    const from: Choice = { names: new Set(["a", "c"]), anchor: "a", cursor: "c" };
    expect(set(marqueeChoice(rows, new Set(["c", "d"]), from, { ctrl: false, shift: true }))).toEqual(["a", "c", "d"]);
    expect(set(marqueeChoice(rows, new Set(["c", "d"]), from, { ctrl: true, shift: false }))).toEqual(["a", "d"]);
  });
  test("touching nothing selects nothing without a key, and keeps the selection with one", () => {
    expect(set(marqueeChoice(rows, new Set(), single("a"), { ctrl: false, shift: false }))).toEqual([]);
    expect(set(marqueeChoice(rows, new Set(), single("a"), { ctrl: true, shift: false }))).toEqual(["a"]);
  });
  test("it starts from the empty space with the primary button, or from a row with Alt, and only past GTK's drag threshold", () => {
    expect(startsMarquee(0, false, false)).toBe(true);
    expect(startsMarquee(0, true, false)).toBe(false);
    expect(startsMarquee(0, true, true)).toBe(true);
    expect(startsMarquee(2, false, false)).toBe(false);
    expect(startsMarquee(1, false, false)).toBe(false);
    expect(MARQUEE_SLOP).toBe(8);
  });
});

describe("the slow click", () => {
  const base = { soleSelected: true, onName: true, clicks: 1, mods: false, place: "folder" as const };
  test("renames only the sole selected row, clicked once on its name with no key, in a folder", () => {
    expect(slowClickRenames(base)).toBe(true);
    expect(slowClickRenames({ ...base, soleSelected: false })).toBe(false);
    expect(slowClickRenames({ ...base, onName: false })).toBe(false);
    expect(slowClickRenames({ ...base, clicks: 2 })).toBe(false);
    expect(slowClickRenames({ ...base, mods: true })).toBe(false);
    expect(slowClickRenames({ ...base, place: "trash" })).toBe(false);
    expect(slowClickRenames({ ...base, place: "recent" })).toBe(false);
    expect(SLOW_CLICK_MS).toBe(400);
  });
});

describe("Ctrl and the wheel", () => {
  test("a notch away from the person is a size up, towards is a size down", () => {
    expect(wheelTextStep(-100)).toBe(1);
    expect(wheelTextStep(53)).toBe(-1);
    expect(wheelTextStep(0)).toBe(0);
  });
});

const M = "../src/components/finder/machine/";
const [machine, column, views] = await Promise.all(["MachineFinder.tsx", "Column.tsx", "FolderViews.tsx"].map((f) => Bun.file(new URL(M + f, import.meta.url)).text()));
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");

describe("the wiring", () => {
  test("the band starts on the views' mousedown, and the click that ends it clears nothing", () => {
    expect(code(machine!)).toContain("onClick={onEmpty} onMouseDown={onBandDown}");
    expect(code(machine!)).toMatch(/if \(bandEnded\.current\) \{ bandEnded\.current = false; return; \}/);
    expect(code(machine!)).toContain("marqueeChoice(rows, hit, initial, mod)");
  });
  test("the slow click is decided before the pick, a second click or any key cancels it, and every name is marked", () => {
    const fn = code(column!).slice(code(column!).indexOf("export const rowPointer"));
    expect(fn).toMatch(/h\.onSlow\?\.\(r, e\); h\.onPick\(r, modOf\(e\)\);/);
    expect(fn).toMatch(/onDoubleClick: \(e: React\.MouseEvent\) => \{\s*h\.onSlowCancel\?\.\(\);/);
    expect(code(machine!)).toMatch(/cancelSlowRef\.current\(\);[^\n]*\n\s*const k = win;/);
    expect(code(column!)).toContain("<span data-name ");
    expect(code(views!).match(/<span data-name /g)?.length).toBe(2);
  });
  test("Ctrl and the wheel are taken by a listener that is not passive", () => {
    expect(code(machine!)).toMatch(/el\.addEventListener\("wheel", on, \{ passive: false \}\)/);
  });
});
