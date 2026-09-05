/*
 * A card moved on its own screen reaches the list behind it.
 *
 * Before: the card screen re-read the card and the Cards tab kept the row it
 * had, so going back showed the old column until a pull-to-refresh. The move
 * had landed on the board and the phone said it had not.
 *
 * Two halves. The pure one — `withCard` — is checked for what it changes and,
 * as carefully, for what it leaves alone: a list re-rendered for a card it does
 * not hold is a FlatList flicker on every edit anywhere in the app. The bus is
 * checked for delivering to the live listeners and no longer to a dead one.
 * The card screen's half — that it SENDS the stamp and ANNOUNCES the answer —
 * is read from the source in card-move.test.ts, the way the hand-off is.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderTask } from "../../shared/providers.ts";
import { announceCard, onCardChanged, withCard } from "../src/state/card-edits.ts";

const card = (id: string, status: string, kind: ProviderTask["statusKind"] = "open"): ProviderTask => ({
  id, title: `Card ${id}`, url: "", status, statusKind: kind,
  priority: null, due: null, updated: 0, tags: [], list: null, assignees: [],
});

describe("withCard", () => {
  const list = [card("1", "To do"), card("2", "To do"), card("3", "Done", "done")];

  test("swaps the row with the same id and keeps the order", () => {
    const moved = card("2", "In progress");
    const next = withCard(list, moved);
    expect(next?.map((t) => t.id)).toEqual(["1", "2", "3"]);
    expect(next?.[1]).toBe(moved);
    expect(next?.[0]).toBe(list[0]);
  });

  test("does not touch the list it was given", () => {
    const before = list.slice();
    withCard(list, card("2", "In progress"));
    expect(list).toEqual(before);
  });

  test("a card this list does not hold changes nothing — the same array comes back", () => {
    // Same reference, so `setTasks` bails out and the FlatList does not redraw.
    expect(withCard(list, card("9", "Done", "done"))).toBe(list);
  });

  test("a list that has not loaded stays not loaded", () => {
    expect(withCard(null, card("1", "Done", "done"))).toBe(null);
  });

  test("the new statusKind rides along, which is what the Open filter reads", () => {
    const next = withCard(list, card("1", "Closed", "done"));
    expect(next?.[0]?.statusKind).toBe("done");
  });
});

describe("the bus", () => {
  test("every listener hears an announcement, once", () => {
    const heard: string[] = [];
    const offA = onCardChanged((t) => heard.push(`a:${t.id}`));
    const offB = onCardChanged((t) => heard.push(`b:${t.id}`));
    announceCard(card("7", "Doing"));
    expect(heard.sort()).toEqual(["a:7", "b:7"]);
    offA(); offB();
  });

  test("an unsubscribed listener hears nothing more", () => {
    // The Cards tab unmounts; a call into its dead setState is a React warning
    // and, on a slow phone, a leak.
    const heard: string[] = [];
    const off = onCardChanged((t) => heard.push(t.id));
    announceCard(card("1", "x"));
    off();
    announceCard(card("2", "x"));
    expect(heard).toEqual(["1"]);
  });

  test("announcing with nobody listening is fine", () => {
    expect(() => announceCard(card("1", "x"))).not.toThrow();
  });
});
