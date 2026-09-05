/*
 * Where a dragged page would land.
 *
 * The HTML5 drag this replaces did nothing at all in the running app, twice,
 * and nothing about it was testable from here — `dragstart` needs a browser to
 * refuse to fire in. What a pointer position MEANS is plain data, and it is the
 * half that decides whether somebody's page ends up where they aimed.
 */
import { describe, expect, test } from "bun:test";
import { DRAG_SLOP, dropsBefore, isDrag, parseDrop } from "../src/lib/browserDrag.ts";

const attrs = (o: Record<string, string>) => (name: string) => o[name] ?? null;

describe("what the thing under the pointer means", () => {
  test("the shortcuts grid", () => {
    expect(parseDrop(attrs({ "data-drop-to": "essentials" }))).toEqual({ spot: { to: "essentials" } });
  });

  test("a folder, by id", () => {
    expect(parseDrop(attrs({ "data-drop-to": "folder", "data-drop-id": "f1" })))
      .toEqual({ spot: { to: "folder", id: "f1" } });
  });

  /* A folder drop with no folder is a bug upstream. Falling back to "the loose
     pins" would move somebody's page somewhere they did not aim at, which is
     worse than the drop doing nothing. */
  test("a folder with no id means nothing rather than something else", () => {
    expect(parseDrop(attrs({ "data-drop-to": "folder" }))).toBe(null);
  });

  /* Both ways, or the shelf is a trap: what goes on it can only come off
     through a menu. */
  test("the list of open tabs, which is how a kept page stops being kept", () => {
    expect(parseDrop(attrs({ "data-drop-to": "tabs", "data-drop-index": "0" })))
      .toEqual({ spot: { to: "tabs" }, index: 0 });
  });

  test("nothing under the pointer is nothing", () => {
    expect(parseDrop(attrs({}))).toBe(null);
    expect(parseDrop(attrs({ "data-drop-to": "" }))).toBe(null);
  });

  test("a row carries where in the list it sits", () => {
    expect(parseDrop(attrs({ "data-drop-to": "loose", "data-drop-index": "2" })))
      .toEqual({ spot: { to: "loose" }, index: 2 });
    // A container has no index, and "the end" is what that means.
    expect(parseDrop(attrs({ "data-drop-to": "loose" }))).toEqual({ spot: { to: "loose" } });
    // Nonsense in the attribute is not an index of NaN.
    expect(parseDrop(attrs({ "data-drop-to": "loose", "data-drop-index": "x" }))).toEqual({ spot: { to: "loose" } });
  });
});

describe("when a press becomes a drag", () => {
  test("not before it has moved", () => {
    expect(isDrag({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(false);
    expect(isDrag({ x: 10, y: 10 }, { x: 10 + DRAG_SLOP - 1, y: 10 })).toBe(false);
  });

  test("and in either direction once it has", () => {
    expect(isDrag({ x: 10, y: 10 }, { x: 10 + DRAG_SLOP, y: 10 })).toBe(true);
    expect(isDrag({ x: 10, y: 10 }, { x: 10, y: 10 - DRAG_SLOP })).toBe(true);
  });
});

describe("which side of a row", () => {
  const row = { top: 100, height: 20 };
  test("above the middle lands before it", () => {
    expect(dropsBefore(row, 104)).toBe(true);
    expect(dropsBefore(row, 116)).toBe(false);
  });
});
