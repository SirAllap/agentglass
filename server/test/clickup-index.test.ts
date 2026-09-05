/*
 * THE ANSWER THAT DOES NOT NEED THE NETWORK.
 *
 * ClickUp's API has no text search, so "which cards mention this one" means
 * downloading the cards and reading their bodies: measured on a real
 * workspace, three hundred cards with bodies take about 45 seconds. That
 * answer used to live in memory and die with the process, so the first search
 * after every restart paid the 45 seconds — which is exactly when somebody
 * searches.
 *
 * What is pinned here is the index's own promises: it remembers what a sweep
 * read, it answers by the same rule the live search uses, and a cheap read
 * never erases the expensive field.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import * as Index from "../src/clickupindex.ts";
import type { ProviderTask } from "../../shared/providers.ts";

const card = (over: Partial<ProviderTask> & { body?: string }) => ({
  id: "c1", customId: "ORBIT-2077", title: "Pagination arrows behave as if on page 1",
  url: "", status: "in development", statusKind: "active", tags: [], list: "Miscellaneous",
  assignees: [], people: [], updated: 1000,
  ...over,
}) as Index.IndexedCard;

beforeEach(() => Index.forget());

describe("what the sweep wrote down", () => {
  test("a card is found by its title, its id and its list", () => {
    Index.remember([card({})]);
    expect(Index.named("pagination").map((c) => c.id)).toEqual(["c1"]);
    expect(Index.named("orbit-2077").map((c) => c.id)).toEqual(["c1"]);
    expect(Index.named("miscellaneous").map((c) => c.id)).toEqual(["c1"]);
  });

  test("a body that mentions another card by id is the whole point of keeping it", () => {
    Index.remember([card({ id: "c2", body: "Found while looking at ORBIT-1042, same list." })]);
    expect(Index.mentioning("1042").map((c) => c.id)).toEqual(["c2"]);
  });

  test("digits inside a longer number are not a mention", () => {
    Index.remember([card({ id: "c3", body: "call 891042 was answered by an agent" })]);
    expect(Index.mentioning("1042"), "the SQL narrows, the shared rule decides").toEqual([]);
  });

  test("a page read without bodies does not erase the body a heavier read found", () => {
    Index.remember([card({ id: "c4", body: "mentions ORBIT-1042" })]);
    /* The light sweep sees the same card and carries no body at all. */
    Index.remember([card({ id: "c4", title: "renamed by somebody" })]);
    expect(Index.mentioning("1042").map((c) => c.id), "the cheap sweep forgot the expensive field").toEqual(["c4"]);
    expect(Index.named("renamed")[0]?.title).toBe("renamed by somebody");
  });

  test("what it holds is countable, so \"was an instant answer possible\" has an answer", () => {
    Index.remember([card({ id: "a" }), card({ id: "b", body: "x" })]);
    expect(Index.indexed()).toEqual({ cards: 2, withBody: 1 });
  });

  test("and a card comes back as the panel's own shape, not as a row", () => {
    Index.remember([card({ id: "c5", body: "kept aside" })]);
    const [got] = Index.named("pagination");
    expect(got?.customId).toBe("ORBIT-2077");
    expect(got?.list).toBe("Miscellaneous");
  });
});

/*
 * WHAT A NOTIFICATION SAID, ON THE CARD IT WAS ABOUT.
 *
 * He was told "Irra assigned this task to: javi" and the card's Activity
 * showed nothing — because that sentence came from ClickUp's own desktop
 * notification, which this machine mirrors, while the Activity is built from
 * an API that reports no assignment at all.
 */
describe("notifications kept against a card", () => {
  test("a note is found by the card's own id and by its human one", () => {
    Index.rememberNote({ id: "n1", cardId: "c9", label: "ORBIT-1042", text: "Ada assigned this task to: Sam", at: 10 });
    expect(Index.notesAbout("c9", "").map((n) => n.text)).toEqual(["Ada assigned this task to: Sam"]);
    expect(Index.notesAbout("", "ORBIT-1042").map((n) => n.text)).toEqual(["Ada assigned this task to: Sam"]);
  });

  test("the same notification arriving twice is kept once", () => {
    Index.rememberNote({ id: "n2", cardId: "c9", label: "", text: "Ada moved this task", at: 20 });
    Index.rememberNote({ id: "n2", cardId: "c9", label: "", text: "Ada moved this task", at: 20 });
    expect(Index.notesAbout("c9", "").filter((n) => n.text === "Ada moved this task")).toHaveLength(1);
  });

  test("oldest first, which is the order a card is read in", () => {
    Index.rememberNote({ id: "n3", cardId: "c10", label: "", text: "second", at: 200 });
    Index.rememberNote({ id: "n4", cardId: "c10", label: "", text: "first", at: 100 });
    expect(Index.notesAbout("c10", "").map((n) => n.text)).toEqual(["first", "second"]);
  });

  test("a note that names no card, or says nothing, is not kept", () => {
    Index.rememberNote({ id: "n5", cardId: "", label: "", text: "something happened", at: 1 });
    Index.rememberNote({ id: "n6", cardId: "c11", label: "", text: "   ", at: 1 });
    expect(Index.notesAbout("", "")).toEqual([]);
    expect(Index.notesAbout("c11", "")).toEqual([]);
  });

  test("a note is stored cut to what a notification can hold, not whole", () => {
    /* `/clickup/card-note` is open to any local page under a 32 MB body limit,
       and nothing here capped the text: one POST could park megabytes in a
       table the card view reads on every open. A mirrored notification is a
       title and a line or two; 4 KB loses none of it. */
    Index.rememberNote({ id: "n7", cardId: "c12", label: "L".repeat(5000), text: "t".repeat(100_000), at: 1 });
    const got = Index.notesAbout("c12", "");
    expect(got).toHaveLength(1);
    expect(got[0]!.text.length).toBe(4096);
    expect(Index.notesAbout("", "L".repeat(512))).toHaveLength(1);
  });
});
