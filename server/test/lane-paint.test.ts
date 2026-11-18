import { describe, expect, test } from "bun:test";
// electron/ is plain CommonJS with no build step.
const { laneFrameRate, laneWarmMs, createLanePaint, watchLaneGuest, LANE_BUSY_FPS, LANE_IDLE_FPS, LANE_IDLE_MS, WARM_MS } = require("../../electron/lane-paint.js");

function fakeTimers() {
  let t: { fn: () => void; at: number } | null = null;
  let clock = 1_000;
  return {
    now: () => clock,
    tick: (ms: number) => { clock += ms; },
    setTimeout: ((fn: () => void, at: number) => { t = { fn, at }; return 1; }) as unknown as typeof setTimeout,
    clearTimeout: (() => { t = null; }) as unknown as typeof clearTimeout,
    fire: () => { const x = t; t = null; x?.fn(); },
    pending: () => t,
  };
}
const fakeHost = () => {
  const rates: (number | string)[] = [];
  return { rates, setFrameRate: (f: number) => rates.push(f), stopPainting: () => rates.push("stop"), startPainting: () => rates.push("start"), isDestroyed: () => false };
};

describe("laneFrameRate", () => {
  test("busy until the idle window passes, then idle", () => {
    expect(laneFrameRate(0)).toBe(LANE_BUSY_FPS);
    expect(laneFrameRate(LANE_IDLE_MS - 1)).toBe(LANE_BUSY_FPS);
    expect(laneFrameRate(LANE_IDLE_MS)).toBe(LANE_IDLE_FPS);
    expect(laneFrameRate(5, 5)).toBe(LANE_IDLE_FPS);
  });
  test("idle means not painting; a screencast keeps the lane busy", () => {
    expect(LANE_IDLE_FPS).toBe(0);
    expect(laneFrameRate(LANE_IDLE_MS, LANE_IDLE_MS, true)).toBe(LANE_BUSY_FPS);
  });
  test("a capture waits only when the lane was not already busy", () => {
    expect(laneWarmMs(LANE_BUSY_FPS)).toBe(0);
    expect(laneWarmMs(LANE_IDLE_FPS)).toBe(WARM_MS);
    expect(laneWarmMs(0)).toBe(WARM_MS);
    expect(WARM_MS).toBeGreaterThanOrEqual(Math.ceil(1000 / LANE_BUSY_FPS) * 2);
  });
});

describe("createLanePaint", () => {
  test("busy on a verb, idle after the window, raised again on the next verb", () => {
    const host = fakeHost(); const tm = fakeTimers();
    const p = createLanePaint(host, { ...tm, idleMs: 100 });
    expect(p.touch()).toBe(WARM_MS);
    expect(host.rates).toEqual([LANE_BUSY_FPS]);
    tm.tick(WARM_MS);
    expect(p.touch()).toBe(0); // already busy and warm: no extra setFrameRate, no wait
    expect(host.rates).toEqual([LANE_BUSY_FPS]);
    tm.fire();
    expect(host.rates).toEqual([LANE_BUSY_FPS, "stop"]); // idle: no paint at all, not a slow clock
    expect(p.rate()).toBe(LANE_IDLE_FPS);
    expect(p.touch()).toBe(WARM_MS);
    expect(host.rates).toEqual([LANE_BUSY_FPS, "stop", "start", LANE_BUSY_FPS]);
  });
  test("a capture a few ms after the raising verb still waits out the warm-up", () => {
    const host = fakeHost(); const tm = fakeTimers();
    const p = createLanePaint(host, { ...tm, idleMs: 100 });
    expect(p.touch()).toBe(WARM_MS); // observe's executeJavaScript raises the idle lane
    tm.tick(5);
    expect(p.touch()).toBe(WARM_MS - 5); // its capturePage owes the rest
    expect(host.rates).toEqual([LANE_BUSY_FPS]);
    tm.tick(WARM_MS);
    expect(p.touch()).toBe(0);
  });
  test("a screencast holds the lane busy past the idle window; its stop releases it", () => {
    const host = fakeHost(); const tm = fakeTimers();
    const p = createLanePaint(host, { ...tm, idleMs: 100 });
    p.touch(); p.hold(1);
    tm.fire();
    expect(host.rates).toEqual([LANE_BUSY_FPS]); // still painting for the stream
    p.hold(-1); // restarts the idle window
    expect(tm.pending()?.at).toBe(100);
    tm.fire();
    expect(host.rates).toEqual([LANE_BUSY_FPS, "stop"]);
    p.touch(); p.hold(1); p.hold(1); p.hold(0); // debugger went: every stream ended
    tm.fire();
    expect(host.rates.at(-1)).toBe("stop");
  });
  test("each verb resets the one timer; dispose clears it", () => {
    const host = fakeHost(); const tm = fakeTimers();
    const p = createLanePaint(host, { ...tm, idleMs: 100 });
    p.touch(); p.touch();
    expect(tm.pending()?.at).toBe(100);
    p.dispose();
    expect(tm.pending()).toBeNull();
  });
  test("a destroyed host is left alone", () => {
    const rates: number[] = [];
    const p = createLanePaint({ setFrameRate: (f: number) => rates.push(f), isDestroyed: () => true }, fakeTimers());
    p.touch();
    expect(rates).toEqual([]);
  });
});

describe("watchLaneGuest", () => {
  test("every verb raises the lane; a capture after an idle drop waits for a fresh frame", async () => {
    const calls: string[] = [];
    let touched = 0; let warm = WARM_MS;
    const paint = { touch: () => { touched++; const w = warm; warm = 0; return w; } };
    const guest: any = {
      executeJavaScript: (c: string) => { calls.push(`js:${c}`); return Promise.resolve(1); },
      sendInputEvent: () => { calls.push("input"); },
      capturePage: () => { calls.push("cap"); return Promise.resolve("img"); },
      debugger: { sendCommand: (m: string) => { calls.push(m); return Promise.resolve({}); }, on: () => {} },
    };
    watchLaneGuest(guest, paint);
    const t0 = Date.now();
    expect(await guest.capturePage()).toBe("img");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(WARM_MS - 5);
    expect(await guest.executeJavaScript("1")).toBe(1);
    guest.sendInputEvent({});
    await guest.debugger.sendCommand("Page.captureScreenshot", {});
    expect(touched).toBe(4);
    expect(calls).toEqual(["cap", "js:1", "input", "Page.captureScreenshot"]);
  });
  test("start/stop screencast and a debugger detach hold and release the lane", async () => {
    const holds: number[] = [];
    let onDetach: () => void = () => {};
    const paint = { touch: () => 0, hold: (d: number) => holds.push(d) };
    const guest: any = { debugger: { sendCommand: () => Promise.resolve({}), on: (ev: string, fn: () => void) => { if (ev === "detach") onDetach = fn; } } };
    watchLaneGuest(guest, paint);
    await guest.debugger.sendCommand("Page.startScreencast", {});
    await guest.debugger.sendCommand("Page.stopScreencast");
    await guest.debugger.sendCommand("Runtime.evaluate", {});
    onDetach();
    expect(holds).toEqual([1, -1, 0]);
  });
});
