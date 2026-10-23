/*
 * Recent and saved searches, and the people followed: the rules of the two
 * stores (dedupe, the cap of ten, pins, follows, the ranking of suggestions)
 * and the storage round trip. Fixtures are invented names.
 */
import { describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";
import {
  EMPTY_MEMORY, RECENT_MAX, SAVED_MAX, clearRecent, countOf, isPinned, isRemembered, loadMemory, noteCount, noteSearch,
  normalizeSearch, recentRows, removeRecent, saveMemory, togglePin,
} from "../src/lib/prSearchMemory.ts";
import { FOLLOW_MAX, isFollowed, loadFollows, peopleRows, saveFollows, toggleFollow } from "../src/lib/prFollow.ts";

const stubGlobal = globalStubs();
const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});

const T = 1_700_000_000_000;

describe("recent searches", () => {
  it("puts the newest first and keeps one copy of a search, however it is spelled", () => {
    let m = noteSearch(EMPTY_MEMORY, "author:ana", T);
    m = noteSearch(m, "#412", T + 1);
    m = noteSearch(m, "  Author:ANA  ", T + 2);
    expect(m.recent.map((r) => r.q)).toEqual(["Author:ANA", "#412"]);
  });

  it("caps at ten and drops the oldest", () => {
    let m = EMPTY_MEMORY;
    for (let i = 0; i < RECENT_MAX + 4; i++) m = noteSearch(m, `fix ${i}`, T + i);
    expect(m.recent).toHaveLength(RECENT_MAX);
    expect(m.recent[0]!.q).toBe(`fix ${RECENT_MAX + 3}`);
    expect(m.recent.at(-1)!.q).toBe("fix 4");
  });

  it("never remembers an empty box", () => {
    expect(noteSearch(EMPTY_MEMORY, "   ", T)).toBe(EMPTY_MEMORY);
  });

  it("keeps the count of an earlier run until the search reports a new one", () => {
    let m = noteSearch(EMPTY_MEMORY, "ORBIT-1042", T);
    m = noteCount(m, "orbit-1042", 7);
    m = noteSearch(m, "ORBIT-1042", T + 5);
    expect(countOf(m, "ORBIT-1042")).toBe(7);
    expect(countOf(noteCount(m, "ORBIT-1042", 9), "ORBIT-1042")).toBe(9);
  });

  it("a count for a search that is not remembered brings nothing back", () => {
    expect(noteCount(EMPTY_MEMORY, "gone", 3)).toBe(EMPTY_MEMORY);
  });

  it("removes one, and clearing recent leaves the pins", () => {
    let m = noteSearch(noteSearch(EMPTY_MEMORY, "a b", T), "c d", T + 1);
    m = togglePin(m, "a b");
    expect(removeRecent(m, "C D").recent.map((r) => r.q)).toEqual(["a b"]);
    const cleared = clearRecent(m);
    expect(cleared.recent).toEqual([]);
    expect(cleared.saved).toEqual(["a b"]);
  });
});

describe("saved searches", () => {
  it("pins and unpins, case-insensitively", () => {
    let m = togglePin(EMPTY_MEMORY, " author:ana ");
    expect(isPinned(m, "AUTHOR:ana")).toBe(true);
    m = togglePin(m, "author:ana");
    expect(m.saved).toEqual([]);
  });

  it("a pinned search is drawn once, under Saved, not again under Recent", () => {
    let m = noteSearch(noteSearch(EMPTY_MEMORY, "one", T), "two", T + 1);
    m = togglePin(m, "two");
    expect(recentRows(m).map((r) => r.q)).toEqual(["one"]);
  });

  it("a pin button belongs beside a box whose text was searched or pinned", () => {
    const m = togglePin(noteSearch(EMPTY_MEMORY, "#9", T), "saved only");
    expect(isRemembered(m, "#9")).toBe(true);
    expect(isRemembered(m, "saved only")).toBe(true);
    expect(isRemembered(m, "typed, never searched")).toBe(false);
    expect(isRemembered(m, "")).toBe(false);
  });

  it("is capped, the oldest pin giving way", () => {
    let m = EMPTY_MEMORY;
    for (let i = 0; i < SAVED_MAX + 2; i++) m = togglePin(m, `s${i}`);
    expect(m.saved).toHaveLength(SAVED_MAX);
    expect(m.saved[0]).toBe("s2");
  });

  it("normalizes whitespace to one spelling", () => {
    expect(normalizeSearch("  a \t b\n c ")).toBe("a b c");
  });
});

describe("storage", () => {
  it("round-trips per repository", () => {
    const m = togglePin(noteSearch(EMPTY_MEMORY, "#412", T, 3), "author:ana");
    saveMemory("github.com/acme/orbit", m);
    expect(loadMemory("github.com/acme/orbit")).toEqual(m);
    expect(loadMemory("github.com/acme/other")).toEqual(EMPTY_MEMORY);
  });

  it("survives a damaged value and keeps only what is well formed", () => {
    store.set("agentglass.pr.searches.v1:x", "{not json");
    expect(loadMemory("x")).toEqual(EMPTY_MEMORY);
    store.set("agentglass.pr.searches.v1:y", JSON.stringify({ recent: [{ q: "ok", at: 1 }, { q: 5, at: 2 }, null], saved: ["p", 3, " "] }));
    expect(loadMemory("y")).toEqual({ recent: [{ q: "ok", at: 1 }], saved: ["p"] });
  });
});

describe("people followed", () => {
  it("follows and unfollows without caring about case, keeping the first spelling", () => {
    let f = toggleFollow([], "@Ana");
    expect(f).toEqual(["Ana"]);
    expect(isFollowed(f, "ana")).toBe(true);
    f = toggleFollow(f, "ANA");
    expect(f).toEqual([]);
  });

  it("is capped", () => {
    let f: string[] = [];
    for (let i = 0; i < FOLLOW_MAX + 3; i++) f = toggleFollow(f, `user${i}`);
    expect(f).toHaveLength(FOLLOW_MAX);
    expect(f[0]).toBe("user3");
  });

  const roster = ["ana", "ben", "cy", "dee", "eli", "fay", "gus"];
  const use = Object.fromEntries(roster.map((l, i) => [l, { n: 10 - i, at: T }]));

  it("suggests the people used most, at most five, until somebody is followed", () => {
    const { followed, suggested } = peopleRows([], roster, use, T);
    expect(followed).toEqual([]);
    expect(suggested).toEqual(["ana", "ben", "cy", "dee", "eli"]);
  });

  it("shows the follows instead of suggestions once there is one", () => {
    expect(peopleRows(["gus"], roster, use, T)).toEqual({ followed: ["gus"], suggested: [] });
  });

  it("suggests nobody from a roster that has not loaded, or a login that left", () => {
    expect(peopleRows([], null, use, T).suggested).toEqual([]);
    expect(peopleRows([], ["ben"], use, T).suggested).toEqual(["ben"]);
  });

  it("round-trips per repository", () => {
    saveFollows("github.com/acme/orbit", ["ana", "ben"]);
    expect(loadFollows("github.com/acme/orbit")).toEqual(["ana", "ben"]);
    expect(loadFollows("github.com/acme/other")).toEqual([]);
  });
});
