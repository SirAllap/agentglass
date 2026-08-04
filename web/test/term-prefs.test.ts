/*
 * The terminal's own typography prefs — font, size, cursor — kept apart from the
 * app theme because xterm needs the real face and a refit when they change.
 */
import { describe, expect, test } from "bun:test";
import {
  TERM_FONTS, CURSORS, termOptions, currentTermSize, currentTermCursor,
  fontAvailable, SIZE_MIN, SIZE_MAX,
} from "../src/lib/termPrefs.ts";

describe("terminal fonts", () => {
  test("System default, plus named faces that fall back to mono", () => {
    const sys = TERM_FONTS.find((f) => f.id === "");
    expect(sys, "the System default").toBeDefined();
    expect(sys!.stack, "System overrides nothing").toBe("");
    for (const f of TERM_FONTS.filter((f) => f.id)) {
      expect(f.family.length, `${f.id} names a family`).toBeGreaterThan(0);
      expect(f.stack, `${f.id} leads with its family`).toContain(f.family);
      expect(f.stack, `${f.id} ends in a monospace fallback`).toContain("monospace");
    }
  });

  test("System default is always 'available'", () => {
    expect(fontAvailable("")).toBe(true);
  });
});

describe("terminal options", () => {
  test("resolve to sane defaults", () => {
    const o = termOptions();
    expect(o.fontSize).toBeGreaterThanOrEqual(SIZE_MIN);
    expect(o.fontSize).toBeLessThanOrEqual(SIZE_MAX);
    expect(["block", "bar", "underline"]).toContain(o.cursorStyle);
    expect(o.fontFamily).toContain("monospace");
  });

  test("default size and cursor with nothing saved", () => {
    expect(currentTermSize()).toBe(13);
    expect(currentTermCursor()).toBe("block");
  });

  test("three cursor styles", () => {
    expect(CURSORS.map((c) => c.v).sort()).toEqual(["bar", "block", "underline"]);
  });
});
