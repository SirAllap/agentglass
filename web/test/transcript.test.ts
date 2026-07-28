// A chat reads downwards, and the phone showed it upwards.
//
// Two failures in one expression: the order was the server's (newest-first),
// and the window was `slice(-40)`, which on a newest-first list keeps the
// oldest forty turns. On a long session the phone opened on ancient history.
import { describe, expect, test } from "bun:test";
import { recentTurns } from "../src/mobile/transcript.ts";

/** The shape the server sends: newest first. */
const feed = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ ts: (n - i) * 1000, text: `turn ${n - i}` }));

describe("recentTurns", () => {
  test("oldest first, newest last", () => {
    const out = recentTurns(feed(4));
    expect(out.map((t) => t.ts)).toEqual([1000, 2000, 3000, 4000]);
    expect(out[out.length - 1]!.text).toBe("turn 4");
  });

  test("keeps the newest turns when the session is longer than the window", () => {
    const out = recentTurns(feed(100), 40);
    expect(out).toHaveLength(40);
    // The window ends at the newest turn and starts 40 back — not at turn 1.
    expect(out[out.length - 1]!.ts).toBe(100_000);
    expect(out[0]!.ts).toBe(61_000);
  });

  test("a new turn lands at the bottom", () => {
    const before = recentTurns(feed(3));
    const after = recentTurns([{ ts: 4000, text: "newest" }, ...feed(3)]);
    expect(before[before.length - 1]!.ts).toBe(3000);
    expect(after[after.length - 1]!.text).toBe("newest");
  });

  test("does not mutate what the server sent", () => {
    const src = feed(3);
    recentTurns(src);
    expect(src.map((t) => t.ts)).toEqual([3000, 2000, 1000]);
  });

  test("survives a session with no conversation yet", () => {
    expect(recentTurns(undefined)).toEqual([]);
    expect(recentTurns([])).toEqual([]);
  });
});
