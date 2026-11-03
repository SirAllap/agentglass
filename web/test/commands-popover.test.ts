/*
 * The Commands popover's decisions: the scrollback row is first and survives a
 * filter that means it, the pin counter and hole, pin rows that read as names,
 * and Settings that opens itself only for a query it can answer.
 */
import { describe, expect, test } from "bun:test";
import { pinCounter, pinRows, settingsOpen, showPinHole, showScrollbackRow } from "../src/lib/commandsPopover.ts";

const decode = (v: string) => (v.startsWith("custom:") ? { label: "clear", cmd: "clear -x" } : null);

describe("the scrollback row", () => {
  test("is there with no filter and for words that mean it", () => {
    expect(showScrollbackRow("")).toBe(true);
    expect(showScrollbackRow("scroll")).toBe(true);
    expect(showScrollbackRow("FIND")).toBe(true);
  });
  test("goes away for a filter that is about something else", () => {
    expect(showScrollbackRow("migrate")).toBe(false);
  });
});

describe("pins", () => {
  test("the counter and the hole", () => {
    expect(pinCounter(2, 5)).toBe("2 of 5");
    expect(showPinHole(0)).toBe(true);
    expect(showPinHole(1)).toBe(false);
  });
  test("a recipe reads as its name, and as a plain label before its list loads", () => {
    const rows = pinRows(["recipe:a1", "recipe:zz", "custom:x", "make test"], [{ id: "a1", name: "Release" }], decode);
    expect(rows.map((r) => r.label)).toEqual(["Release", "Saved command", "clear", "make test"]);
    expect(rows[0]).toMatchObject({ recipeId: "a1", title: "Run Release" });
    expect(rows[2]!.title).toBe("Run clear -x");
    expect(rows[3]!.recipeId).toBeUndefined();
  });
});

describe("settings", () => {
  test("folded by default, open on request, and open for a query it answers", () => {
    expect(settingsOpen(true, "", 24)).toBe(false);
    expect(settingsOpen(false, "", 24)).toBe(true);
    expect(settingsOpen(true, "font", 2)).toBe(true);
    expect(settingsOpen(false, "zzz", 0)).toBe(false);
  });
});
