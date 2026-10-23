import { describe, expect, test } from "bun:test";
import { FRAME_GUARD } from "../src/lib/browserDrive.ts";

/* A window the compositor gives frames to, or none: the guard runs against it as a page would. */
function page(frames: boolean) {
  const pending: Array<(t: number) => void> = [];
  const w: Record<string, unknown> = {
    requestAnimationFrame: (cb: (t: number) => void) => { if (frames) setTimeout(() => cb(performance.now()), 4); else pending.push(cb); return pending.length; },
    cancelAnimationFrame: () => {},
    requestIdleCallback: (cb: () => void) => { if (frames) setTimeout(cb, 4); return 1; },
    cancelIdleCallback: () => {},
  };
  new Function("window", "requestAnimationFrame", FRAME_GUARD)(w, w.requestAnimationFrame);
  return w;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the frame guard", () => {
  // Off screen GitHub changed its address and never its page: its swap waits on a frame that never came.
  test("a page with no frames gets its frame callbacks from a timer", async () => {
    const w = page(false);
    const before = w.requestAnimationFrame;
    await sleep(100);
    expect(w.requestAnimationFrame).not.toBe(before);
    let ran = false;
    (w.requestAnimationFrame as (cb: () => void) => void)(() => { ran = true; });
    await sleep(40);
    expect(ran).toBe(true);
    // Idle periods come after frames: without frames an idle callback never ran either.
    let idle = false;
    (w.requestIdleCallback as (cb: () => void) => void)(() => { idle = true; });
    await sleep(80);
    expect(idle).toBe(true);
  });
  // Strict sites check their built-ins: a page that gets frames keeps its own function.
  test("a page on screen is never touched", async () => {
    const w = page(true);
    const before = w.requestAnimationFrame;
    await sleep(120);
    expect(w.requestAnimationFrame).toBe(before);
  });
  // A named global let any page tell an agent's tab from a person's and serve it something else.
  test("a guarded page holds no global that names the guard", async () => {
    const w = page(false);
    await sleep(100);
    expect(Object.keys(w).filter((k) => k.startsWith("__agx"))).toEqual([]);
    expect(Object.getOwnPropertyNames(w).filter((k) => k.startsWith("__agx"))).toEqual([]);
    expect(Object.getOwnPropertySymbols(w)).toEqual([]);
  });
  // A second run on the same document (every ask runs it twice) must not wrap the wrap.
  test("a second run leaves the first wrap in place", async () => {
    const w = page(false);
    await sleep(100);
    const once = w.requestAnimationFrame;
    new Function("window", "requestAnimationFrame", FRAME_GUARD)(w, w.requestAnimationFrame);
    await sleep(100);
    expect(w.requestAnimationFrame).toBe(once);
  });
});
