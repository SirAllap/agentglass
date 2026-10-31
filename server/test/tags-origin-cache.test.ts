import { describe, expect, it } from "bun:test";
import { makeTagsOriginCache } from "../src/tagsOriginCache.ts";

describe("tags-origin cache", () => {
  it("shares one in-flight ask and keeps an unknown answer for 30 s, not 60", async () => {
    let t = 0, asks = 0;
    const c = makeTagsOriginCache(() => t);
    const slow = async () => { asks++; await Bun.sleep(20); return '{"tags":[{"onOrigin":"unknown"}]}'; };
    const [a, b] = await Promise.all([c.get("k", 1, slow), c.get("k", 1, slow)]);
    expect(a).toBe(b);
    expect(asks).toBe(1);
    t = 29_000; await c.get("k", 1, slow); expect(asks).toBe(1);
    t = 31_000; await c.get("k", 1, slow); expect(asks).toBe(2);
  });
  it("keeps a full answer for 60 s and drops it when the refs move", async () => {
    let t = 0, asks = 0;
    const c = makeTagsOriginCache(() => t);
    const full = async () => { asks++; return '{"tags":[{"onOrigin":"yes"}]}'; };
    await c.get("k", 1, full); t = 59_000; await c.get("k", 1, full); expect(asks).toBe(1);
    await c.get("k", 2, full); expect(asks).toBe(2);
    t = 120_000; await c.get("k", 2, full); expect(asks).toBe(3);
  });
});
