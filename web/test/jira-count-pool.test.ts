/* The sidebar counts: N rows make N asks, two at a time, and a row that left the list is never asked. */
import { describe, expect, test } from "bun:test";
import { countPool, COUNT_CONCURRENCY } from "../src/lib/useJiraViewCounts.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("countPool", () => {
  test("8 rows give 8 asks and never more than 2 in flight", async () => {
    let live = 0, peak = 0;
    const asked: string[] = [];
    const pool = countPool(COUNT_CONCURRENCY, async (id) => { asked.push(id); live++; peak = Math.max(peak, live); await tick(); live--; }, () => true, () => {});
    pool.add(Array.from({ length: 8 }, (_, i) => `assignee:u${i}`));
    await new Promise((r) => setTimeout(r, 60));
    expect(asked).toHaveLength(8);
    expect(peak).toBe(2);
  });
  test("a row that left the list while it waited is dropped, not asked", async () => {
    const asked: string[] = [], dropped: string[] = [];
    const gone = new Set(["b"]);
    const pool = countPool(1, async (id) => { asked.push(id); await tick(); }, (id) => !gone.has(id), (id) => dropped.push(id));
    pool.add(["a", "b", "c"]);
    await new Promise((r) => setTimeout(r, 30));
    expect(asked).toEqual(["a", "c"]);
    expect(dropped).toEqual(["b"]);
  });
  test("a stopped pool asks nothing more", async () => {
    const asked: string[] = [];
    const pool = countPool(1, async (id) => { asked.push(id); await tick(); }, () => true, () => {});
    pool.add(["a", "b", "c"]);
    pool.stop();
    await new Promise((r) => setTimeout(r, 30));
    expect(asked).toEqual(["a"]);
  });
});
