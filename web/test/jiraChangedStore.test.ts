import { beforeEach, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";
import { __resetSeen, boardLoaded, cardSeen, markCardRead, sinceOf } from "../src/lib/jiraChangedStore.ts";
import type { SeenCard } from "../src/lib/jiraChanged.ts";

const stubGlobal = globalStubs();
const mem = new Map<string, string>();
stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } });

// Two cards on an invented site, shaped like a board read.
const url = (n: number) => `https://acme.example.net/browse/ORBIT-${n}`;
const card = (n: number, o: Partial<SeenCard> = {}): SeenCard => ({ id: String(n), status: "In progress", assignees: ["Ana Example"], comments: 1, updated: 1000, created: 10, url: url(n), ...o });
const key = (c: SeenCard) => `ORBIT-${c.id}`;
beforeEach(() => { mem.clear(); __resetSeen(); });
const stored = () => JSON.parse(mem.get("agx.jira.seen.v1:acme.example.net") ?? "{}");

describe("seen store", () => {
  test("the first board load flags nothing and stores a snapshot per card and the board's time", () => {
    boardLoaded([card(1), card(2)], key);
    expect(Object.keys(stored().cards)).toEqual(["ORBIT-1", "ORBIT-2"]);
    expect(stored().board).toBeGreaterThan(0);
  });
  test("opening a card stores it as seen as it stands", () => {
    cardSeen(card(1, { comments: 4 }), "ORBIT-1");
    expect(stored().cards["ORBIT-1"].comments).toBe(4);
  });
});

describe("an open card's new marks", () => {
  test("a flagged card keeps its old time after opening, so its comments can wear the mark; Mark read moves it on", () => {
    cardSeen(card(7), "ORBIT-7");                                   // looked at once: its snapshot is taken now
    const t0 = stored().cards["ORBIT-7"].at;
    const later = card(7, { comments: 2, updated: Date.now() + 5000 });   // a comment landed since
    boardLoaded([later], key);
    cardSeen(later, "ORBIT-7");
    expect(sinceOf(card(7), "ORBIT-7")).toBeLessThanOrEqual(t0);
    markCardRead(card(7), "ORBIT-7");
    expect(sinceOf(card(7), "ORBIT-7")).toBeGreaterThanOrEqual(t0);
  });
});
