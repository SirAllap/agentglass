/*
 * recordVisit() is the browser's own memory: the address bar suggested only what
 * was imported from ANOTHER browser until this existed, so nothing the user
 * visited in the built-in browser ever came back as a completion.
 *
 * The one that matters most is the last test. Its own visits share the table
 * with an imported browser's, and saveFrom() clears a source by DELETEing it —
 * so the tripwire here is that re-importing Chrome does not take the user's own
 * history down with it. If that ever regresses, the browser silently forgets
 * everywhere you went the next time you press "import".
 *
 * A temp file via __setPlacesPath, so the suite never reads or writes the
 * developer's real places.db.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setPlacesPath, allPlaces, placeCount, recordVisit, saveFrom } from "../src/placestore.ts";

const box = mkdtempSync(join(tmpdir(), "agx-record-visit-"));

beforeEach(() => {
  // A fresh empty db per test: a new temp path, and the store reopens on it.
  __setPlacesPath(join(box, `${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
});

afterAll(() => {
  __setPlacesPath(null);
  try { rmSync(box, { recursive: true, force: true }); } catch { /* gone */ }
});

const find = (url: string) => allPlaces().find((p) => p.url === url);

describe("recordVisit — the browser's own history", () => {
  test("a new visit lands, tagged with the 'agentglass' source", () => {
    recordVisit("https://example.com/", "Example");

    const row = find("https://example.com/");
    expect(row).toBeDefined();
    expect(row!.title).toBe("Example");
    expect(row!.visits).toBe(1);
    expect(row!.lastAt).toBeGreaterThan(0);
    // allPlaces() does not carry the source column, so the tag is checked where
    // it is visible: the distinct-source list. It has to be 'agentglass' — that
    // is what keeps these rows out of a browser re-import's DELETE.
    expect(placeCount().sources).toContain("agentglass");
  });

  test("a re-visit bumps the count and moves the time forward, keeping the longer title", () => {
    recordVisit("https://example.com/", "Ex");           // short title first
    const first = find("https://example.com/")!;

    // A later visit: a second in the future, so last_at strictly advances.
    const later = Math.floor(Date.now() / 1000) + 5;
    const realNow = Date.now;
    try {
      Date.now = () => later * 1000;
      recordVisit("https://example.com/", "Example — the longer one");
    } finally {
      Date.now = realNow;
    }

    const again = find("https://example.com/")!;
    expect(again.visits).toBe(2);                        // bumped, not reset
    expect(again.lastAt).toBe(later);                    // time moved forward
    expect(again.lastAt).toBeGreaterThan(first.lastAt);
    expect(again.title).toBe("Example — the longer one"); // longer title kept

    // And a re-visit with a SHORTER title does not shrink the one we have.
    recordVisit("https://example.com/", "Ex");
    expect(find("https://example.com/")!.title).toBe("Example — the longer one");
    expect(find("https://example.com/")!.visits).toBe(3);
  });

  test("a non-http(s) address is ignored — about:blank, data:, the app scheme", () => {
    recordVisit("about:blank", "New tab");
    recordVisit("data:text/html,<h1>hi", "inline");
    recordVisit("agentglass://home", "the app itself");

    expect(allPlaces()).toHaveLength(0);
    expect(placeCount().total).toBe(0);
  });

  test("an absurdly long url is dropped, and a long title is stored truncated to 300", () => {
    // Anti-bloat, matching the import path: the url is the primary key, so one
    // past 4096 chars is refused whole rather than stored, and however long a
    // page's <title> is, only the first 300 chars land.
    const hugeUrl = "https://example.com/" + "a".repeat(4096);
    expect(hugeUrl.length).toBeGreaterThan(4096);
    recordVisit(hugeUrl, "ignored");
    expect(find(hugeUrl)).toBeUndefined();
    expect(placeCount().total).toBe(0);

    const longTitle = "T".repeat(1000);
    recordVisit("https://titles.example/", longTitle);
    const row = find("https://titles.example/");
    expect(row).toBeDefined();
    expect(row!.title.length).toBe(300);
    expect(row!.title).toBe("T".repeat(300));
  });

  test("re-importing a browser does NOT wipe the user's own visits", () => {
    // The user browses, and separately imports Chrome. Two sources, one table.
    recordVisit("https://mine.example/", "A page I visited");
    saveFrom("chrome", [
      { url: "https://chrome-import.example/", title: "From Chrome", visits: 3, lastAt: 100, bookmarked: false },
    ]);

    expect(find("https://mine.example/")).toBeDefined();
    expect(find("https://chrome-import.example/")).toBeDefined();

    // A second Chrome import: saveFrom() DELETEs source='chrome' first. The
    // user's 'agentglass' row must survive it untouched.
    saveFrom("chrome", [
      { url: "https://chrome-import.example/", title: "From Chrome again", visits: 4, lastAt: 200, bookmarked: false },
    ]);

    const mine = find("https://mine.example/");
    expect(mine).toBeDefined();                 // still here
    expect(mine!.visits).toBe(1);               // and untouched by the import
    expect(placeCount().sources.sort()).toEqual(["agentglass", "chrome"]);
  });
});
