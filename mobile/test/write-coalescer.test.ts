/*
 * The batching that turns two hundred bridge crossings a second into twenty.
 *
 * Every rule here is one that shows up as a broken-feeling terminal when it is
 * wrong: an echo that lags a keystroke, a stream that never flushes because
 * the timer keeps being rearmed, or a buffer that grows until the page dies.
 */
import { describe, expect, test } from "bun:test";
import { FLUSH_MS, MAX_PENDING, createCoalescer } from "../src/terminal/writeCoalescer.ts";

/** A clock and a scheduler under the test's control. Real timers would make
 *  every case below a sleep, and the leading-edge rule needs an EXACT
 *  boundary rather than "about 48ms later". */
function rig() {
  let at = 1_000_000;
  const timers: { id: number; fn: () => void; due: number }[] = [];
  let next = 1;
  const sent: string[][] = [];

  const c = createCoalescer(
    (chunks) => { sent.push(chunks); },
    () => at,
    (fn, ms) => { const id = next++; timers.push({ id, fn, due: at + ms }); return id as never; },
    (id) => { const i = timers.findIndex((t) => t.id === (id as never as number)); if (i >= 0) timers.splice(i, 1); },
  );

  return {
    c,
    sent,
    /** Move time on, firing anything that comes due. */
    tick(ms: number) {
      at += ms;
      for (const t of [...timers]) {
        if (t.due <= at) {
          const i = timers.indexOf(t);
          if (i >= 0) timers.splice(i, 1);
          t.fn();
        }
      }
    },
    armed: () => timers.length,
  };
}

describe("the leading edge", () => {
  test("the first chunk goes straight through", () => {
    // It is almost always the echo of a key somebody just pressed. Holding it
    // is the exact feeling this module exists to remove.
    const { c, sent } = rig();
    c.push("AAA");
    expect(sent).toEqual([["AAA"]]);
  });

  test("a chunk after a quiet period also goes straight through", () => {
    const { c, sent, tick } = rig();
    c.push("one");
    tick(FLUSH_MS * 4);
    c.push("two");
    expect(sent).toEqual([["one"], ["two"]]);
  });
});

describe("inside the window", () => {
  test("what arrives during it is held and sent together, in order", () => {
    const { c, sent, tick } = rig();
    c.push("first");          // leading edge, sent now
    c.push("a");
    c.push("b");
    c.push("c");
    expect(sent).toEqual([["first"]]);
    tick(FLUSH_MS);
    expect(sent).toEqual([["first"], ["a", "b", "c"]]);
  });

  test("a steady stream still flushes — the timer is not rearmed per chunk", () => {
    // The bug this catches: arming a fresh timer on every arrival means a pane
    // producing output faster than the window never delivers anything at all.
    const { c, sent, tick, armed } = rig();
    c.push("go");
    for (let i = 0; i < 20; i++) { tick(2); c.push(`x${i}`); }
    expect(armed()).toBe(1);
    tick(FLUSH_MS);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.flat()).toContain("x19");
  });

  test("nothing held means nothing delivered", () => {
    // An empty flush must not call through with an empty array — a write of
    // nothing is a bridge crossing for nothing.
    const { c, sent, tick } = rig();
    c.push("only");
    tick(FLUSH_MS * 3);
    expect(sent).toEqual([["only"]]);
  });

  test("an empty chunk is not a chunk", () => {
    const { c, sent } = rig();
    c.push("");
    expect(sent).toEqual([]);
    expect(c.pending()).toBe(0);
  });
});

describe("the cap", () => {
  test("past it, the window is abandoned rather than the buffer grown", () => {
    const { c, sent } = rig();
    c.push("lead");
    const big = "z".repeat(MAX_PENDING + 1);
    c.push(big);
    // Sent immediately, not on the timer: a bound beats a batch.
    expect(sent).toEqual([["lead"], [big]]);
  });

  test("it counts what is held, not one chunk", () => {
    const { c, sent } = rig();
    c.push("lead");
    const half = "z".repeat(Math.ceil(MAX_PENDING / 2));
    c.push(half);
    expect(sent.length).toBe(1);
    c.push(half);
    expect(sent.length).toBe(2);
    expect(sent[1]).toEqual([half, half]);
  });
});

describe("flush and clear", () => {
  test("flush delivers what is held, now", () => {
    const { c, sent } = rig();
    c.push("lead");
    c.push("held");
    c.flush();
    expect(sent).toEqual([["lead"], ["held"]]);
  });

  test("clear throws it away rather than delivering it", () => {
    // A buffer belonging to a pane nobody is looking at must never land on the
    // next one.
    const { c, sent, tick, armed } = rig();
    c.push("lead");
    c.push("stale");
    c.clear();
    expect(c.pending()).toBe(0);
    expect(armed()).toBe(0);
    tick(FLUSH_MS * 3);
    expect(sent).toEqual([["lead"]]);
  });

  test("flushing an empty coalescer is not an error and sends nothing", () => {
    const { c, sent } = rig();
    c.flush();
    expect(sent).toEqual([]);
  });
});
