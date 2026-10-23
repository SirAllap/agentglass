/*
 * A suspended machine is not a blocked loop.
 *
 * performance.now() keeps counting across a suspend in Bun on Linux, so the
 * first heartbeat after a resume measured the whole sleep as one stall:
 * "event loop blocked 219287314ms (3 ms CPU)". The CPU clock stops while the
 * machine sleeps, and that is the difference the decision is made on.
 */
import { describe, expect, test } from "bun:test";
import { suspended, SUSPEND_MIN_MS } from "../src/loopwatch.ts";

const source = await Bun.file(new URL("../src/loopwatch.ts", import.meta.url)).text();

describe("telling a suspend from a stall", () => {
  test("two and a half days with 3 ms of CPU is a suspend", () => {
    expect(suspended(219_287_314, 3)).toBe(true);
    // A lid closed for ten minutes.
    expect(suspended(600_000, 40)).toBe(true);
  });

  test("a held loop that computes is a stall, however long", () => {
    expect(suspended(90_000, 88_000)).toBe(false);
    expect(suspended(3_000, 2_900)).toBe(false);
  });

  test("a wait on a read or a child under a minute is still a stall", () => {
    // The longest real stall in the logs: 50 s waiting, almost no CPU.
    expect(suspended(50_000, 12)).toBe(false);
    expect(suspended(SUSPEND_MIN_MS, 0)).toBe(false);
    expect(suspended(800, 0)).toBe(false);
  });

  test("over a minute with a few percent of CPU is a stall, not a suspend", () => {
    expect(suspended(120_000, 6_000)).toBe(false);
  });
});

describe("the heartbeat asks before it counts", () => {
  test("a suspend returns before the stall is totalled, ringed or logged", () => {
    const start = source.indexOf("export function watchLoop(): void {");
    expect(start).toBeGreaterThan(-1);
    // To the function's own closing brace, not a fixed window.
    const end = source.indexOf("\n}\n", start);
    const body = source.slice(start, end).split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
    const ask = body.indexOf("if (suspended(ms, cpuMs)) return;");
    expect(ask).toBeGreaterThan(-1);
    for (const effect of ["total += ms", "ring.push(entry)", "console.warn("]) {
      expect(body.indexOf(effect)).toBeGreaterThan(ask);
    }
  });
});
