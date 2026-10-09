import { describe, expect, test } from "bun:test";
import { peopleShown, readingAge, repoUsesTracker, STALE_MS, trackerBlock } from "../src/lib/prCardBlock.ts";
import { CARD_PEOPLE_MAX } from "../../shared/cardPeople.ts";

// An id that reads as a card: a branch with the shape `ORBIT-1042-…`.
const withId = { headRefName: "ORBIT-1042-callback-link-fails", title: "Fix the callback link" };
const plain = { headRefName: "fix/retry-worker", title: "Restore the bundle" };

describe("which repositories use the tracker", () => {
  test("none of the board's pull requests reads as a card: nothing is drawn", () => {
    expect(repoUsesTracker([plain, plain], true)).toBe(false);
  });
  test("one pull request that names a card is enough for the whole repository", () => {
    expect(repoUsesTracker([plain, withId], true)).toBe(true);
  });
  test("a card already attached counts without a branch that names it", () => {
    expect(repoUsesTracker([plain, { ...plain, card: { id: "x" } }], true)).toBe(true);
  });
  test("a tracker connected for the machine does not make a repository without one use it", () => {
    expect(repoUsesTracker([plain], true)).toBe(false);
  });
  test("with nothing connected no repository uses it, whatever its branches say", () => {
    expect(repoUsesTracker([withId], false)).toBe(false);
  });
  test("an empty board has nothing to read and says no", () => {
    expect(repoUsesTracker([], true)).toBe(false);
  });
  test("on a workspace with no custom ids a bare KEY-12 is not the tracker's, a CU- id is", () => {
    expect(repoUsesTracker([withId], true, true)).toBe(false);
    expect(repoUsesTracker([withId, { headRefName: "CU-86abc123_x" }], true, true)).toBe(true);
    expect(repoUsesTracker([withId], true, false)).toBe(true);
  });
});

describe("which block a card gets", () => {
  const base = { card: false, hasId: false, checksLoaded: true, repoUses: true };
  test("a card in hand is drawn, even where the repository rule says no", () => {
    expect(trackerBlock({ ...base, card: true, repoUses: false })).toBe("card");
  });
  test("a repository without a tracker gets nothing: no block, no hint, no loading shape", () => {
    expect(trackerBlock({ ...base, repoUses: false })).toBe("none");
    expect(trackerBlock({ ...base, repoUses: false, checksLoaded: false })).toBe("none");
    expect(trackerBlock({ ...base, repoUses: false, hasId: true })).toBe("none");
  });
  test("a tracker repository still reading draws the shape of the answer", () => {
    expect(trackerBlock({ ...base, checksLoaded: false })).toBe("loading");
  });
  test("a branch that names a card the boards have not seen draws the id alone", () => {
    expect(trackerBlock({ ...base, hasId: true })).toBe("id");
  });
  test("a tracker repository whose pull request has no card draws the quiet hint", () => {
    expect(trackerBlock(base)).toBe("hint");
  });
  test("an unknown load state is not 'loading': only an explicit false waits", () => {
    expect(trackerBlock({ ...base, checksLoaded: undefined })).toBe("hint");
  });
});

describe("how old a reading may be", () => {
  const now = 10 * 3_600_000;
  test("no timestamp says nothing and is not stale", () => {
    expect(readingAge(undefined, now)).toEqual({ stale: false, said: "" });
  });
  test("under a minute is just now", () => {
    expect(readingAge(now - 30_000, now)).toEqual({ stale: false, said: "just now" });
  });
  test("under an hour is minutes and still current", () => {
    expect(readingAge(now - 25 * 60_000, now)).toEqual({ stale: false, said: "25m ago" });
  });
  test("past the hour it dims and counts in hours only", () => {
    expect(readingAge(now - STALE_MS - 60_000, now)).toEqual({ stale: true, said: "1h ago" });
    expect(readingAge(now - 200 * 3_600_000, now - 0)).toEqual({ stale: true, said: "200h ago" });
  });
});

describe("the faces on the block", () => {
  test("five is the cap, and it is the one number the server cuts at too", () => {
    expect(CARD_PEOPLE_MAX).toBe(5);
  });
  test("up to the cap there is no counter", () => {
    expect(peopleShown(0)).toEqual({ faces: 0, more: 0 });
    expect(peopleShown(5)).toEqual({ faces: 5, more: 0 });
  });
  test("past it the rest read as +N", () => {
    expect(peopleShown(7)).toEqual({ faces: 5, more: 2 });
  });
});

describe("both places that cut a card's people use the shared cap", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  const store = Bun.file(new URL("../src/lib/prCardStore.ts", import.meta.url)).text();
  const server = Bun.file(new URL("../../server/src/prs.ts", import.meta.url)).text();
  test("neither keeps three", async () => {
    for (const src of [await store, await server]) {
      const code = strip(src);
      expect(code).toContain("slice(0, CARD_PEOPLE_MAX)");
      expect(code).not.toMatch(/people[^\n]*slice\(0, 3\)/);
    }
  });
});
