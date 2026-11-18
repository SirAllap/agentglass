/*
 * The record reap is async, so two callers (the startup reap and a sweeper
 * tick) could walk the same lease records at once and both kill or forget.
 * One reap at a time is shared; a tick that outlives the interval is skipped,
 * not doubled.
 */
import { describe, expect, test } from "bun:test";
import { reapMirrorSessionsOnce, startMirrorSweeper, stopMirrorSweeper } from "../src/tmuxctl.ts";

const held = () => {
  let open!: (v: string[]) => void;
  let calls = 0;
  const reap = () => { calls++; return new Promise<string[]>((r) => { open = r; }); };
  return { reap, calls: () => calls, open: (v: string[] = []) => open(v) };
};

describe("reapMirrorSessionsOnce", () => {
  test("a second caller while one reap runs shares it; the next one after it starts anew", async () => {
    const h = held();
    const a = reapMirrorSessionsOnce(h.reap);
    const b = reapMirrorSessionsOnce(h.reap);
    expect(b).toBe(a);
    expect(h.calls()).toBe(1);
    h.open(["agx-phone-1-abc"]);
    expect(await b).toEqual(["agx-phone-1-abc"]);
    const c = reapMirrorSessionsOnce(h.reap);
    expect(c).not.toBe(a);
    expect(h.calls()).toBe(2);
    h.open();
    await c;
  });
});

describe("startMirrorSweeper", () => {
  test("a tick still running when the next one fires is not doubled", async () => {
    const h = held();
    let orphanCalls = 0;
    startMirrorSweeper([], 20, { once: h.reap, orphans: async () => { orphanCalls++; return []; } });
    try {
      await Bun.sleep(150); // seven ticks while the first reap is held open
      expect(h.calls()).toBe(1);
      expect(orphanCalls).toBe(0);
      h.open();
      await Bun.sleep(60);
      expect(orphanCalls).toBeGreaterThanOrEqual(1);
      expect(h.calls()).toBeGreaterThanOrEqual(2);
    } finally { stopMirrorSweeper(); }
  });
});
