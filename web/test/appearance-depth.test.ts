/*
 * Accent colour — a control that layers on top of a theme without belonging to
 * it.
 */
import { describe, expect, test } from "bun:test";
import { ACCENTS, currentAccent } from "../src/lib/accent.ts";

const isHex = (s: string) => /^#[0-9a-f]{6}$/i.test(s);

describe("accent colours", () => {
  test("a no-override 'Theme' default plus real colours", () => {
    const def = ACCENTS.find((a) => a.id === "");
    expect(def, "the default entry").toBeDefined();
    expect(def!.primary, "default overrides nothing").toBe("");
    const colours = ACCENTS.filter((a) => a.id);
    expect(colours.length).toBeGreaterThanOrEqual(4);
    for (const a of colours) {
      expect(isHex(a.primary), `${a.id} primary = ${a.primary}`).toBe(true);
      expect(isHex(a.hover), `${a.id} hover = ${a.hover}`).toBe(true);
    }
  });

  test("ids are unique", () => {
    const ids = ACCENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("no accent saved → the theme's own primary (empty id)", () => {
    expect(currentAccent()).toBe("");
  });
});
