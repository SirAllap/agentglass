/*
 * Re-asking the open pull request lists nobody is polling.
 *
 * `listPrs` only runs when a client asks `/prs/list`, and its own 90s TTL
 * decides whether that does real work. With only a phone connected and off
 * the PRs tab, nothing asks — so a new human comment never gets the fresh
 * read that turns it into a `talk` note. This module remembers which
 * (root, filter) pairs a real client already asked for and re-asks them on a
 * timer, as long as somebody is actually connected to hear the answer.
 *
 * The core is pure — a clock and a "how many clients" count are both passed
 * in — so none of this needs a real setInterval or a real client.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { noteAsk, tick, __resetWatch } from "../src/prWatch.ts";

const HOUR = 60 * 60_000;

describe("what gets tracked", () => {
  beforeEach(() => __resetWatch());

  test("only mine/review with state=open is worth remembering", () => {
    const asked: string[] = [];
    const relist = (root: string, filter: string) => asked.push(`${root}:${filter}`);

    noteAsk("/repo/a", "mine", "open", 0);
    noteAsk("/repo/b", "review", "open", 0);
    noteAsk("/repo/c", "all", "open", 0); // wrong filter
    noteAsk("/repo/d", "mine", "closed", 0); // wrong state
    noteAsk("/repo/e", "mine", "all", 0); // wrong state

    tick(1000, 1, relist);
    expect(asked.sort()).toEqual(["/repo/a:mine", "/repo/b:review"]);
  });
});

describe("whether the tick does anything at all", () => {
  beforeEach(() => __resetWatch());

  test("no live clients — nothing is re-asked, even with a fresh pair on file", () => {
    const asked: string[] = [];
    noteAsk("/repo/a", "mine", "open", 0);
    tick(1000, 0, (root, filter) => asked.push(`${root}:${filter}`));
    expect(asked).toEqual([]);
  });

  test("a live client — the pair is re-asked", () => {
    const asked: string[] = [];
    noteAsk("/repo/a", "mine", "open", 0);
    tick(1000, 1, (root, filter) => asked.push(`${root}:${filter}`));
    expect(asked).toEqual(["/repo/a:mine"]);
  });
});

describe("the 12h window", () => {
  beforeEach(() => __resetWatch());

  test("a pair asked 13 hours ago is dropped, not re-asked", () => {
    const asked: string[] = [];
    noteAsk("/repo/a", "mine", "open", 0);
    tick(13 * HOUR, 1, (root, filter) => asked.push(`${root}:${filter}`));
    expect(asked).toEqual([]);
    // And it stays dropped: a later tick does not resurrect it.
    tick(14 * HOUR, 1, (root, filter) => asked.push(`${root}:${filter}`));
    expect(asked).toEqual([]);
  });

  test("still inside the window at 11h59 — re-asked", () => {
    const asked: string[] = [];
    noteAsk("/repo/a", "mine", "open", 0);
    tick(12 * HOUR - 60_000, 1, (root, filter) => asked.push(`${root}:${filter}`));
    expect(asked).toEqual(["/repo/a:mine"]);
  });

  test("a fresh ask for the same pair resets its clock", () => {
    const asked: string[] = [];
    noteAsk("/repo/a", "mine", "open", 0);
    noteAsk("/repo/a", "mine", "open", 6 * HOUR);
    tick(6 * HOUR + 11 * HOUR, 1, (root, filter) => asked.push(`${root}:${filter}`));
    expect(asked).toEqual(["/repo/a:mine"]);
  });
});
