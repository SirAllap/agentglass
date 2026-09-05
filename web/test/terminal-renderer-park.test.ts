/*
 * A shell nobody is looking at gives its canvases back.
 *
 * The canvas renderer is what makes `│` between two tmux panes a line instead
 * of whatever the machine's fallback font has — see termRenderer.ts, which
 * measured 75 seams on the DOM renderer — so it is not optional. What was
 * optional is holding it for shells that are off screen.
 *
 * Measured directly, driving a real xterm in headless Chrome: loading the addon
 * creates exactly four canvases sized to the pane (3,276,800 device pixels =
 * 13.1 MB at 4 bytes each for a 1200×700 holder at 1×), and `dispose()` returns
 * all four to zero. On the display this was written for — a full-size pane at
 * 1.5× — that is ~44 MB per open shell, held whether or not it was visible.
 *
 * The delay before disposing is the part worth pinning. The panel MOVES a
 * holder between slots when the split changes, which unmounts and remounts it
 * inside the same frame; without the delay every layout change would rebuild
 * the texture atlas.
 */
import { afterAll, describe, expect, test } from "bun:test";

/*
 * TerminalPanel reaches for the browser at import time, so enough of one to
 * load the module — and NOT ONE FIELD MORE.
 *
 * `bun test` runs every file in one process, so a global set here is a global
 * every later suite inherits. That is not theoretical: a `document` stub with a
 * `createElement` that returns a plain object made the Docker panel's render
 * test fail, because `Portal` tests `typeof document === "undefined"` to decide
 * whether it has anywhere to draw, and a fake document says yes and then hands
 * React something that is not an element.
 *
 * So: only what is missing, and everything put back on the way out.
 */
const g = globalThis as Record<string, unknown>;
const saved = new Map<string, { had: boolean; was: unknown }>();
const swap = (name: string, value: unknown) => {
  if (!saved.has(name)) saved.set(name, { had: name in g, was: g[name] });
  g[name] = value;
};
afterAll(() => {
  for (const [name, { had, was }] of saved) { if (had) g[name] = was; else delete g[name]; }
});

const store = new Map<string, string>();
swap("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(), key: () => null, length: 0,
});
/* Asked for by name rather than sniffed off a fake user agent: `rendererPref`
   reads this key, and a test that depends on which platform string a runtime
   happens to report is a test that breaks on the next runtime. */
store.set("agentglass.term.webgl", "canvas");

const panel = await import("../src/components/TerminalPanel.tsx");
const { attachRenderer, parkRenderer, PARK_RENDERER_MS } = panel as unknown as {
  attachRenderer: (s: unknown) => void;
  parkRenderer: (s: unknown) => void;
  PARK_RENDERER_MS: number;
};

/** Just enough of a session for the two helpers: they touch `term.loadAddon`
 *  and the two fields they own. */
const fakeSess = () => {
  const loaded: unknown[] = [];
  return {
    loaded,
    s: {
      canvasAddon: null as { dispose: () => void } | null,
      parkTimer: null as ReturnType<typeof setTimeout> | null,
      term: { loadAddon: (a: unknown) => void loaded.push(a) },
    },
  };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the canvas renderer follows the shell on and off screen", () => {
  test("mounting loads it exactly once", () => {
    const { s, loaded } = fakeSess();
    attachRenderer(s);
    expect(s.canvasAddon).not.toBeNull();
    expect(loaded.length).toBe(1);
    // A second mount without a park in between must not stack a second one.
    attachRenderer(s);
    expect(loaded.length).toBe(1);
  });

  test("unmounting disposes it, and gives the canvases back", async () => {
    const { s } = fakeSess();
    attachRenderer(s);
    let disposed = 0;
    s.canvasAddon = { dispose: () => { disposed++; } };

    parkRenderer(s);
    // Not immediately: a pane being moved between slots unmounts and remounts
    // inside the same frame, and disposing there would thrash the atlas.
    expect(disposed).toBe(0);
    expect(s.canvasAddon).not.toBeNull();

    await sleep(PARK_RENDERER_MS + 150);
    expect(disposed).toBe(1);
    expect(s.canvasAddon).toBeNull();
  });

  test("coming straight back keeps the renderer it already had", async () => {
    const { s, loaded } = fakeSess();
    attachRenderer(s);
    let disposed = 0;
    s.canvasAddon = { dispose: () => { disposed++; } };

    parkRenderer(s);
    attachRenderer(s);      // the remount, within the same frame
    await sleep(PARK_RENDERER_MS + 150);

    expect(disposed).toBe(0);
    expect(s.parkTimer).toBeNull();
    expect(loaded.length).toBe(1); // and no second addon was built
  });

  test("a session that is never shown holds no renderer at all", async () => {
    // The point of the whole change: it is loaded on mount, not at creation.
    const src = await Bun.file(new URL("../src/components/TerminalPanel.tsx", import.meta.url)).text();
    const constructions = src.split("new CanvasAddon()").length - 1;
    expect(constructions).toBe(1);
    expect(src.slice(src.indexOf("export function attachRenderer"))).toContain("new CanvasAddon()");
  });
});
