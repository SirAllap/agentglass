import { describe, expect, test } from "bun:test";
import { SECTIONS, filterShortcuts } from "../src/lib/finderShortcuts.ts";
import { finderKey } from "../src/lib/finderKeys.ts";

describe("the shortcut reference", () => {
  test("an empty query lists everything", () => {
    expect(filterShortcuts(SECTIONS, "").flatMap((s) => s.rows).length).toBe(SECTIONS.flatMap((s) => s.rows).length);
  });
  test("a query matches keys and words, case-insensitively, and drops empty sections", () => {
    const f = filterShortcuts(SECTIONS, "ALT+");
    expect(f.map((s) => s.title)).toEqual(["Columns navigation", "Files and selection", "Search and tools"]);
    expect(f.every((s) => s.rows.every((r) => r.keys.includes("Alt")))).toBe(true);
    expect(filterShortcuts(SECTIONS, "hidden").flatMap((s) => s.rows).map((r) => r.keys)).toEqual(["Ctrl+H"]);
    expect(filterShortcuts(SECTIONS, "zzzz")).toEqual([]);
  });
  test("every chord it lists is one the finder answers", () => {
    const k = (key: string, o: { ctrl?: boolean; alt?: boolean } = {}) => finderKey({ key, ctrl: !!o.ctrl, meta: false, shift: false, alt: !!o.alt }, { inField: false, hasSelection: false });
    expect(k("F1")).not.toBeNull();
    for (const [key, o] of [["l", { ctrl: true }], ["h", { ctrl: true }], ["b", { ctrl: true }], ["c", { ctrl: true }], ["ArrowLeft", { alt: true }], ["ArrowRight", { alt: true }], ["ArrowUp", { alt: true }], ["Home", { alt: true }]] as const) {
      expect(k(key, o)).not.toBeNull();
    }
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace", "Home", "End", "Enter", " "]) expect(k(key)).not.toBeNull();
  });
});
