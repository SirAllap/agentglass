/*
 * One overview fetch at a time, and no request lost.
 *
 * The regression: an event that arrived while a fetch was on the wire was
 * dropped, because only a `fresh` one was queued behind it. Stopping eleven
 * containers is eleven `die` events against fetches that each take about a
 * second, so the last event was often the one thrown away — the list kept
 * drawing every container as running and nothing else was coming to fix it.
 */
import { describe, expect, test } from "bun:test";
import { coalescing } from "../src/lib/dockerQueue.ts";

/** A run the test lets finish when it likes, so "in flight" is a fact. */
function rig() {
  const calls: boolean[] = [];
  const waiting: Array<() => void> = [];
  const refetch = coalescing((fresh) => {
    calls.push(fresh);
    return new Promise<void>((done) => waiting.push(done));
  });
  const settle = () => waiting.shift()!();
  return { calls, waiting, refetch, settle };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("coalescing", () => {
  test("a request during a fetch owns the run after it", async () => {
    const r = rig();
    const first = r.refetch();
    await flush();
    expect(r.calls).toEqual([false]);
    void r.refetch();                     // an event lands mid-fetch
    r.settle();
    await flush();
    expect(r.calls).toEqual([false, false]);
    r.settle();
    await first;
    expect(r.calls).toEqual([false, false]);
  });

  test("a burst during one fetch still costs one run after it", async () => {
    const r = rig();
    const first = r.refetch();
    await flush();
    for (let i = 0; i < 5; i++) void r.refetch();
    r.settle();
    await flush();
    expect(r.calls).toHaveLength(2);
    r.settle();
    await first;
    expect(r.calls).toHaveLength(2);
  });

  test("a fresh request in the burst makes the queued run fresh", async () => {
    const r = rig();
    const first = r.refetch();
    await flush();
    void r.refetch();
    void r.refetch(true);
    r.settle();
    await flush();
    expect(r.calls).toEqual([false, true]);
    r.settle();
    await first;
  });

  test("nothing is queued when nothing arrives, and an idle call runs at once", async () => {
    const r = rig();
    const one = r.refetch();
    r.settle();
    await one;
    expect(r.calls).toEqual([false]);
    const two = r.refetch(true);
    await flush();
    expect(r.calls).toEqual([false, true]);
    r.settle();
    await two;
    expect(r.waiting).toHaveLength(0);
  });

  test("every caller waits for the run that answers its request", async () => {
    const r = rig();
    const first = r.refetch();
    await flush();
    let answer = "pending";
    void r.refetch().then(() => { answer = "done"; });
    r.settle();
    await flush();
    expect(answer).toBe("pending");        // still the first run, not its own
    r.settle();
    await flush();
    expect(answer).toBe("done");
    await first;
  });
});
