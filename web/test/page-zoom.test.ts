/*
 * Ctrl+ over a web page zooms the PAGE, and it zooms it by the right amount.
 *
 * Two bugs, one gesture, both measured on the running app before any of this
 * was written.
 *
 * ONE — the gesture never reached the page. `zoomTarget` had two answers, a
 * terminal and the window, and a web page fell into "the window". Pointer over
 * the page, Ctrl+ twice:
 *
 *     window devicePixelRatio   1.25  ->  1.5625      the whole app grew
 *     page innerWidth           2790  ->  2790        the page, untouched
 *
 * That is "the zoom I see is the whole app's, not the page's", and no
 * work inside the panel could have fixed it: the panel was never asked.
 *
 * TWO — the mechanism zoomed the wrong way. The override's `width` is taken
 * literally, which was measured by asking:
 *
 *     asked width=2000 dsf=1     ->  innerWidth 2000  dpr 1.0
 *     asked width=2325 dsf=1.2   ->  innerWidth 2326  dpr 1.2
 *     asked width=2325 dsf=1.5   ->  innerWidth 2326  dpr 1.5
 *
 * The old formula asked for `natW * dpr / factor`, believing the number was in
 * embedder pixels and would be divided again. On his window at 125%, zooming
 * IN by 1.2 laid the page out at 2790 * 1.25 / 1.2 = 2906 CSS pixels — wider
 * than it started, so asking for bigger made it smaller. The agent's `zoom`
 * verb had the same defect and confessed it, because it reads back from the
 * page rather than reporting its argument: asked 1.2, answered 0.96.
 *
 * After: verb asked 1.2 answers 1.199; the person's gesture leaves the window
 * at 1.25 and takes the page 2790 -> 2326 at dpr 1.5.
 *
 * These bite by EFFECT — what was asked of the protocol, and what the caller is
 * told — not by the shape of the code.
 */
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { readFileSync } from "node:fs";

/* Restored on the way out: one process runs every file, so a stub left behind
   is a stub the next file inherits. */
const priorStorage = (globalThis as any).localStorage;
afterAll(() => { (globalThis as any).localStorage = priorStorage; });

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};

const { applyGuestZoom, setPageZoomer, currentPageZoomer } = await import("../src/lib/browserDrive.ts");

/** A guest whose page answers honestly: `innerWidth` is whatever the last
 *  override asked for, which is what the real one was measured to do. */
function fakeGuest(naturalWidth: number, naturalHeight: number, naturalDpr: number) {
  const asked: Array<{ method: string; params: any }> = [];
  let w = naturalWidth, h = naturalHeight, dpr = naturalDpr;
  const cdp = async (method: string, params?: unknown) => {
    asked.push({ method, params });
    if (method === "Emulation.clearDeviceMetricsOverride") { w = naturalWidth; h = naturalHeight; dpr = naturalDpr; }
    if (method === "Emulation.setDeviceMetricsOverride") {
      const p = params as { width: number; height: number; deviceScaleFactor: number };
      w = p.width; h = p.height; dpr = p.deviceScaleFactor;
    }
    return { ok: true };
  };
  const el = {
    executeJavaScript: async (_code: string) => JSON.stringify({ w, h, dpr }),
  };
  return { el, cdp, asked, override: () => asked.filter((a) => a.method === "Emulation.setDeviceMetricsOverride").at(-1)?.params };
}

describe("zooming a guest", () => {
  test("lays the page out at natural / factor", () => {
    // The whole of bug TWO in one assertion. The old formula asked 2906 here.
    const g = fakeGuest(2790, 1698, 1.25);
    return applyGuestZoom(g.el, 1.2, g.cdp).then(() => {
      expect(g.override().width).toBe(2325);
      expect(g.override().height).toBe(1415);
    });
  });

  test("and keeps it as sharp as the window around it", () => {
    // natDpr x factor, not factor: at 1.2 alone the page draws at 1.2 device
    // pixels per CSS pixel inside a window at 1.25, and looks it.
    const g = fakeGuest(2790, 1698, 1.25);
    return applyGuestZoom(g.el, 1.2, g.cdp).then(() => {
      expect(g.override().deviceScaleFactor).toBe(1.5);
    });
  });

  test("measures the natural size with the override CLEARED", () => {
    // Otherwise a second zoom measures its own previous answer, which is the
    // bug the verb had in its first form.
    const g = fakeGuest(2790, 1698, 1.25);
    return applyGuestZoom(g.el, 1.2, g.cdp)
      .then(() => applyGuestZoom(g.el, 1.2, g.cdp))
      .then(() => {
        expect(g.override().width, "the second zoom is still 2790/1.2").toBe(2325);
        expect(g.asked[0]!.method).toBe("Emulation.clearDeviceMetricsOverride");
      });
  });

  test("reports what the page ended up at, not what it was asked for", async () => {
    const g = fakeGuest(2790, 1698, 1.25);
    const r = await applyGuestZoom(g.el, 1.2, g.cdp);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.percent).toBe(120);
    expect(r.value.pane).toEqual({ width: 2790, height: 1698 });
  });

  test("a factor of 1 clears the override and asks for nothing else", async () => {
    const g = fakeGuest(2790, 1698, 1.25);
    const r = await applyGuestZoom(g.el, 1, g.cdp);
    expect(g.override(), "no override at all").toBeUndefined();
    expect(r.ok && r.value.percent).toBe(100);
  });

  test("and a factor outside the range is refused before anything is touched", async () => {
    const g = fakeGuest(2790, 1698, 1.25);
    for (const bad of [0, 0.05, 6, -1]) {
      const r = await applyGuestZoom(g.el, bad, g.cdp);
      expect(r.ok, `factor ${bad}`).toBe(false);
    }
    expect(g.asked.length, "the protocol was never called").toBe(0);
  });

  test("a relay that cannot clear says so rather than zooming blind", async () => {
    const g = fakeGuest(2790, 1698, 1.25);
    const dead = async () => ({ ok: false, error: "no DevTools relay" });
    const r = await applyGuestZoom(g.el, 1.2, dead);
    expect(r.ok).toBe(false);
  });
});

describe("who gets the person's zoom keys", () => {
  beforeEach(() => setPageZoomer(null));

  test("nobody, until a panel registers", () => {
    expect(currentPageZoomer()).toBeNull();
  });

  test("and nobody again once it unmounts", () => {
    setPageZoomer(async () => ({ factor: 1.2, percent: 120, pane: { width: 1, height: 1 } }));
    expect(currentPageZoomer()).not.toBeNull();
    setPageZoomer(null);
    expect(currentPageZoomer(), "a guest that is gone must not be reachable").toBeNull();
  });
});

/*
 * The number on screen has to be one the scale can produce.
 *
 * Reported with a screenshot: the toast said `Page 524%`, and the ceiling of
 * this scale is 358% — `1.2 ** ZOOM_MAX` with `ZOOM_MAX = 7`. A percentage the
 * ladder cannot reach did not come from his presses; it came from the
 * measurement, and nothing between the measurement and the screen questioned
 * it. Closing and reopening the app cured it, which was the tell: `saveZoom`
 * has always clamped on write, so the impossible value only ever lived in
 * memory.
 *
 * Two causes, and the clamp is only the second one.
 *
 * ONE — NOTHING WAITED FOR THE LAYOUT. The override was requested and the page
 * read in the next statement, so the answer described the page as it was
 * BEFORE. The inflated factor became the level, the level fed the next press,
 * and it compounded. The fix waits two animation frames — the idiom for "style
 * and layout have run" — rather than sleeping a guessed number of milliseconds.
 *
 * TWO — A PANE WITH NO PAGE IN IT DIVIDES INTO ANYTHING. His browser panel was
 * empty in the screenshots ("Ctrl+T to start browsing"). A guest that is not
 * laid out has no width worth dividing, and the answer now says so instead of
 * inventing a ratio.
 *
 * These bite by EFFECT: what a caller is told, from a guest that behaves the
 * way the broken one did.
 */
describe("a measurement that cannot be true", () => {
  /** A guest whose reads lag one call behind — the race, made deterministic. */
  function staleGuest(naturalWidth: number) {
    let w = naturalWidth;
    let pending: number | null = null;
    const cdp = async (method: string, params?: unknown) => {
      /* The request is accepted, and the page has not relaid out yet. Whatever
         is read before the next frame still sees the OLD width. */
      if (method === "Emulation.clearDeviceMetricsOverride") pending = naturalWidth;
      if (method === "Emulation.setDeviceMetricsOverride") pending = (params as { width: number }).width;
      return { ok: true };
    };
    const el = {
      executeJavaScript: async (code: string) => {
        /* Only a read that waits for a frame sees the new width, which is what
           `requestAnimationFrame` in the snippet stands for here. */
        if (code.includes("requestAnimationFrame") && pending !== null) { w = pending; pending = null; }
        return JSON.stringify({ w, h: 1000, dpr: 1.25 });
      },
    };
    return { el, cdp };
  }

  test("the reading waits for the layout, so a zoom does not compound", async () => {
    const g = staleGuest(2790);
    const first = await applyGuestZoom(g.el, 1.2, g.cdp);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.percent, "120, not the previous width over the new one").toBe(120);

    /* The compounding: press again and the natural size must still be 2790.
       Without the wait, the second call measured 2325 as "natural" and the
       answer climbed — six presses of that is how 524% happens. */
    const second = await applyGuestZoom(g.el, 1.2, g.cdp);
    expect(second.ok && second.value.percent).toBe(120);
  });

  test("a pane with no page in it is refused, not divided", async () => {
    // The state his browser panel was in: attached, nothing loaded.
    const empty = {
      el: { executeJavaScript: async () => JSON.stringify({ w: 0, h: 0, dpr: 1 }) },
      cdp: async () => ({ ok: true }),
    };
    const r = await applyGuestZoom(empty.el, 1.2, empty.cdp);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("no page");
  });

  test("and a guest that is still attaching is refused too", async () => {
    // A webview reports a handful of pixels for a moment while it attaches.
    const attaching = {
      el: { executeJavaScript: async () => JSON.stringify({ w: 8, h: 8, dpr: 1 }) },
      cdp: async () => ({ ok: true }),
    };
    expect((await applyGuestZoom(attaching.el, 1.2, attaching.cdp)).ok).toBe(false);
  });

  test("a real pane is still measured, not refused", async () => {
    // The guard must not swallow the case it was built around: a genuine
    // disagreement between what was asked and what the page did.
    const g = fakeGuest(2790, 1698, 1.25);
    const r = await applyGuestZoom(g.el, 1.2, g.cdp);
    expect(r.ok && r.value.percent).toBe(120);
  });
});

describe("what reaches the chip", () => {
  const SRC = readFileSync(new URL("../src/components/BrowserPanel.tsx", import.meta.url), "utf8");
  const bare = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("is clamped to the scale before it is shown, not only before it is stored", () => {
    /* `saveZoom` clamping on write is what made this survivable — and what made
       it look like a mystery, because a restart fixed it. The chip and the
       toast read the state, and the state was whatever was measured. */
    expect(bare).toMatch(/const shown = Math\.max\(ZOOM_MIN, Math\.min\(ZOOM_MAX,/);
  });

  test("and the level still comes from the page, not from the argument", () => {
    // The clamp must not turn into "report what was asked". A wrong formula
    // once answered 1.2 while the page sat at 0.96, and that has to stay
    // visible — it is inside the scale, so the clamp never touches it.
    expect(bare).toContain("Math.log(r.value.factor)");
  });
});
