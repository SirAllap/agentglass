/*
 * One timer for the next due time (wakeup.ts), which replaced two ten-second
 * ticks. What these pin is what the tick promised: it fires on time, it fires
 * what was added while it slept, it keeps going after a failure, and it does
 * nothing at all when nothing is pending.
 */
import { describe, expect, test } from "bun:test";
import { createWakeup } from "../src/wakeup.ts";

const until = async (fn: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await Bun.sleep(10); }
  return fn();
};

describe("createWakeup", () => {
  test("runs at the due time, not before it", async () => {
    const t0 = Date.now();
    let ranAt = 0;
    const w = createWakeup({ next: () => (ranAt ? null : t0 + 600), run: () => { ranAt = Date.now(); }, capMs: 5_000 });
    w.arm();
    expect(await until(() => ranAt > 0, 3_000)).toBe(true);
    expect(ranAt - t0).toBeGreaterThanOrEqual(600);
    expect(ranAt - t0).toBeLessThan(1_200);
    w.stop();
  });

  test("nothing pending means no timer, and nothing runs", async () => {
    let ran = 0; let asked = 0;
    const w = createWakeup({ next: () => { asked++; return null; }, run: () => { ran++; }, capMs: 100 });
    w.arm();
    await Bun.sleep(700);
    expect(ran).toBe(0);
    expect(asked).toBe(1);               // read once, then no timer: not once per cap
    w.stop();
  });

  test("a row added while it sleeps for something later is run at its own, earlier, time", async () => {
    let due = Date.now() + 60_000;
    let ranAt = 0;
    const w = createWakeup({ next: () => (ranAt ? null : due), run: () => { ranAt = Date.now(); }, capMs: 30_000 });
    w.arm();
    const t0 = Date.now();
    due = t0 + 400;                      // what addReminder does, then calls arm()
    w.arm();
    expect(await until(() => ranAt > 0, 3_000)).toBe(true);
    expect(ranAt - t0).toBeLessThan(1_000);
    w.stop();
  });

  test("a far due time is re-read at the cap, so a sleep through it is caught within the cap", async () => {
    let asked = 0;
    const w = createWakeup({ next: () => { asked++; return Date.now() + 3_600_000; }, run: () => {}, capMs: 300 });
    w.arm();
    await Bun.sleep(1_000);
    expect(asked).toBeGreaterThanOrEqual(3);
    w.stop();
  });

  test("a run that throws, and a read that throws, do not stop the clock", async () => {
    let runs = 0; let reads = 0;
    const w = createWakeup({
      next: () => { reads++; if (reads === 2) throw new Error("db busy"); return Date.now() + 100; },
      run: () => { runs++; throw new Error("boom"); },
      capMs: 300,
    });
    w.arm();
    expect(await until(() => runs >= 3, 4_000)).toBe(true);
    w.stop();
  });

  test("runs never overlap, and stop() ends it", async () => {
    let active = 0; let worst = 0; let runs = 0;
    const w = createWakeup({
      next: () => Date.now(),
      run: async () => { active++; worst = Math.max(worst, active); runs++; await Bun.sleep(300); active--; },
      capMs: 100,
    });
    w.now(); w.now(); w.arm();
    await Bun.sleep(900);
    w.stop();
    const after = runs;
    await Bun.sleep(600);
    expect(worst).toBe(1);
    expect(runs).toBe(after);
  });
});
