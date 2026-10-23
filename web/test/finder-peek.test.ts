/*
 * Folder peeking, Strata's switch of the same name: with it on, resting the
 * pointer on a folder in Icons or List opens a small card of what is inside.
 * The numbers are Strata's (256 wide, 500 ms to open, 80 ms to close, eight
 * entries); the placement and the cut are decided here, away from the screen.
 */
import { describe, expect, test } from "bun:test";
import { PEEK, peekOf, peekPlace } from "../src/lib/finderPeek.ts";
import { DEFAULT_PREFS, readPrefs } from "../src/lib/finderMiller.ts";
import type { BrowseEntry } from "../../shared/types.ts";

const entry = (name: string, kind: "dir" | "file" = "file"): BrowseEntry => ({ name, kind, bytes: kind === "file" ? 10 : null, items: kind === "dir" ? 2 : null, mtime: 0, hidden: name.startsWith(".") });

describe("the numbers are Strata's", () => {
  test("256 wide, 500 ms in, 80 ms out, eight entries", () => expect(PEEK).toMatchObject({ width: 256, open: 500, close: 80, limit: 8 }));
});

describe("what the card lists", () => {
  test("folders first, then files, and at most eight", () => {
    const entries = [...Array.from({ length: 7 }, (_, i) => entry(`f${i}.txt`)), entry("zeta", "dir"), entry("alpha", "dir")];
    const p = peekOf("orbit", entries, 0);
    expect(p.rows).toHaveLength(8);
    expect(p.rows.slice(0, 2).map((r) => r.name)).toEqual(["zeta", "alpha"]);
    expect(p.more).toBe(1);
  });
  test("what the listing left out counts as more, not as nothing", () => expect(peekOf("orbit", [entry("a")], 40).more).toBe(40));
  test("an empty folder says so", () => expect(peekOf("orbit", [], 0)).toMatchObject({ empty: true, rows: [], more: 0 }));
});

describe("where the card goes", () => {
  const view = { w: 1000, h: 700 };
  const size = { w: 256, h: 200 };
  test("beside the row, eight pixels off, top aligned", () => {
    expect(peekPlace({ left: 100, right: 300, top: 50, bottom: 80 }, size, view)).toEqual({ left: 308, top: 50 });
  });
  test("no room on the right: it opens on the left of the row", () => {
    expect(peekPlace({ left: 700, right: 900, top: 50, bottom: 80 }, size, view).left).toBe(700 - 8 - 256);
  });
  test("near the bottom it is lifted so it stays in the window", () => {
    expect(peekPlace({ left: 100, right: 300, top: 650, bottom: 680 }, size, view).top).toBe(700 - 8 - 200);
  });
  test("never past the top or the left edge", () => {
    const p = peekPlace({ left: 0, right: 4, top: -50, bottom: -20 }, size, { w: 200, h: 100 });
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.top).toBeGreaterThanOrEqual(8);
  });
});

describe("the setting", () => {
  test("off by default, as in Strata", () => expect(DEFAULT_PREFS.peek).toBe(false));
  test("a stored value of the wrong type falls back alone", () => {
    expect(readPrefs(JSON.stringify({ peek: true })).peek).toBe(true);
    expect(readPrefs(JSON.stringify({ peek: "yes", mirror: false })).peek).toBe(false);
  });
});

describe("the views draw it", () => {
  const read = (f: string) => Bun.file(new URL(`../src/components/finder/machine/${f}`, import.meta.url)).text();
  test("Icons and List bind the card to a folder row, only when the setting is on", async () => {
    const s = await read("FolderViews.tsx");
    expect(s.match(/peek\?\.bind\(/g)?.length).toBe(2);
    expect(await read("MachineFinder.tsx")).toContain("useFolderPeek(prefs.peek");
  });
  test("the card is a tooltip, not a menu: it never takes focus or a click", async () => {
    const s = await read("FolderPeek.tsx");
    expect(s).toContain('role="tooltip"');
    expect(s).toContain("pointer-events-none");
  });
});
