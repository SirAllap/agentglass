/*
 * The cut the card door makes on somebody's words. A card's comments are read
 * newest first against a byte budget, and what is left for the next one is
 * whatever the last one did not use: 0, 1 or 2 bytes included, which is less
 * than the three dots that say a text was cut. Pinned here: a cut answers at
 * every budget, never runs over it, and never leaves half a character.
 */
import { describe, expect, test } from "bun:test";
import { clip, newestComments } from "../src/jiraDoor.ts";

const MIXED = "año €5 😀 ok ".repeat(8);
const bytes = (s: string) => Buffer.byteLength(s);

describe("a cut to a byte budget", () => {
  test("a text that fits is not touched", () => {
    expect(clip("", 0)).toBe("");
    expect(clip("hello", 5)).toBe("hello");
    expect(clip("€", 3)).toBe("€");
  });

  test("a budget with no room for the dots answers with nothing", () => {
    for (const n of [-40, -1, 0, 1, 2]) expect(clip("hello", n)).toBe("");
  });

  test("at every budget the answer fits, is whole characters, and says it was cut", () => {
    for (let n = 3; n < bytes(MIXED); n++) {
      const out = clip(MIXED, n);
      expect(bytes(out)).toBeLessThanOrEqual(n);
      expect(out.endsWith("...")).toBe(true);
      expect(out.isWellFormed()).toBe(true);
      expect(MIXED.startsWith(out.slice(0, -3))).toBe(true);
    }
  });

  test("a character of several bytes at the edge is dropped whole", () => {
    expect(clip("ab€€", 6)).toBe("ab...");
    expect(clip("ab😀😀", 9)).toBe("ab😀...");
    expect(clip("ab😀😀", 8)).toBe("ab...");
  });
});

describe("the comments that fit", () => {
  const who = "Ada Example";
  const older = { who, text: "€".repeat(40) };
  // The newest comment is sized so that exactly `rest` bytes are left for the one before it.
  const leaving = (left: number, rest: number) => [older, { who, text: "x".repeat(left - bytes(who) - 32 - rest) }];

  test("a budget that ends with no room for another comment keeps the newest and stops", () => {
    for (const rest of [0, 1, 2, bytes(who) + 32, bytes(who) + 34]) {
      const all = leaving(400, rest);
      expect(newestComments(all, 400)).toEqual([all[1]!]);
    }
  });

  test("a budget already spent keeps none", () => {
    expect(newestComments([older], -200)).toEqual([]);
    expect(newestComments([older], 0)).toEqual([]);
  });

  test("with room, all of them come back in the order they were written, the oldest cut to what is left", () => {
    const all = leaving(400, 150);
    expect(newestComments(all, 4000)).toEqual(all);
    const tight = newestComments(all, 400);
    expect(tight.map((c) => c.who)).toEqual([who, who]);
    expect(tight[1]).toEqual(all[1]!);
    // 107 bytes are left for its words: 34 three-byte characters and the dots.
    expect(tight[0]!.text).toBe("€".repeat(34) + "...");
  });
});
