/*
 * An unfocused but visible window stays live at 1 flush/s; the 10 s clock tick
 * does not re-derive agents; open-tool frames ride the event flush.
 */
import { describe, expect, test } from "bun:test";
import { createFlushGate, flushDelay, foldTools, makeAgentsDeriver } from "../src/lib/liveFlush.ts";
import { deriveAgentsBase, settleAgents } from "../src/lib/derive.ts";
import type { WatchEvent } from "../../shared/types.ts";
import { globalStubs } from "./stubGlobal.ts";
import type { OpenToolCall } from "../../shared/types.ts";

const stubGlobal = globalStubs();

/** A steady stream (one event / ms) for `ms`, flushes counted on a fake clock. */
function flushesIn(ms: number, focused: () => boolean): number {
  let t = 0, runs = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const gate = createFlushGate(() => { runs++; }, () => flushDelay(false, focused()), (fn, d) => { timers.push({ at: t + d, fn }); });
  for (t = 0; t < ms; t += 1) {
    gate.schedule();
    for (const x of timers.filter((x) => x.at <= t)) { timers.splice(timers.indexOf(x), 1); x.fn(); }
  }
  return runs;
}

describe("focus-aware flush", () => {
  test("focused 10 s is ~45 flushes, unfocused 10 s is 10", () => {
    stubGlobal("document", { hasFocus: () => true });
    const hasFocus = () => (globalThis as any).document.hasFocus() as boolean;
    const f = flushesIn(10_010, hasFocus);
    expect(f).toBeGreaterThanOrEqual(43);
    expect(f).toBeLessThanOrEqual(46);
    stubGlobal("document", { hasFocus: () => false });
    expect(flushesIn(10_010, hasFocus)).toBe(10);
  });
  test("a blur applies from the next burst", () => {
    expect(flushDelay(false, true)).toBe(220);
    expect(flushDelay(false, false)).toBe(1000);
    expect(flushDelay(true, true)).toBe(1000);
  });
});

describe("agents are not re-derived by the clock, yet the clock still moves them", () => {
  test("10 ticks with the same inputs = 0 heavy derives; a new events array = 1", () => {
    let runs = 0;
    const derive = makeAgentsDeriver((_e: unknown[], _o: unknown[]) => { runs++; return []; });
    const events: unknown[] = [], tools: unknown[] = [];
    derive(events, tools);
    for (let i = 0; i < 10; i++) derive(events, tools);
    expect(runs).toBe(1);
    derive([...events], tools);
    expect(runs).toBe(2);
  });
  test("no new events, clock past the idle threshold = idle, from the same base", () => {
    const t0 = Date.now();
    const e = { id: 1, source_app: "app", session_id: "s1", hook_event_type: "PostToolUse", tool_name: "Bash", timestamp: t0 - 1000, payload: {}, is_error: 0 } as unknown as WatchEvent;
    let heavy = 0;
    const derive = makeAgentsDeriver((ev: WatchEvent[]) => { heavy++; return deriveAgentsBase(ev); });
    const events = [e];
    let base = derive(events);
    expect(settleAgents(base, t0)[0].status).toBe("working");
    for (let tick = 1; tick <= 10; tick++) {
      base = derive(events);
      settleAgents(base, t0 + tick * 10_000);
    }
    expect(heavy).toBe(1);
    expect(settleAgents(base, t0 + 6 * 60_000)[0].status).toBe("idle");
    expect(settleAgents(base, t0)[0].status).toBe("working"); // a settle never mutates the base
  });
});

describe("openTools frames fold into the flush", () => {
  test("5 frames inside one window = 1 flush, holding the last list", () => {
    let runs = 0, latest: OpenToolCall[] | null = null;
    const timers: (() => void)[] = [];
    const gate = createFlushGate(() => { runs++; }, () => 220, (fn) => { timers.push(fn); });
    for (let i = 0; i < 5; i++) { latest = [{ session_id: `s${i}`, tool_name: "Bash", since: 1 } as OpenToolCall]; gate.schedule(); }
    expect(timers.length).toBe(1);
    timers.forEach((f) => f());
    expect(runs).toBe(1);
    expect(foldTools([], latest, [])).toBe(latest as OpenToolCall[]);
  });
  test("no frame and no Post leaves the same array", () => {
    const cur: OpenToolCall[] = [];
    expect(foldTools(cur, null, [])).toBe(cur);
  });
});
