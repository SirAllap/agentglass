// /prs/spend recomputed on the loop whenever its answer was older than the TTL,
// and the recompute is synchronous SQLite over cold pages (1.1 s once, 178
// stalls in a log). Past the TTL the caller now gets the old answer at once and
// the refresh runs behind it.
import { describe, expect, test } from "bun:test";
import { cachedOrRefresh } from "../src/spend.ts";

const fresh = () => ({ store: new Map<string, { at: number; value: number }>(), inflight: new Map<string, Promise<number>>() });
const ok = () => true;

describe("cachedOrRefresh", () => {
  test("a miss computes and waits for it", async () => {
    const { store, inflight } = fresh();
    expect(await cachedOrRefresh(store, inflight, "a", 1000, async () => 1, ok)).toBe(1);
  });

  test("inside the TTL the cache answers and nothing recomputes", async () => {
    const { store, inflight } = fresh();
    let runs = 0;
    const compute = async () => ++runs;
    await cachedOrRefresh(store, inflight, "a", 1000, compute, ok);
    expect(await cachedOrRefresh(store, inflight, "a", 1000, compute, ok)).toBe(1);
    expect(runs).toBe(1);
  });

  test("past the TTL the stale value returns at once and one refresh runs behind it", async () => {
    const { store, inflight } = fresh();
    store.set("a", { at: Date.now() - 5000, value: 1 });
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const compute = async () => { runs++; await gate; return 2; };
    const [x, y] = await Promise.all([
      cachedOrRefresh(store, inflight, "a", 1000, compute, ok),
      cachedOrRefresh(store, inflight, "a", 1000, compute, ok),
    ]);
    expect([x, y]).toEqual([1, 1]);
    expect(runs).toBe(1);
    release();
    await inflight.get("a");
    expect(await cachedOrRefresh(store, inflight, "a", 1000, compute, ok)).toBe(2);
  });

  test("a failed refresh is not remembered and never replaces the old value", async () => {
    const { store, inflight } = fresh();
    store.set("a", { at: Date.now() - 5000, value: 1 });
    await cachedOrRefresh(store, inflight, "a", 1000, async () => -1, (v) => v > 0);
    await inflight.get("a");
    expect(store.get("a")!.value).toBe(1);
  });
});
