// Collapsing concurrent identical work into one computation.
//
// The panels poll, and the app is left open across several tabs at once, so the
// same expensive git read is asked for by several callers in the same instant.
// The per-endpoint caches don't catch that — a just-expired TTL is recomputed
// by each caller — and each recompute is a fan-out of `git` subprocesses on the
// one thread that carries the terminal. These pin the contract that makes the
// duplicates share instead of stampede.
import { describe, expect, it } from "bun:test";
import { singleFlight, inflightCount } from "../src/singleflight.ts";

describe("single-flight", () => {
  it("runs the work once for callers that overlap in time", async () => {
    let runs = 0;
    const fn = async () => { runs++; await Bun.sleep(20); return runs; };
    // Ten simultaneous callers for the same key — the stampede a cache miss
    // under several open tabs produces.
    const results = await Promise.all(Array.from({ length: 10 }, () => singleFlight("k", fn)));
    expect(runs).toBe(1);                         // one computation…
    expect(results).toEqual(Array(10).fill(1));   // …one answer, shared by all
  });

  it("keeps different keys apart", async () => {
    let a = 0, b = 0;
    const [ra, rb] = await Promise.all([
      singleFlight("a", async () => { a++; await Bun.sleep(10); return "A"; }),
      singleFlight("b", async () => { b++; await Bun.sleep(10); return "B"; }),
    ]);
    expect([ra, rb]).toEqual(["A", "B"]);
    expect([a, b]).toEqual([1, 1]);
  });

  it("is dedup, not a cache — a caller after the first settles recomputes", async () => {
    let runs = 0;
    const fn = async () => { runs++; await Bun.sleep(5); return runs; };
    const first = await singleFlight("seq", fn);   // completes fully…
    const second = await singleFlight("seq", fn);  // …then a fresh one arrives
    expect(first).toBe(1);
    expect(second).toBe(2);                        // recomputed, nothing stale served
  });

  it("releases the key when the work throws, and never memoises the failure", async () => {
    // A leaked entry would pin one (failed) promise forever — the app would stop
    // being able to run that read at all, which is the freeze this whole area
    // exists to prevent, reached from the other side.
    await expect(singleFlight("boom", async () => { throw new Error("nope"); })).rejects.toThrow("nope");
    expect(inflightCount()).toBe(0);
    // …and the next caller gets a clean run, not the cached rejection.
    const ok = await singleFlight("boom", async () => "recovered");
    expect(ok).toBe("recovered");
  });

  it("an error rejects every overlapping caller", async () => {
    const fn = async () => { await Bun.sleep(10); throw new Error("shared failure"); };
    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => singleFlight("err", fn)));
    expect(settled.every((s) => s.status === "rejected")).toBe(true);
    expect(inflightCount()).toBe(0);
  });

  it("empties the in-flight map once everything settles", async () => {
    await Promise.all([
      singleFlight("x", async () => { await Bun.sleep(5); return 1; }),
      singleFlight("y", async () => { await Bun.sleep(5); return 2; }),
    ]);
    expect(inflightCount()).toBe(0);
  });
});
