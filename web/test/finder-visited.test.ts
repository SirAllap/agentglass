import { describe, expect, test } from "bun:test";
import { loadVisited, recordVisit, saveVisited, searchVisited, visitedEmpty, type Visit } from "../src/lib/finderVisited.ts";

const H = 3600_000;
const NOW = 100 * 24 * H;

describe("the folders visited, for Ctrl+Shift+K", () => {
  test("a visit adds one to the rank and moves the folder to the front", () => {
    let l: Visit[] = [];
    l = recordVisit(l, "/h/orbit", NOW);
    l = recordVisit(l, "/h/acme", NOW + 1);
    l = recordVisit(l, "/h/orbit", NOW + 2);
    expect(l.map((v) => v.path)).toEqual(["/h/orbit", "/h/acme"]);
    expect(l[0]!.rank).toBe(2);
  });
  test("Recent is a list, not a folder, and is not remembered", () => {
    expect(recordVisit([], "recent:///", NOW)).toEqual([]);
  });
  test("the list keeps a thousand and drops the least wanted", () => {
    let l: Visit[] = [];
    for (let i = 0; i < 1001; i++) l = recordVisit(l, `/h/d${i}`, NOW + i);
    expect(l.length).toBe(1000);
    expect(l.some((v) => v.path === "/h/d1000")).toBe(true);
  });
  test("every word must be in the path, the open folder is left out, a recent visit outweighs an old one", () => {
    const l: Visit[] = [{ path: "/h/acme/docs", rank: 1, at: NOW - 30 * 24 * H }, { path: "/h/orbit/docs", rank: 1, at: NOW - H / 2 }, { path: "/h/orbit", rank: 5, at: NOW }];
    expect(searchVisited(l, "docs", NOW).map((v) => v.path)).toEqual(["/h/orbit/docs", "/h/acme/docs"]);
    expect(searchVisited(l, "orbit docs", NOW).map((v) => v.path)).toEqual(["/h/orbit/docs"]);
    expect(searchVisited(l, "", NOW, "/h/orbit").map((v) => v.path)).not.toContain("/h/orbit");
    expect(searchVisited(l, "nothing", NOW)).toEqual([]);
  });
  test("a folder named exactly like the query comes first", () => {
    const l: Visit[] = [{ path: "/h/orbit/notes-old", rank: 50, at: NOW }, { path: "/h/notes", rank: 1, at: NOW - 40 * 24 * H }];
    expect(searchVisited(l, "notes", NOW)[0]!.path).toBe("/h/notes");
  });
  test("the empty states are Strata's", () => {
    expect(visitedEmpty("", 0)).toBe("No folder history yet");
    expect(visitedEmpty("zz", 0)).toBe("No matching folders");
    expect(visitedEmpty("zz", 3)).toBe("");
  });
  test("storage that is missing or holds rubbish gives an empty list, not a crash", () => {
    expect(loadVisited()).toEqual([]);
    expect(() => saveVisited([{ path: "/h", rank: 1, at: 1 }])).not.toThrow();
  });
});
