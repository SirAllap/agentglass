/*
 * The selection is a choice, and a pointer resting over the list is not one.
 * Reported: a file path clicked in a terminal opened the finder on that file,
 * then the next hover moved the selection to the row under the pointer and the
 * preview jumped to another file.
 */
import { describe, expect, test } from "bun:test";
import { reduceSelection } from "../src/lib/finderSelection.ts";

describe("selection", () => {
  test("hover never changes it", () => {
    // the file opened from the terminal is row 7; the pointer rests on row 2
    expect(reduceSelection(7, { type: "hover", index: 2 }, 20)).toBe(7);
    expect(reduceSelection(7, { type: "hover", index: 7 }, 20)).toBe(7);
  });
  test("a click selects", () => { expect(reduceSelection(7, { type: "click", index: 2 }, 20)).toBe(2); });
  test("keys step and wrap both ways", () => {
    expect(reduceSelection(7, { type: "key", dir: 1 }, 20)).toBe(8);
    expect(reduceSelection(19, { type: "key", dir: 1 }, 20)).toBe(0);
    expect(reduceSelection(0, { type: "key", dir: -1 }, 20)).toBe(19);
  });
  test("a programmatic focus selects, and an index that is not there is ignored", () => {
    expect(reduceSelection(0, { type: "focus", index: 7 }, 20)).toBe(7);
    expect(reduceSelection(3, { type: "focus", index: -1 }, 20)).toBe(3);
    expect(reduceSelection(3, { type: "focus", index: 99 }, 20)).toBe(3);
  });
  test("a rebuilt list starts at the top; a shrunk one clamps", () => {
    expect(reduceSelection(7, { type: "reset" }, 20)).toBe(0);
    expect(reduceSelection(15, { type: "hover", index: 1 }, 5)).toBe(0);
  });
  test("an empty list is row 0", () => {
    for (const ev of [{ type: "key", dir: 1 }, { type: "click", index: 3 }, { type: "reset" }] as const) expect(reduceSelection(4, ev, 0)).toBe(0);
  });
});

describe("the list is wired to it", () => {
  const src = Bun.file(new URL("../src/components/FilePalette.tsx", import.meta.url)).text();
  test("no result row selects on mouse enter", async () => {
    const text = await src;
    const from = text.indexOf("function RowView(");
    expect(from).toBeGreaterThan(0);
    const body = text.slice(from, text.indexOf("\nfunction ", from + 10));
    const code = body.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
    expect(code).not.toContain("onMouseEnter");
    expect(code).not.toContain("onHover");
  });
});
