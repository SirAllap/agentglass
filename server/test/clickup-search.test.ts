/*
 * Text search, which ClickUp's API does not have.
 *
 * The shape of this is decided by one measurement: a single page of
 * `/team/{id}/task` on his workspace takes sixteen seconds and returns a
 * hundred rows, and there is no `?query=` for a personal token. So the matching
 * is done here, and what is worth pinning is the matcher — every word has to be
 * somewhere, because a hit whose reason cannot be seen reads as noise.
 */
import { describe, expect, test } from "bun:test";
import { matchesText } from "../src/clickup.ts";

const card = (over: Partial<{ title: string; customId: string; id: string; list: string }> = {}) => ({
  title: "Billing | Stop retrying invoices that already settled",
  customId: "ORBIT-1042",
  id: "86xabc003",
  list: "Billing improvements",
  ...over,
});

describe("what counts as a match", () => {
  test("a word from the title", () => {
    expect(matchesText(card(), "retrying")).toBe(true);
    expect(matchesText(card(), "RETRYING")).toBe(true);
  });

  test("every word, not any of them", () => {
    expect(matchesText(card(), "retrying settled")).toBe(true);
    // "billing" is nowhere: a card that matches one word out of two is the
    // noise this rule exists to keep out.
    expect(matchesText(card(), "retrying shipping")).toBe(false);
  });

  test("the ids, both of them, because that is what people paste", () => {
    expect(matchesText(card(), "orbit-1042")).toBe(true);
    expect(matchesText(card(), "86xabc0")).toBe(true);
  });

  test("and the list it lives on", () => {
    expect(matchesText(card(), "improvements")).toBe(true);
  });

  test("an empty query matches nothing rather than everything", () => {
    expect(matchesText(card(), "")).toBe(false);
    expect(matchesText(card(), "   ")).toBe(false);
  });

  test("a card with no custom id is still searchable", () => {
    expect(matchesText(card({ customId: undefined as unknown as string }), "retrying")).toBe(true);
  });
});
