/*
 * The flag, both ways.
 *
 * ClickUp gives a priority as a WORD on the card it sends back and takes it as a
 * NUMBER on the way in, and the two are written in different places — so the
 * failure this guards is the quiet one: a priority the card can display and the
 * write cannot send, which refuses the press and says "that is not a priority"
 * about a value ClickUp itself just handed over.
 */
import { describe, test, expect } from "bun:test";
import * as CU from "../src/clickup.ts";

const read = (p: string | null) =>
  CU.toTask({ id: "x", name: "n", ...(p ? { priority: { priority: p } } : null) }).priority;

describe("priority, read and written", () => {
  test("every priority the card can show has the number ClickUp takes", () => {
    // The numbers are ClickUp's own, not ours: 1 is the loudest.
    const expected: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 };
    for (const [word, wire] of Object.entries(expected)) {
      expect(read(word)).toBe(word as never);
      expect(CU.PRIORITY_WIRE[read(word)!]).toBe(wire);
    }
  });

  test("a card with no flag reads as none, which is a value and not a gap", () => {
    expect(read(null)).toBe(null);
  });

  test("a word ClickUp never sends has no number, so the write refuses it", () => {
    expect(CU.PRIORITY_WIRE.blocker).toBeUndefined();
  });
});
