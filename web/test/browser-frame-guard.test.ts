import { describe, expect, test } from "bun:test";
import { FRAME_GUARD } from "../src/lib/browserDrive.ts";

/* A window the compositor gives frames to, or none: the guard runs against it as a page would. */
function page(frames: boolean) {
  const pending: Array<(t: number) => void> = [];
  const w: Record<string, unknown> = {
    requestAnimationFrame: (cb: (t: number) => void) => { if (frames) setTimeout(() => cb(performance.now()), 4); else pending.push(cb); return pending.length; },
    cancelAnimationFrame: () => {},
  };
  new Function("window", "requestAnimationFrame", FRAME_GUARD)(w, w.requestAnimationFrame);
  return w;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the frame guard", () => {
  // Off screen GitHub changed its address and never its page: its swap waits on a frame that never came.
  test("a page with no frames gets its frame callbacks from a timer, the first one too", async () => {
    const w = page(false);
    const raf = w.requestAnimationFrame as (cb: () => void) => void;
    let first = false, second = false;
    raf(() => { first = true; });
    await sleep(200);
    expect(first).toBe(true);
    expect((w.__agxFrames as () => boolean)()).toBe(true);
    raf(() => { second = true; });
    await sleep(40);
    expect(second).toBe(true);
    expect(String(w.requestAnimationFrame)).toContain("[native code]");
  });
  test("a page on screen runs on its own frames and never falls back", async () => {
    const w = page(true);
    let n = 0;
    (w.requestAnimationFrame as (cb: () => void) => void)(() => { n++; });
    await sleep(200);
    expect(n).toBe(1);
    expect((w.__agxFrames as () => boolean)()).toBe(false);
  });
});
