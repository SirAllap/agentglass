import { describe, expect, test } from "bun:test";
import { ctrlAltDigit, moveSlot, slotOrder } from "../src/lib/sessionSlots.ts";

const s = (name: string, created: number) => ({ name, created });
// Two sessions made in the same second, as tmux restore makes them, and one made later.
const listed = [s("acme", 300), s("scratch", 100), s("orbit", 100)];

describe("session slots", () => {
  test("the saved order wins; the rest follow oldest first, then by name; a gone name is skipped", () => {
    expect(slotOrder(listed, []).map((x) => x.name)).toEqual(["orbit", "scratch", "acme"]);
    expect(slotOrder(listed, ["orbit", "gone", "acme"]).map((x) => x.name)).toEqual(["orbit", "acme", "scratch"]);
  });
  test("moving a row swaps it with its neighbour and stops at the ends", () => {
    expect(moveSlot(["orbit", "acme", "scratch"], "scratch", -1)).toEqual(["orbit", "scratch", "acme"]);
    expect(moveSlot(["orbit", "acme"], "orbit", -1)).toEqual(["orbit", "acme"]);
  });
  test("Ctrl+Alt+digit is a slot by code; Alt alone, Shift or a non-digit is not", () => {
    const k = (code: string, m: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }>) =>
      ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...m });
    expect(ctrlAltDigit(k("Digit2", { ctrlKey: true, altKey: true }))).toBe(2);
    expect(ctrlAltDigit(k("Digit2", { altKey: true }))).toBeNull();
    expect(ctrlAltDigit(k("Digit2", { ctrlKey: true, altKey: true, shiftKey: true }))).toBeNull();
    expect(ctrlAltDigit(k("KeyJ", { ctrlKey: true, altKey: true }))).toBeNull();
  });
});
