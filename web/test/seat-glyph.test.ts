import { describe, expect, test } from "bun:test";
import { seatGlyphTone } from "../src/lib/seatGlyph.ts";

describe("which tabs get the seat's glyph", () => {
  test("the seat's pane, idle: the glyph, muted", () => expect(seatGlyphTone(true, null)).toBe("idle"));
  test("the seat's pane, working: the glyph, working tone", () => expect(seatGlyphTone(true, "working")).toBe("working"));
  test("the seat's pane, needs you: the glyph, amber", () => expect(seatGlyphTone(true, "needs-you")).toBe("needs-you"));
  test("another pane: no glyph, draws the ordinary dot", () => expect(seatGlyphTone(false, "working")).toBeNull());
  test("the seat moved on (undefined): no glyph here any more", () => expect(seatGlyphTone(undefined, "working")).toBeNull());
});
