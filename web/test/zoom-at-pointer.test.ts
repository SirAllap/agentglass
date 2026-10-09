/*
 * The gesture picks its target by where the pointer is, and a web page is one
 * of the targets.
 *
 * The rule this module exists for had two answers — a terminal, or the window
 * — and a page in the browser panel fell into "the window". Measured on the
 * running app with the pointer over the page, Ctrl+ twice: the window's
 * devicePixelRatio went 1.25 -> 1.5625 and the page came back at innerWidth
 * 2790, exactly what it started at.
 *
 * The second half is subtler and cost a whole build to find: the first fix
 * asked `elementFromPoint(x, y)?.closest("webview")`, the way the terminal is
 * asked. Measured on the running app, the point at the centre of the guest
 * comes back as a DIV — the panel lays its own surfaces over the guest — so
 * that branch was false everywhere on the page and never ran once. A `<webview>`
 * is a hole with another process behind it; the only thing this document can
 * honestly say about it is where it is. Hence the rectangle.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { globalStubs } from "./stubGlobal";
const stubGlobal = globalStubs();

const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
});

/** Whatever the DOM is pretending to hold this test. */
let webviews: Array<{
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  /** What `getComputedStyle` says about it. The workspace hides an inactive
   *  view with `visibility: hidden`, which keeps the layout box. */
  visibility?: string;
  display?: string;
}> = [];
let atPoint: { tag: string; xterm: boolean } | null = null;

const rect = (left: number, top: number, w: number, h: number) =>
  ({ left, top, right: left + w, bottom: top + h, width: w, height: h });

/* stubGlobal gives these back after the file: bun runs every web test file in
   one process, and a `document` that only knows about <webview>, left behind,
   made gate-store and docker-panel-render fail while both passed alone. */

const listeners = new Map<string, (e: any) => void>();
stubGlobal("window", {
  addEventListener: (type: string, fn: (e: any) => void) => { listeners.set(type, fn); },
});
stubGlobal("getComputedStyle", (el: any) => ({
  visibility: el?.__visibility ?? "visible",
  display: el?.__display ?? "block",
}));
stubGlobal("document", {
  querySelectorAll: (sel: string) =>
    sel === "webview"
      ? webviews.map((v) => ({
          getBoundingClientRect: () => v.rect,
          __visibility: v.visibility ?? "visible",
          __display: v.display ?? "block",
        }))
      : [],
  elementFromPoint: () => atPoint && { closest: (s: string) => (s === ".xterm" && atPoint!.xterm ? {} : null) },
});

/*
 * A FRESH COPY OF THE MODULE, not whichever one was loaded first.
 *
 * `zoomTarget.ts` starts tracking the pointer when it is imported, on whatever
 * `window` exists at that moment. `bun test` runs every file in one process, and
 * other files import it too — through the browser panel and the app — so when
 * one of them ran first it was already tracking THAT file's window, and every
 * pointer this file moves went nowhere. On ext4 this file happened to run
 * early; on btrfs, which lists a directory in a different order, it ran 346th
 * of 349 and all sixteen cases failed with nothing wrong in the code. A query
 * on the specifier is a separate module instance in bun, so this one is
 * imported after the stubs above exist, whatever ran before it.
 */
const FRESH = "../src/lib/zoomTarget.ts?fresh";
const { zoomAtPointer, overBrowserPage, overTerminal } =
  (await import(FRESH)) as typeof import("../src/lib/zoomTarget.ts");
const { setPageZoomer } = await import("../src/lib/browserDrive.ts");
const { currentScale } = await import("../src/lib/uiScale.ts");

/** Where the pointer is, through the listener the module actually installs —
 *  not by reaching into its private state. */
const pointAt = (x: number, y: number) => listeners.get("pointermove")!({ clientX: x, clientY: y });

beforeEach(() => {
  webviews = [];
  atPoint = { tag: "DIV", xterm: false };
  setPageZoomer(null);
  store.clear();
});

describe("is the pointer over a page", () => {
  test("yes, anywhere inside the guest's rectangle", () => {
    webviews = [{ rect: rect(100, 200, 800, 600) }];
    pointAt(500, 500);
    expect(overBrowserPage()).toBe(true);
  });

  test("even when something is drawn on top of it", () => {
    // The measured case: the panel's own overlay answers elementFromPoint.
    // Asked the terminal's way, this returned false everywhere on the page.
    webviews = [{ rect: rect(0, 0, 1000, 1000) }];
    atPoint = { tag: "DIV", xterm: false };
    pointAt(500, 500);
    expect(overBrowserPage()).toBe(true);
  });

  test("no, outside it", () => {
    webviews = [{ rect: rect(100, 200, 800, 600) }];
    pointAt(50, 50);
    expect(overBrowserPage()).toBe(false);
  });

  /*
   * THE ONE THAT WAS WRONG ON A REAL SCREEN.
   *
   * The workspace keeps every view mounted and hides the inactive ones with
   * `visibility: hidden` — on purpose, because `display: none` measures a
   * terminal at zero and reflows it to one column. A hidden box keeps its
   * layout, so the guest still had a full-size rect behind the task board, and
   * Ctrl+ there zoomed a page nobody was looking at: the app never grew and the
   * browser was found at 350% the next time it was opened.
   */
  test("no, when the browser view is merely hidden behind another", () => {
    webviews = [{ rect: rect(0, 0, 1920, 1080), visibility: "hidden" }];
    pointAt(800, 500);
    expect(overBrowserPage()).toBe(false);
  });

  test("no, when it is display:none either", () => {
    webviews = [{ rect: rect(0, 0, 1920, 1080), display: "none" }];
    pointAt(800, 500);
    expect(overBrowserPage()).toBe(false);
  });

  test("and yes again once that view is the one on screen", () => {
    webviews = [{ rect: rect(0, 0, 1920, 1080), visibility: "visible" }];
    pointAt(800, 500);
    expect(overBrowserPage()).toBe(true);
  });

  test("and no for a panel that is not laid out", () => {
    // A hidden browser panel keeps its <webview> in the DOM with an empty rect.
    webviews = [{ rect: rect(0, 0, 0, 0) }];
    pointAt(0, 0);
    expect(overBrowserPage()).toBe(false);
  });

  test("nor when the pointer has left the window", () => {
    // The same state the module starts in (-1, -1). Reached through the
    // `pointerleave` listener rather than by resetting private state, so this
    // also pins that a pointer that has left is over nothing.
    webviews = [{ rect: rect(0, 0, 1000, 1000) }];
    pointAt(500, 500);
    expect(overBrowserPage()).toBe(true);
    listeners.get("pointerleave")!({});
    expect(overBrowserPage()).toBe(false);
  });
});

describe("what the gesture does", () => {
  test("over a page, it zooms the page and leaves the window alone", async () => {
    webviews = [{ rect: rect(0, 0, 1000, 1000) }];
    pointAt(500, 500);
    const asked: (number | null)[] = [];
    setPageZoomer(async (dir) => { asked.push(dir); return { factor: 1.2, percent: 120, pane: { width: 2790, height: 1698 } }; });
    const before = currentScale();
    const r = await zoomAtPointer(1);
    expect(asked[0]).toBe(1);
    expect(r.what).toBe("page");
    expect(r.label).toBe("Page 120%");
    expect(currentScale(), "the app did not move").toBe(before);
  });

  test("over a terminal it is still the terminal", () => {
    // The branch that was already there must not be shadowed by the new one.
    webviews = [{ rect: rect(0, 0, 1000, 1000) }];
    atPoint = { tag: "DIV", xterm: true };
    pointAt(500, 500);
    return zoomAtPointer(1).then((r) => expect(r.what).toBe("terminal"));
  });

  test("anywhere else it is the window, as it always was", () => {
    pointAt(500, 500);
    return zoomAtPointer(1).then((r) => expect(r.what).toBe("app"));
  });

  test("and with no panel mounted the gesture is not eaten", async () => {
    // A key that does nothing at all reads as broken. Falling through to the
    // window is worse than right and much better than dead.
    webviews = [{ rect: rect(0, 0, 1000, 1000) }];
    pointAt(500, 500);
    const r = await zoomAtPointer(1);
    expect(r.what).toBe("app");
  });

  test("nor when the page refuses", async () => {
    webviews = [{ rect: rect(0, 0, 1000, 1000) }];
    pointAt(500, 500);
    setPageZoomer(async () => { throw new Error("guest went away mid-gesture"); });
    const r = await zoomAtPointer(1);
    expect(r.what).toBe("app");
  });

  test("a zoomer that answers null also falls through", async () => {
    // `null` is how the panel says "no guest attached yet", which is a real
    // state during a tab's first 60ms.
    webviews = [{ rect: rect(0, 0, 1000, 1000) }];
    pointAt(500, 500);
    setPageZoomer(async () => null);
    expect((await zoomAtPointer(1)).what).toBe("app");
  });

  test("and reset reaches the page too", async () => {
    webviews = [{ rect: rect(0, 0, 1000, 1000) }];
    pointAt(500, 500);
    const asked: (number | null)[] = [];
    setPageZoomer(async (dir) => { asked.push(dir); return { factor: 1, percent: 100, pane: { width: 1, height: 1 } }; });
    const r = await zoomAtPointer(0);
    expect(asked[0], "Ctrl+0 on a page is the page's own 100%").toBe(0);
    expect(r.label).toBe("Page 100%");
  });
});

describe("overTerminal still answers by hit test", () => {
  test("because a terminal's DOM is this document's", () => {
    atPoint = { tag: "DIV", xterm: true };
    pointAt(10, 10);
    expect(overTerminal()).toBe(true);
  });
});
