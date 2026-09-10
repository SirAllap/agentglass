/**
 * The filter has to read the card the SCREEN is reading.
 *
 * `p.card` is filled by the server off the boards cached on disk, and only from
 * a cache read within the day — so on a machine whose boards were last read a
 * week ago it is absent from every row, while the chip is still on every card,
 * fetched one at a time by `prCardStore`. A filter looking at `p.card` alone
 * then matched nothing at all: the rule was set, the button counted it, and not
 * one card left its lane.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { applyWith, type FilterSet } from "../src/components/tasks/filters.ts";
import { readPrField } from "../src/lib/prFilter.ts";
import { withCard, forgetCards } from "../src/lib/prCardStore.ts";
import type { PrSummary } from "../../shared/types.ts";

/*
 * THE STORE IS A MODULE SINGLETON AND `bun test` IS ONE PROCESS.
 *
 * Whatever this file leaves in it is what the next file renders against, and
 * `api.clickupFind` is stubbed here to answer for any reference at all — so an
 * entry left behind turns another file's "no card cached" into a card. That is
 * exactly what happened: three tests in another file went red on the runner and
 * nowhere else, because the order differs and this ran first there.
 *
 * Cleared on both sides, and the queue is drained before the stub is put back:
 * a lookup still in flight resolves through whichever function is installed
 * when it lands, not the one that was there when it was queued.
 */
beforeEach(() => forgetCards());
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 0));
  forgetCards();
});

/** A row as the list hands it over with a stale cache: an id in the branch and
 *  no card attached. */
const bare = (number: number, ref: string): PrSummary => ({
  number, title: `PR ${number}`, author: "someone", state: "open",
  headRefName: `${ref}-something`,
} as unknown as PrSummary);

test("a row whose card only the store knows is still read by the filter", async () => {
  /* The store's queue is the network, so this drives it the way the board
     does — ask, let the lookup settle, then read. `api.clickupFind` is stubbed
     through the module the store imports. */
  const store = await import("../src/lib/prCardStore.ts");
  const api = (await import("../src/lib/api.ts")).api as unknown as Record<string, unknown>;
  const before = api.clickupFind;
  /* Only this file's own references, and they are its own: `ORBIT-1042` was
     the first choice and another file's fixture uses that very branch, so the
     card seeded here replaced a five-hour-old reading it was asserting on —
     three tests red on the runner and nowhere else. Anything not from this
     file goes to the real function. */
  api.clickupFind = async (query: string) => (/^ORBIT-880[12]$/.test(query)
    ? { ok: true, task: { id: query, customId: query, title: "a card", status: "in review", priority: null, people: [] } }
    : (before as (q: string) => Promise<unknown>)(query));
  try {
    const rows = [bare(1, "ORBIT-8801"), bare(2, "ORBIT-8802")];
    /* First pass: nobody has an answer yet, so nothing is enriched — and a
       filter must not drop rows on that account. */
    const f: FilterSet = { join: "and", rules: [{ id: "r1", field: "cardstatus", op: "not", values: ["in review"] }] };
    expect(applyWith(rows.map((p) => store.withCard(p, true)), f, readPrField).length).toBe(2);
    /* Let the two lookups land. */
    for (let i = 0; i < 50 && !store.withCard(rows[0], true).card; i++) await new Promise((r) => setTimeout(r, 10));
    expect(withCard(rows[0], true).card?.status).toBe("in review");
    expect(applyWith(rows.map((p) => store.withCard(p, true)), f, readPrField)).toEqual([]);
  } finally {
    api.clickupFind = before;
  }
});

test("a row that already carries its card is left alone", () => {
  const p = { ...bare(3, "ORBIT-8803"), card: { id: "x", title: "t", status: "done", priority: null } } as unknown as PrSummary;
  expect(withCard(p, true)).toBe(p);
});

test("nothing is asked for when no provider is connected", () => {
  /* `taskLink` refuses a convention-shaped id with nothing to resolve it, and
     this must not queue a lookup that can only fail. */
  expect(withCard(bare(4, "ORBIT-8804"), false).card).toBeUndefined();
});

/**
 * A READING THE SERVER GAVE US IS NOT AUTOMATICALLY THE ONE TO DRAW.
 *
 * It comes off a board cached on disk and is accepted up to a day old, and a
 * status is a field people move several times a morning. Measured on a row
 * whose cached copy was 24 minutes old: the board said "in development" on one
 * person while the tracker had it in "code review" on another, and Refresh —
 * which re-reads the pull requests, not the tracker — could not shift it.
 */
test("a stale card is replaced by a fresher reading, and a fresh one is left alone", async () => {
  const store = await import("../src/lib/prCardStore.ts");
  const api = (await import("../src/lib/api.ts")).api as unknown as Record<string, unknown>;
  const before = api.clickupFind;
  api.clickupFind = async (query: string) => (query === "ORBIT-8805"
    ? { ok: true, task: { id: query, customId: query, title: "a card", status: "code review", priority: null, people: [{ name: "Someone Else" }] } }
    : (before as (q: string) => Promise<unknown>)(query));
  try {
    /* Half an hour old, and the row says what the board said then. */
    const stale = {
      ...bare(9, "ORBIT-8805"),
      card: { id: "c9", title: "a card", status: "in progress", priority: null, at: Date.now() - 30 * 60_000 },
    } as unknown as PrSummary;
    /* Nothing has answered yet, so the stale reading is kept rather than
       dropped: a status somebody can act on beats a blank. */
    expect(store.withCard(stale, true).card?.status).toBe("in progress");
    for (let i = 0; i < 50 && store.withCard(stale, true).card?.status !== "code review"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(store.withCard(stale, true).card?.status).toBe("code review");

    /* A minute old is young enough to stand behind, and costs nothing. */
    const fresh = {
      ...bare(10, "ORBIT-8806"),
      card: { id: "c10", title: "a card", status: "in progress", priority: null, at: Date.now() - 60_000 },
    } as unknown as PrSummary;
    expect(store.withCard(fresh, true)).toBe(fresh);
  } finally {
    api.clickupFind = before;
  }
});
