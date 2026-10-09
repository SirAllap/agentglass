/*
 * The two holds behind the card screen, and what they buy at ClickUp's counter.
 * A fresh hold answers without a request; a stale one is drawn AND re-read; a
 * write that returns the card leaves the comments alone.
 */
import { describe, expect, test } from "bun:test";
import type { TaskDetail } from "../../shared/providers.ts";
import { CARD_FRESH_MS, LIST_FRESH_MS, cardKey, cards, lists } from "../src/state/card-cache.ts";

const detail = (name: string): TaskDetail => ({ task: { id: "c1", title: name } } as unknown as TaskDetail);

describe("freshness", () => {
  test("held and young: no request; held and old: drawn, then asked again", () => {
    cards.clear();
    cards.put("k", detail("a"), 1_000);
    expect(cards.fresh("k", CARD_FRESH_MS, 1_000 + CARD_FRESH_MS - 1)).toBe(true);
    expect(cards.fresh("k", CARD_FRESH_MS, 1_000 + CARD_FRESH_MS)).toBe(false);
    expect(cards.get("k")?.value.task.title).toBe("a"); // still there to draw
  });
  test("a list's statuses are held ten times longer than a card", () => {
    expect(LIST_FRESH_MS).toBeGreaterThanOrEqual(CARD_FRESH_MS * 10);
    lists.clear();
    lists.put("9001", [{ status: "open" }], 0);
    expect(lists.fresh("9001", LIST_FRESH_MS, LIST_FRESH_MS - 1)).toBe(true);
  });
  test("nothing held is never fresh", () => {
    cards.clear();
    expect(cards.fresh("nope", CARD_FRESH_MS)).toBe(false);
    expect(cards.get("nope")).toBeNull();
  });
});

describe("keys and size", () => {
  test("the same id on two computers is two cards", () => {
    expect(cardKey("http://10.0.0.2:4000", "c1")).not.toBe(cardKey("http://10.0.0.9:4000", "c1"));
  });
  test("the oldest goes first, and a touched key is young again", () => {
    cards.clear();
    for (let i = 0; i < 41; i++) cards.put(`k${i}`, detail(String(i)), i);
    expect(cards.get("k0")).toBeNull();
    expect(cards.get("k1")).not.toBeNull();
    cards.put("k1", detail("again"), 100);
    cards.put("k41", detail("x"), 101);
    expect(cards.get("k1")).not.toBeNull();
    expect(cards.get("k2")).toBeNull();
  });
  test("drop forgets one", () => {
    cards.put("z", detail("z"));
    cards.drop("z");
    expect(cards.get("z")).toBeNull();
  });
});
