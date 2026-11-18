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
import { db } from "../src/db.ts";
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
 * THE INDEX IS A CACHE, NOT HISTORY: it is worth less than the row it costs
 * once nobody has swept past it in a while. `evictOld` is the sweep that
 * says so, and the cards it drops are the ones a board did NOT touch — a
 * card still open keeps getting its `seen_at` refreshed by `remember`, so
 * the cutoff alone is what keeps it.
 */
describe("evicting what nobody has seen in a while", () => {
  const withSeenAt = (id: string, seenAt: number) => {
    Index.remember([card({ id })]);
    // `remember` always writes `Date.now()`; back-date it directly for the test.
    db.run("UPDATE clickup_cards SET seen_at = ? WHERE id = ?", [seenAt, id]);
  };

  test("older than the window is dropped, newer stays", () => {
    const now = Date.now();
    withSeenAt("old", now - 40 * 86_400_000);
    withSeenAt("fresh", now - 1 * 86_400_000);
    const n = Index.evictOld(30);
    expect(n).toBe(1);
    expect(Index.indexed().cards).toBe(1);
    expect(Index.named("pagination").map((c) => c.id)).toEqual(["fresh"]);
  });

  test("0 or less keeps everything", () => {
    withSeenAt("old", Date.now() - 400 * 86_400_000);
    expect(Index.evictOld(0)).toBe(0);
    expect(Index.evictOld(-5)).toBe(0);
    expect(Index.indexed().cards).toBe(1);
  });
});

/*
 * WHAT A NOTIFICATION SAID, ON THE CARD IT WAS ABOUT.
 *
 * A notification read "Grace assigned this task to: ada" and the card's Activity
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

describe("the body scan is paid once per card number", () => {
  test("a repeat is answered from memory until the index changes", () => {
    Index.remember([card({ id: "m1", body: "see ORBIT-1042" })]);
    const before = Index.bodyScans;
    expect(Index.mentioning("1042").map((c) => c.id)).toEqual(["m1"]);
    expect(Index.mentioning("1042").map((c) => c.id)).toEqual(["m1"]);
    expect(Index.bodyScans - before, "one scan for two asks").toBe(1);
    Index.remember([card({ id: "m2", body: "also ORBIT-1042" })]);
    expect(Index.mentioning("1042").map((c) => c.id).sort()).toEqual(["m1", "m2"]);
    expect(Index.bodyScans - before, "a write forgets the answer").toBe(2);
  });
});

/*
 * The body column was a third of a 946 MB database (301 MB for 10,218 cards)
 * and was only ever asked "does it mention card N". It now holds the card ids
 * the body names, and the answer must not change by one card.
 */
describe("the index keeps what a body mentions, not the body", () => {
  const long = `${"Steps to reproduce, at length. ".repeat(2000)} Same root cause as ORBIT-1042 and (acme_v2-77). Not call 891042, not ORBIT-1042x.`;
  const stored = (id: string) => (db.query("SELECT body FROM clickup_cards WHERE id = ?").get(id) as { body: string }).body;

  test("a long body is stored as the ids it names and still answers the same", () => {
    Index.remember([card({ id: "big", body: long }), card({ id: "plain", body: "no card named here" })]);
    expect(stored("big").length).toBeLessThan(40);
    expect(stored("big")).toContain("ORBIT-1042");
    expect(Index.mentioning("1042").map((c) => c.id)).toEqual(["big"]);
    expect(Index.mentioning("77").map((c) => c.id)).toEqual(["big"]);
    expect(Index.mentioning("891042")).toEqual([]);
    // A body with no card in it still counts as read.
    expect(Index.indexed()).toEqual({ cards: 2, withBody: 2 });
  });

  test("the rule gives one answer on a text and on what is kept of it", async () => {
    const { cardRefsIn, mentionsCardId } = await import("../../shared/cardRef.ts");
    const bits = ["ORBIT-1042", "orbit-7", "a_b-12", "x-12-34", "ab-cd-123", "9-55", "T-10x", "(ACME-300)", "ACME-300.", "-41", "é-12", "k9-0042", " ", "\n", "see", "1042", "_z-5"];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 400; i++) {
      const text = Array.from({ length: 1 + (next() % 8) }, () => bits[next() % bits.length]).join(next() % 3 ? " " : "");
      for (const d of ["1042", "7", "12", "34", "123", "55", "10", "300", "41", "0042", "5", "42"]) {
        expect(mentionsCardId(cardRefsIn(text), d), `${JSON.stringify(text)} / ${d}`).toBe(mentionsCardId(text, d));
      }
    }
  });

  test("a slim step reads a byte budget, not a row count", () => {
    const fat = "PROJ-1 ".repeat(20_000); // ~140 KB
    Index.remember([card({ id: "f1" }), card({ id: "f2" }), card({ id: "f3" })]);
    db.run("UPDATE clickup_cards SET body = ? WHERE id IN ('f1','f2','f3')", [fat]);
    Index.__slimAgain();
    const first = Index.slimOld(100);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(3); // 100 rows asked, ~140 KB each: the 256 KB budget stops it at 1-2
    while (Index.slimOld(100)) { /* rest of the pass */ }
    expect(stored("f3").length).toBeLessThan(40);
  });


  test("rows written whole before this are cut down a page at a time", () => {
    Index.remember([card({ id: "o1" }), card({ id: "o2" }), card({ id: "o3" })]);
    db.run("UPDATE clickup_cards SET body = ? WHERE id IN ('o1','o2')", [long]);
    Index.__slimAgain();
    expect(Index.slimOld(2)).toBe(2);
    expect(Index.slimOld(2)).toBe(1);
    expect(Index.slimOld(2)).toBe(0);
    expect(stored("o1").length).toBeLessThan(40);
    expect(stored("o2").length).toBeLessThan(40);
    expect(stored("o3")).toBe("");
    expect(Index.mentioning("1042").map((c) => c.id).sort()).toEqual(["o1", "o2"]);
  });
});
