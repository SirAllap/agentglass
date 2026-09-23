/**
 * What a first launch wears, and what a later one keeps.
 *
 * A fresh install opened on GitHub Dark: nothing stored fell through to a fixed
 * default, the boot paint wrote it back as though it had been picked, and from
 * then on every launch read as a deliberate choice — so on a desktop that
 * publishes its palette the desktop's mode was never adopted either. A first
 * run follows the machine: the desktop's palette where there is one, otherwise
 * the OS's dark or light. Anything chosen is kept.
 *
 * Each case loads its own copy of themes.ts, because the first-run test is
 * read once, when the module loads — the same moment it is read in the app.
 */
import { afterAll, describe, expect, test } from "bun:test";

const g = globalThis as any;
const saved = { location: g.location, localStorage: g.localStorage, window: g.window, document: g.document, fetch: g.fetch, setInterval: g.setInterval, navigator: g.navigator, getComputedStyle: g.getComputedStyle };
afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; } });

g.location = { hostname: "localhost", origin: "http://localhost:4000" };
/* Not a WebDriver session, so a sync would really be sent — and seen below. */
g.navigator = { webdriver: false };

/* The shape the poll gets back from /desktop/palette on an Omarchy machine. */
const PALETTE = {
  stamp: "1700000000000:orbit-night", source: "omarchy", name: "Orbit Night",
  theme: { name: "Orbit Night", vars: { "--bg": "#1a1b26", "--text": "#c0caf5", "--primary": "#7aa2f7" } },
};

let copy = 0;
async function boot(stored: Record<string, string>, { dark = true, palette = null as typeof PALETTE | null, serverUp = true } = {}) {
  const store = new Map(Object.entries(stored));
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };
  const attrs = new Map<string, string>();
  const style = new Map<string, string>();
  g.document = { documentElement: {
    style: { setProperty: (k: string, v: string) => style.set(k, v), getPropertyValue: (k: string) => style.get(k) ?? "", removeProperty: (k: string) => style.delete(k) },
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    getAttribute: (k: string) => attrs.get(k) ?? null,
  } };
  g.getComputedStyle = () => ({ getPropertyValue: (k: string) => style.get(k) ?? "" });
  g.window = { matchMedia: () => ({ matches: dark, addEventListener() {} }), addEventListener() {} };
  const synced: string[] = [];
  g.fetch = async (url: string) => {
    if (String(url).endsWith("/theme/sync")) { synced.push(String(url)); return new Response("{}"); }
    if (!serverUp) throw new TypeError("connection refused");
    return new Response(JSON.stringify({ palette }), { status: 200 });
  };
  const m = await import(`../src/lib/themes.ts?first-run-${++copy}`);
  /* What main.tsx does, in its order. */
  m.applyTheme(m.initialTheme());
  const painted = () => attrs.get("data-theme");
  let poll: () => void = () => {};
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
  const afterFirstPoll = async () => {
    g.setInterval = (fn: () => void) => { poll = fn; return 0; };
    m.watchDesktopPalette();
    await settle();
    g.setInterval = saved.setInterval;
  };
  const nextPoll = async () => { poll(); await settle(); };
  const serverStarts = () => { serverUp = true; };
  return { m, store, painted, afterFirstPoll, nextPoll, serverStarts, synced };
}

describe("a first run", () => {
  test("never opens on GitHub Dark", async () => {
    const { painted } = await boot({});
    expect(painted()).not.toBe("github-dark");
  });

  test("on a dark OS wears Graphite, in System, and keeps following the OS", async () => {
    const { m, store, painted } = await boot({}, { dark: true });
    expect(painted()).toBe("graphite");
    expect(store.get("agentglass-theme-mode")).toBe("system");
    expect(m.themeMode()).toBe("system");
  });

  test("on a light OS wears Porcelain", async () => {
    const { painted } = await boot({}, { dark: false });
    expect(painted()).toBe("porcelain");
  });

  test("on Omarchy moves to the desktop's mode at the first answer", async () => {
    const { m, store, painted, afterFirstPoll } = await boot({}, { palette: PALETTE });
    await afterFirstPoll();
    expect(store.get("agentglass-theme-mode")).toBe("desktop");
    expect(m.themeMode()).toBe("desktop");
    expect(painted()).toBe("desktop");
    expect(m.desktopPaletteName()).toEqual({ source: "omarchy", name: "Orbit Night" });
  });

  /* The move is nobody's gesture, so it paints this window and tells no tmux
     or editor outside it — an isolated second copy of the app would otherwise
     repaint every nvim on the machine the first time it opened. */
  test("the move to the desktop's mode is painted, not sent out", async () => {
    const { store, painted, afterFirstPoll, synced } = await boot({}, { palette: PALETTE });
    await afterFirstPoll();
    await new Promise((r) => setTimeout(r, 0));
    expect(painted()).toBe("desktop");
    expect(synced).toEqual([]);
    /* …and counted as sent, so the next launch does not send it either. */
    expect(store.get("agentglass-desktop-synced")).toBe(PALETTE.stamp);
  });

  test("a server not up yet does not spend the move", async () => {
    const { m, store, afterFirstPoll, nextPoll, serverStarts } = await boot({}, { palette: PALETTE, serverUp: false });
    await afterFirstPoll();
    expect(m.themeMode()).toBe("system");
    expect(store.has("agentglass-desktop-mode-moved")).toBe(false);
    serverStarts();
    await nextPoll();
    expect(m.themeMode()).toBe("desktop");
  });

  test("the second launch is not a first run, and stays where the first one landed", async () => {
    const first = await boot({}, { dark: false });
    const second = await boot(Object.fromEntries(first.store), { dark: true });
    /* The OS turned dark in between: System follows it. */
    expect(second.painted()).toBe("graphite");
    expect(second.m.themeMode()).toBe("system");
  });
});

describe("a choice already made", () => {
  /* App calls initialTheme() on every render. When that call was also what
     turned a first run into System, the render after a grid pick put the mode
     back, and the pick was gone at the next launch. */
  test("a pick in the first session survives the next render and the next launch", async () => {
    const first = await boot({});
    first.m.chooseTheme("dracula");
    expect(first.m.initialTheme()).toBe("dracula");
    expect(first.m.themeMode()).toBe("custom");
    const next = await boot(Object.fromEntries(first.store));
    expect(next.painted()).toBe("dracula");
  });

  test("a pick from the command palette leaves System, as a grid pick does", async () => {
    const { m, store } = await boot({});
    expect(m.chooseTheme("tokyo-night")).toBe("custom");
    expect(store.has("agentglass-theme-mode")).toBe(false);
    expect(m.chooseTheme("porcelain")).toBe("light");
    expect(store.get("agentglass-theme-mode")).toBe("light");
  });

  test("a palette picked from the grid is kept, GitHub Dark included", async () => {
    const { painted, store } = await boot({ "agentglass-theme": "github-dark" });
    expect(painted()).toBe("github-dark");
    expect(store.has("agentglass-theme-mode")).toBe(false);
  });

  test("a grid pick is kept on Omarchy too — the desktop's mode is not forced on it", async () => {
    const { m, painted, afterFirstPoll } = await boot({ "agentglass-theme": "dracula" }, { palette: PALETTE });
    await afterFirstPoll();
    expect(m.themeMode()).toBe("custom");
    expect(painted()).toBe("dracula");
  });

  test("Light chosen on a dark OS stays Light, on Omarchy as well", async () => {
    const { m, painted, afterFirstPoll } = await boot(
      { "agentglass-theme-mode": "light", "agentglass-theme": "porcelain", "agentglass-desktop-mode-moved": "1" },
      { dark: true, palette: PALETTE },
    );
    await afterFirstPoll();
    expect(m.themeMode()).toBe("light");
    expect(painted()).toBe("porcelain");
  });

  test("System chosen on Omarchy after the move stays System", async () => {
    const { m, painted, afterFirstPoll } = await boot(
      { "agentglass-theme-mode": "system", "agentglass-theme": "graphite", "agentglass-desktop-mode-moved": "1" },
      { dark: true, palette: PALETTE },
    );
    await afterFirstPoll();
    expect(m.themeMode()).toBe("system");
    expect(painted()).toBe("graphite");
  });
});
