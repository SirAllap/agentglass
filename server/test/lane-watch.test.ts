import { describe, expect, test } from "bun:test";
// electron/ is plain CommonJS with no build step.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createLaneWatch, WATCH_MIN_MS } = require("../../electron/lane-watch.js");

/* A lane host's webContents as watching sees it: paint listeners and one
   invalidate. Anything that would reach the page (input, focus, JS) is a
   method this fake does not have, so calling one throws. */
function fakeHost() {
  const fns = new Set<(...a: unknown[]) => void>();
  let invalidated = 0;
  return {
    on: (_ev: "paint", fn: (...a: unknown[]) => void) => { fns.add(fn); },
    off: (_ev: "paint", fn: (...a: unknown[]) => void) => { fns.delete(fn); },
    invalidate: () => { invalidated++; },
    isDestroyed: () => false,
    paint: (img: string) => { for (const f of fns) f({}, {}, img); },
    listeners: () => fns.size,
    invalidated: () => invalidated,
  };
}
function fakeClock() {
  let clock = 1_000;
  let t: { fn: () => void } | null = null;
  return {
    now: () => clock,
    tick: (ms: number) => { clock += ms; },
    setTimeout: ((fn: () => void) => { t = { fn }; return 1; }) as unknown as typeof setTimeout,
    clearTimeout: (() => { t = null; }) as unknown as typeof clearTimeout,
    fire: () => { const x = t; t = null; x?.fn(); },
    pending: () => t !== null,
  };
}

describe("watching a lane", () => {
  test("takes nothing until started, and only listens once started", () => {
    const host = fakeHost();
    const sent: string[] = [];
    const w = createLaneWatch(host, (i: string) => sent.push(i));
    expect(host.listeners()).toBe(0);
    w.start();
    w.start();
    expect(host.listeners()).toBe(1);
    expect(host.invalidated()).toBe(1);
    expect(w.watching()).toBe(true);
  });

  test("passes the newest frame on at most every WATCH_MIN_MS, the last of a burst included", () => {
    const host = fakeHost();
    const c = fakeClock();
    const sent: string[] = [];
    const w = createLaneWatch(host, (i: string) => sent.push(i), { now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout });
    w.start();
    host.paint("a");
    expect(sent).toEqual(["a"]);
    c.tick(30); host.paint("b");
    c.tick(30); host.paint("c");
    expect(sent).toEqual(["a"]);
    expect(c.pending()).toBe(true);
    c.tick(WATCH_MIN_MS); c.fire();
    expect(sent).toEqual(["a", "c"]);
  });

  test("stop drops the listener and the frame still waiting", () => {
    const host = fakeHost();
    const c = fakeClock();
    const sent: string[] = [];
    const w = createLaneWatch(host, (i: string) => sent.push(i), { now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout });
    w.start();
    host.paint("a");
    c.tick(10); host.paint("b");
    w.stop();
    expect(host.listeners()).toBe(0);
    expect(c.pending()).toBe(false);
    host.paint("c");
    expect(sent).toEqual(["a"]);
  });
});

describe("main's lane watch handlers", () => {
  const main = require("node:fs").readFileSync(new URL("../../electron/main.js", import.meta.url), "utf8") as string;
  const body = (name: string) => { const at = main.indexOf(`ipcMain.handle("${name}"`); return main.slice(at, main.indexOf("\n  });", at)); };

  test("answer the app window only, and send the page nothing", () => {
    for (const h of ["ag:laneTabs", "ag:laneWatch"]) {
      const b = body(h);
      expect(b).toContain("e.sender !== mainWindow.webContents");
      expect(b).not.toMatch(/sendInputEvent|executeJavaScript|\.focus\(|setFrameRate/);
    }
  });

  test("a lane closing stops its watch", () => {
    const destroy = main.slice(main.indexOf("function destroyLaneHost("), main.indexOf("function destroyLaneHost(") + 400);
    expect(destroy).toContain("laneWatches.get(id)?.stop();");
  });
});
