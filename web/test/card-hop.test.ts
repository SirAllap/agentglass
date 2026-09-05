/*
 * Moving to the next card without closing this one.
 *
 * Two things worth pinning: the title is cut to a fixed width so the header does
 * not resize itself card by card, and the ends of the board are ends — a nav that
 * wraps round from the last card to the first loses your place without saying so.
 */
import { describe, test, expect } from "bun:test";
import { neighbours, shortTitle, hopMatches, HOP_TITLE_MAX } from "../src/lib/cardHop.ts";
import type { ProviderTask } from "../../shared/providers.ts";

const card = (id: string, title = id, customId = ""): ProviderTask =>
  ({ id, title, customId, status: "", assignees: [], tags: [] } as unknown as ProviderTask);

const board = [card("a"), card("b"), card("c")];

describe("the next card", () => {
  test("walks the list in the order it was handed", () => {
    const h = neighbours(board, "b");
    expect([h.prev?.id, h.next?.id, h.i, h.n]).toEqual(["a", "c", 2, 3]);
  });

  test("the ends are ends — nothing wraps round", () => {
    expect(neighbours(board, "a").prev).toBe(null);
    expect(neighbours(board, "c").next).toBe(null);
  });

  test("a card that is not on the board gets no neighbours and says so", () => {
    const h = neighbours(board, "looked-up-by-id");
    expect([h.i, h.prev, h.next]).toEqual([0, null, null]);
  });
});

describe("the title on the button", () => {
  test("a short one is left exactly as it is", () => {
    expect(shortTitle("Fix the picker")).toBe("Fix the picker");
  });

  test("a long one is cut at a word, never through one", () => {
    const long = "Billing | Stop retrying invoices that already settled, behind a kill-switch flag";
    const got = shortTitle(long);
    expect(got.length).toBeLessThanOrEqual(HOP_TITLE_MAX + 1);
    expect(got.endsWith("…")).toBe(true);
    expect(long.startsWith(got.slice(0, -1))).toBe(true);
    expect(got).not.toContain(" …");
  });

  test("one unbroken word is cut anyway rather than overflowing the header", () => {
    const got = shortTitle("x".repeat(80));
    expect(got).toBe(`${"x".repeat(HOP_TITLE_MAX)}…`);
  });
});

describe("the picker's filter", () => {
  const c = card("86xabc003", "Billing | Stop retrying invoices", "ORBIT-1042");
  test("matches the id somebody recognises, ClickUp's own, and the title", () => {
    expect(hopMatches(c, "orbit-1042")).toBe(true);
    expect(hopMatches(c, "86xab")).toBe(true);
    expect(hopMatches(c, "retrying")).toBe(true);
    expect(hopMatches(c, "")).toBe(true);
    expect(hopMatches(c, "unicorn")).toBe(false);
  });
});
