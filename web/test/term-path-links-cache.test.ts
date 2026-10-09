import { describe, expect, test } from "bun:test";
import { makeKindCache, type Known } from "../src/lib/termPathLinks.ts";

// A path printed before the file is written: the first look is a miss, and the
// file exists a second later. A miss must not be trusted for as long as a hit.
function rig(answer: () => Known) {
  let t = 0;
  let asks = 0;
  const kindOf = makeKindCache(async () => { asks++; return answer(); }, () => t);
  return { kindOf, tick: (ms: number) => { t += ms; }, asks: () => asks };
}

describe("term path link cache", () => {
  test("a miss becomes a link once the miss TTL has passed", async () => {
    let exists = false;
    const r = rig(() => (exists ? "file" : null));
    expect(await r.kindOf("/n/a.md")).toBeNull();
    exists = true;
    r.tick(1_000);
    expect(await r.kindOf("/n/a.md")).toBeNull(); // still cached
    expect(r.asks()).toBe(1);
    r.tick(1_500);
    expect(await r.kindOf("/n/a.md")).toBe("file");
    expect(r.asks()).toBe(2);
  });

  test("a hit stays cached for 30 s", async () => {
    const r = rig(() => "file");
    await r.kindOf("/n/a.md");
    r.tick(29_000);
    await r.kindOf("/n/a.md");
    expect(r.asks()).toBe(1);
    r.tick(2_000);
    await r.kindOf("/n/a.md");
    expect(r.asks()).toBe(2);
  });
});
