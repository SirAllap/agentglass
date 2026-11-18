import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  SEARCH_MIN, countLabel, foldGroups, keyAction, optionText, ownsEnter, orderRows, shelfOf, showSearch, showShelf, stopsOf, type PickRow,
} from "../src/lib/pickerCard.ts";

const R = (id: string, extra: Partial<PickRow> = {}): PickRow => ({ id, label: id, ...extra });

describe("pickerCard decisions", () => {
  test("search hides at six options or fewer", () => {
    expect(showSearch(SEARCH_MIN - 1)).toBe(false);
    expect(showSearch(SEARCH_MIN)).toBe(true);
  });
  test("shelf drops below 180px of room, and when empty", () => {
    expect(showShelf(179, 3)).toBe(false);
    expect(showShelf(180, 3)).toBe(true);
    expect(showShelf(400, 0)).toBe(false);
  });
  test("current first, then newest, then given order; ticking does not reorder", () => {
    const rows = [R("a", { at: 1 }), R("b", { at: 9 }), R("c", { at: 5 }), R("d", { at: 5 })];
    expect(orderRows(rows).map((r) => r.id)).toEqual(["b", "c", "d", "a"]);
    expect(orderRows(rows, { current: new Set(["a"]) }).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });
  test("query matches label and sub-line", () => {
    const rows = [R("orbit", { sub: "~/code/acme/orbit" }), R("lantern", { sub: "~/code/acme/lantern" })];
    expect(orderRows(rows, { query: "ORB" }).map((r) => r.id)).toEqual(["orbit"]);
    expect(orderRows(rows, { query: "acme" })).toHaveLength(2);
  });
  test("shelf keeps recent order, max three, skips unknown ids", () => {
    const rows = ["a", "b", "c", "d"].map((i) => R(i));
    expect(shelfOf(rows, ["c", "zzz", "a", "d", "b"]).map((r) => r.id)).toEqual(["c", "a", "d"]);
  });
  test("groups fold by default and open while searching", () => {
    const rows = [R("x", { group: "G" }), R("y", { group: "G" }), R("z")];
    const folded = foldGroups(rows, new Set(), "");
    expect(folded.groups[0]!.open).toBe(false);
    expect(stopsOf(folded.loose, folded.groups)).toEqual([
      { kind: "row", id: "z" }, { kind: "group", key: "G", open: false },
    ]);
    expect(foldGroups(rows, new Set(), "x").groups[0]!.open).toBe(true);
    expect(foldGroups(rows, new Set(["G"]), "").groups[0]!.open).toBe(true);
  });
  test("keys: walk, open, fold, pick, close", () => {
    const rows = [R("z"), R("x", { group: "G" })];
    const { loose, groups } = foldGroups(rows, new Set(), "");
    const stops = stopsOf(loose, groups); // z, group G (folded)
    expect(keyAction("ArrowDown", stops, 0, false)).toEqual({ do: "move", to: 1 });
    expect(keyAction("ArrowDown", stops, 1, false)).toEqual({ do: "move", to: 1 });
    expect(keyAction("ArrowUp", stops, 0, false)).toEqual({ do: "move", to: 0 });
    expect(keyAction("ArrowRight", stops, 1, false)).toEqual({ do: "open", key: "G" });
    expect(keyAction("ArrowLeft", stops, 1, false)).toEqual({ do: "none" });
    expect(keyAction("Enter", stops, 0, false)).toEqual({ do: "pick", id: "z" });
    expect(keyAction("Enter", stops, 1, false)).toEqual({ do: "open", key: "G" });
    expect(keyAction("Escape", stops, 0, true)).toEqual({ do: "close" });
    expect(keyAction("End", stops, 0, false)).toEqual({ do: "move", to: 1 });
  });
  test("while typing, left/right/Home/End stay with the caret", () => {
    const stops = [{ kind: "group", key: "G", open: true } as const];
    expect(keyAction("ArrowLeft", [...stops], 0, true)).toEqual({ do: "none" });
    expect(keyAction("Home", [...stops], 0, true)).toEqual({ do: "none" });
  });
  test("empty list: keys do nothing but Escape", () => {
    expect(keyAction("ArrowDown", [], 0, false)).toEqual({ do: "none" });
    expect(keyAction("Enter", [], 0, false)).toEqual({ do: "none" });
    expect(keyAction("Escape", [], 0, false)).toEqual({ do: "close" });
  });
  test("count label", () => {
    expect(countLabel(70, 70, "", 0)).toBe("70");
    expect(countLabel(3, 70, "orb")).toBe("3 of 70");
    expect(countLabel(70, 70, "", 2)).toBe("2 picked");
  });
});

describe("PickerCard source rules", () => {
  const src = readFileSync(new URL("../src/components/PickerCard.tsx", import.meta.url), "utf8");
  test("uses house tokens, no raw sizes or z-indexes", () => {
    expect(src).toContain("LAYER.menu");
    expect(src).toContain("ICON.");
    expect(src).toContain("HIT");
    expect(src).toContain("INPUT");
    expect(src).not.toMatch(/zIndex:\s*\d/);
  });
  test("keys come from the pure module and Escape is captured", () => {
    expect(src).toContain("keyAction(");
    expect(src).toContain('addEventListener("keydown"');
  });
  test("BasePicker renders through the card", () => {
    const base = readFileSync(new URL("../src/components/BasePicker.tsx", import.meta.url), "utf8");
    expect(base).toContain("PickerCard");
  });
});

describe("picker card: people and checkout moves", () => {
  const rows = [{ id: "a", label: "Ada" }, { id: "b", label: "Bo" }, { id: "c", label: "Cy" }];
  test("keep leaves the caller's order, even for the current row", () => {
    expect(orderRows(rows, { current: new Set(["c"]), keep: true }).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(orderRows(rows, { keep: true, query: "b" }).map((r) => r.id)).toEqual(["b"]);
  });
  test("remote hands rows back untouched", () => {
    expect(orderRows(rows, { remote: true, query: "zzz" })).toHaveLength(3);
  });
  test("a static group is always open", () => {
    const g = foldGroups([{ id: "a", label: "A", group: "x" }], new Set(), "", false).groups[0]!;
    expect(g.open).toBe(true);
  });
  test("an option reads all of it", () => {
    expect(optionText("acme/orbit-mobile", "branch release/2.14", true)).toBe("acme/orbit-mobile, branch release/2.14, selected");
    expect(optionText("Ada", undefined, false, "reviewer")).toBe("Ada, reviewer, not selected");
  });
  test("the card scales in from 0.97 and stops under reduced motion", () => {
    const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
    expect(css).toContain("scale(0.97)");
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{ \.agx-pick-in \{ animation: none; \} \}/);
  });
});

describe("Enter on a focused control", () => {
  test("a button or role=button keeps its own Enter; the search box and the page do not", () => {
    expect(ownsEnter("Enter", "BUTTON", null)).toBe(true);
    expect(ownsEnter("Enter", "SPAN", "button")).toBe(true);
    expect(ownsEnter("Enter", "INPUT", "combobox")).toBe(false);
    expect(ownsEnter("Enter", "BODY", null)).toBe(false);
    expect(ownsEnter("ArrowDown", "BUTTON", null)).toBe(false);
  });
});
