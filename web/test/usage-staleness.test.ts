// The plan meters keep their numbers through a burst of 429s, which means the
// strip has to be honest about how old they are. Both halves matter: labelling
// a healthy reading trains you to ignore the label, and not labelling a stuck
// one is the other way to lie about it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { stalenessLabel, STALE_AFTER_MS } from "../src/lib/usageAge.ts";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const island = read("src/components/workspace/DynamicIsland.tsx");

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = 1_700_000_000_000;

describe("saying how old a reading is", () => {
  test("a normal cycle is not staleness", () => {
    // The server refreshes upstream every 15 minutes and the browser polls the
    // server every 5, so twenty minutes old is a healthy reading, not a stuck
    // one — and a strip that cried stale every cycle would teach you to stop
    // reading it.
    expect(stalenessLabel(NOW, NOW)).toBe(null);
    expect(stalenessLabel(NOW - 20 * MIN, NOW)).toBe(null);
    expect(STALE_AFTER_MS).toBeGreaterThan(20 * MIN);
  });

  test("past that it says the age, coarsely", () => {
    expect(stalenessLabel(NOW - 40 * MIN, NOW)).toBe("40m");
    expect(stalenessLabel(NOW - 3 * HOUR, NOW)).toBe("3h");
    expect(stalenessLabel(NOW - 23 * HOUR, NOW)).toBe("23h");
    expect(stalenessLabel(NOW - 50 * HOUR, NOW)).toBe("2d");
  });

  test("a clock that stepped backwards is not staleness", () => {
    // A resume or an NTP correction can put the reading in the future. That is
    // not something to shout about on a status strip.
    expect(stalenessLabel(NOW + 5 * MIN, NOW)).toBe(null);
  });
});

describe("the strip keeps answering the question it exists to answer", () => {
  test("the meters take the age rather than being replaced by a word", () => {
    expect(island).toContain('<MeterPill tag="5H" w={u.five_hour} age={age} />');
    expect(island).toContain('<MeterPill tag="WEEK" w={u.seven_day} age={age} />');
    // The age comes from when the reading was taken, which is what the server
    // preserves across a failed refresh.
    expect(island).toContain("stalenessLabel(u.fetched_at)");
  });

  test("a stale meter is legible as stale without losing its number", () => {
    expect(island).toContain("${tag} · ${age} old");
    expect(island).toContain("opacity: age ? 0.55 : 1");
  });

  test('"Rate-limited" is only reachable with no reading at all', () => {
    // It lives in the `!u?.available` arm. The fix is not that the word is
    // gone, it is that the server almost always has something for the other
    // arm — so the word now means what it says.
    expect(island).toContain('const rateLimited = !u?.available && usageError()?.includes("429")');
  });
});
