/*
 * The launch cover (web/index.html, lib/cover.ts, lib/coverStep.ts): when it
 * comes down, what it says while it waits, the curve the mark flies on, the
 * boot script that paints its first frame in the right theme, and the orbit it
 * shares with the title bar's mark.
 *
 * The boot script is run for real, in a function with a stub page around it —
 * it is the one piece of this that runs before any module exists, so it cannot
 * be imported, and "the first frame is in the user's theme" is a claim about
 * what that script does with what it reads.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { COVER_CAP_MS, COVER_SETTLE_MS, coverLine, coverStep, shellSettled, springEasing, type CoverState } from "../src/lib/coverStep.ts";
import { BOOT_PAINT_KEY, bgIsDark, type BootPaint } from "../src/lib/bootPaint.ts";
import { SPLASH_KEY, setSplashOn, splashOn } from "../src/lib/splashPref.ts";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const HTML = src("../index.html");

const state = (o: Partial<CoverState> = {}): CoverState =>
  ({ mounted: true, holds: new Map(), changedAt: 0, failure: null, ...o });

describe("when the cover comes down", () => {
  test("not before React has mounted", () => {
    expect(coverStep(state({ mounted: false }), 5000).kind).toBe("wait");
  });

  test("not while a panel on screen still holds it", () => {
    const s = coverStep(state({ holds: new Map([["terminal", 1]]) }), 5000);
    expect(s).toEqual({ kind: "wait", recheckIn: COVER_CAP_MS - 5000 });
  });

  test("once nothing has held it for the settle, and not a millisecond before", () => {
    const t = 2000;
    expect(coverStep(state({ changedAt: t }), t + COVER_SETTLE_MS - 1)).toEqual({ kind: "wait", recheckIn: 1 });
    expect(coverStep(state({ changedAt: t }), t + COVER_SETTLE_MS)).toEqual({ kind: "go", why: "ready" });
  });

  test("a hold that lets go as another takes over does not open a gap", () => {
    // The terminal's checkout is known (one hold released) and the shell it
    // opens holds next: every change restarts the quiet period.
    const released = 3000;
    expect(coverStep(state({ changedAt: released }), released + 40).kind).toBe("wait");
    expect(coverStep(state({ changedAt: released + 40, holds: new Map([["terminal", 1]]) }), released + 200).kind).toBe("wait");
  });

  test("never past the cap, whatever still holds it", () => {
    expect(coverStep(state({ holds: new Map([["git", 2]]) }), COVER_CAP_MS)).toEqual({ kind: "go", why: "cap" });
  });

  test("at the cap, an app that never mounted is a failure, not an empty window revealed", () => {
    const s = coverStep(state({ mounted: false }), COVER_CAP_MS + 1);
    expect(s.kind).toBe("fail");
    if (s.kind === "fail") {
      expect(s.failure.title).toBe("The interface did not load");
      expect(s.failure.canContinue).toBe(false);
    }
  });

  test("the recheck never sleeps past the cap", () => {
    const s = coverStep(state({ changedAt: COVER_CAP_MS - 40 }), COVER_CAP_MS - 30);
    expect(s).toEqual({ kind: "wait", recheckIn: 30 });
  });

  test("a failure is said at once — before the mount, before the cap, over every hold", () => {
    const failure = { title: "The server did not start", detail: "the port is taken", canContinue: true };
    const s = coverStep(state({ mounted: false, holds: new Map([["project", 1]]), failure }), 100);
    expect(s).toEqual({ kind: "fail", failure });
  });

  test("the cap is a real cap: seconds, not minutes, and past the sidecar's measured worst", () => {
    expect(COVER_CAP_MS).toBeGreaterThanOrEqual(12_000);
    expect(COVER_CAP_MS).toBeLessThanOrEqual(20_000);
    // The boot script's own last word comes after it, never before.
    const last = HTML.match(/Nothing had drawn after (\d+) seconds/);
    expect(last).not.toBeNull();
    expect(Number(last![1]) * 1000).toBeGreaterThan(COVER_CAP_MS);
  });
});

describe("what the status line says while it waits", () => {
  test("names the panel that has been loading longest", () => {
    expect(coverLine(new Map([["terminal", 1], ["git", 1]]))).toBe("opening the terminal…");
    expect(coverLine(new Map([["git", 1]]))).toBe("reading the working tree…");
  });
  test("still says something for a hold it has no words for", () => {
    expect(coverLine(new Map([["somebody-new", 1]]))).toBe("loading…");
  });
  test("with nothing held, it is the interface itself", () => {
    expect(coverLine(new Map())).toBe("loading the interface…");
  });
});

describe("when a shell on screen has said its piece", () => {
  test("drawn (and its tmux strip in) is settled; still starting is not", () => {
    expect(shellSettled({ settled: true, status: "live" }, false)).toBe(true);
    for (const status of ["idle", "connecting", "live"]) expect(shellSettled({ status }, true)).toBe(false);
  });
  test("an ended shell has said it, in the terminal itself", () => {
    expect(shellSettled({ status: "exited" }, false)).toBe(true);
    expect(shellSettled({ status: "unauthorized" }, false)).toBe(true);
  });
  test("a refusal is an answer only when it is final — no shell, or a server the shell gave up on", () => {
    expect(shellSettled({ status: "error" }, false)).toBe(false);
    expect(shellSettled({ status: "error" }, true)).toBe(true);
  });
});

describe("the flight's curve", () => {
  const stops = (e: string) => e.slice("linear(".length, -1).split(", ").map((s) => Number(s.split(" ")[0]));

  test("starts at rest at 0, lands exactly on 1, and never overshoots or goes back", () => {
    const v = stops(springEasing(0.5, 0.68));
    expect(v[0]).toBe(0);
    expect(v[v.length - 1]).toBe(1);
    for (let i = 1; i < v.length; i++) {
      expect(v[i]).toBeGreaterThanOrEqual(v[i - 1]);
      expect(v[i]).toBeLessThanOrEqual(1);
    }
    // At rest at the start: the first step is a small one.
    expect(v[1]).toBeLessThan(0.05);
  });

  test("a snappier spring gets further in the same time — the vertical one leads", () => {
    const x = stops(springEasing(0.5, 0.68)), y = stops(springEasing(0.42, 0.68));
    expect(y[8]).toBeGreaterThan(x[8]);
  });
});

/** A Map standing in for localStorage, installed for one describe at a time. */
function memoryStorage(store: Map<string, string>) {
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
}

describe("the launch animation setting", () => {
  const real = globalThis.localStorage;
  const store = new Map<string, string>();
  beforeAll(() => { (globalThis as any).localStorage = memoryStorage(store); });
  afterAll(() => { (globalThis as any).localStorage = real; });

  test("is on until it is turned off, and off is the only word for off", () => {
    store.clear();
    expect(splashOn()).toBe(true);
    setSplashOn(false);
    expect(store.get(SPLASH_KEY)).toBe("off");
    expect(splashOn()).toBe(false);
    setSplashOn(true);
    expect(store.has(SPLASH_KEY)).toBe(false);
    store.set(SPLASH_KEY, "yes please");
    expect(splashOn()).toBe(true);
  });
});

// ── the boot script ─────────────────────────────────────────────────────────
const BOOT = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

/** A node with just what the boot script touches. */
interface Stub {
  hidden: boolean; textContent: string; onclick: null | (() => void); focused: boolean; firstElementChild: unknown;
  attrs: Map<string, string>; kids: Map<string, Stub>; gone: boolean;
  classList: { add(c: string): void; contains(c: string): boolean; remove(c: string): void };
  querySelector(s: string): Stub | null;
  setAttribute(k: string, v: string): void;
  focus(): void;
  parentNode: null | { removeChild: (c: unknown) => void };
}
function node(): Stub {
  const kids = new Map<string, Stub>();
  return {
    hidden: false, textContent: "", onclick: null, focused: false, firstElementChild: null,
    attrs: new Map<string, string>(), kids, gone: false,
    classList: { add() {}, contains() { return false; }, remove() {} },
    querySelector: (s: string) => kids.get(s) ?? null,
    setAttribute(k: string, v: string) { this.attrs.set(k, v); },
    focus() { this.focused = true; },
    parentNode: null,
  };
}

/** Run the page's inline script against a stub page. What it schedules and
 *  listens for is kept, not run, so a test can run it when it chooses. */
function boot(store: Record<string, string>, { osDark = true, storageThrows = false } = {}) {
  const props = new Map<string, string>();
  const classes = new Set<string>();
  const attrs = new Map<string, string>();
  const meta = { content: "#17181b", setAttribute(k: string, v: string) { if (k === "content") this.content = v; } };
  const root = {
    style: { setProperty: (k: string, v: string) => void props.set(k, v) },
    classList: { add: (c: string) => void classes.add(c), contains: (c: string) => classes.has(c), remove: (c: string) => void classes.delete(c) },
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
  };
  // The cover and its card, the app's #root.
  const cover = node(), card = node(), app = node(), reload = node();
  card.hidden = true;
  for (const k of [".agc-err-title", ".agc-err-detail"]) card.kids.set(k, node());
  card.kids.set('[data-act="reload"]', reload);
  cover.kids.set(".agc-error", card);
  const coverClasses = new Set<string>();
  cover.classList = { add: (c: string) => void coverClasses.add(c), contains: (c: string) => coverClasses.has(c), remove: (c: string) => void coverClasses.delete(c) };
  cover.parentNode = { removeChild: () => { cover.gone = true; } };
  const page = {
    documentElement: root, readyState: "loading",
    getElementById: (id: string) => (id === "ag-cover" ? cover : id === "root" ? app : null),
    querySelector: (s: string) => (s.includes("theme-color") ? meta : null),
  };
  const timers: { fn: () => void; ms: number }[] = [];
  const listeners: { type: string; fn: (e: unknown) => void }[] = [];
  const storage = { getItem: (k: string) => { if (storageThrows) throw new Error("denied"); return store[k] ?? null; } };
  let reloaded = false;
  const run = new Function("document", "localStorage", "matchMedia", "addEventListener", "setTimeout", "location", "window", "fetch", BOOT[0]);
  run(page, storage, (q: string) => ({ matches: q.includes("dark") ? osDark : false }),
    (type: string, fn: (e: unknown) => void) => void listeners.push({ type, fn }),
    (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
    { origin: "http://127.0.0.1:4000", reload() { reloaded = true; } }, {}, () => new Promise(() => {}));
  return { props, classes, attrs, meta, timers, listeners, cover, coverClasses, card, app, reload, reloaded: () => reloaded };
}

describe("the boot script paints the first frame in the last theme", () => {
  test("is the page's one inline script, in <head>, ahead of every element it styles", () => {
    expect(BOOT).toHaveLength(1);
    const at = HTML.indexOf(BOOT[0]);
    expect(at).toBeLessThan(HTML.indexOf("</head>"));
    expect(at).toBeLessThan(HTML.indexOf('<div id="ag-cover">'));
  });

  test("reads the keys the app writes", () => {
    expect(BOOT[0]).toContain(`"${BOOT_PAINT_KEY}"`);
    expect(BOOT[0]).toContain(`"${SPLASH_KEY}"`);
  });

  test("with nothing saved it covers in the default palette and changes nothing", () => {
    const r = boot({});
    expect(r.props.size).toBe(0);
    expect([...r.classes]).toEqual(["ag-covering"]);
    expect(r.meta.content).toBe("#17181b");
  });

  test("puts the saved palette on the root before anything is drawn", () => {
    const paint: BootPaint = { v: 1, id: "porcelain", dark: false, vars: { "--bg": "#ffffff", "--primary": "#171717", "--success": "#15803d" } };
    const r = boot({ [BOOT_PAINT_KEY]: JSON.stringify(paint) });
    expect(Object.fromEntries(r.props)).toEqual(paint.vars);
    expect(r.attrs.get("data-theme")).toBe("porcelain");
    expect(r.classes.has("agc-light")).toBe(true);
    expect(r.meta.content).toBe("#ffffff"); // a phone's status bar, in the same colour
  });

  test("a system choice asks the OS which of its two answers is current", () => {
    const entry = (id: string, bg: string, dark: boolean) => ({ id, dark, vars: { "--bg": bg } });
    const paint: BootPaint = { v: 1, ...entry("graphite", "#1e1e1e", true), system: { dark: entry("graphite", "#1e1e1e", true), light: entry("porcelain", "#ffffff", false) } };
    const store = { [BOOT_PAINT_KEY]: JSON.stringify(paint) };
    expect(boot(store, { osDark: true }).props.get("--bg")).toBe("#1e1e1e");
    const light = boot(store, { osDark: false });
    expect(light.props.get("--bg")).toBe("#ffffff");
    expect(light.attrs.get("data-theme")).toBe("porcelain");
  });

  test("takes only custom properties with plain values", () => {
    const paint = { v: 1, id: "x", dark: true, vars: { "--bg": "#101010", "--x": "red;} body{display:none", "color": "red", "--y": "<b>", "--ok": "rgba(1, 2, 3, .4)" } };
    const r = boot({ [BOOT_PAINT_KEY]: JSON.stringify(paint) });
    expect(Object.fromEntries(r.props)).toEqual({ "--bg": "#101010", "--ok": "rgba(1, 2, 3, .4)" });
  });

  test("a broken copy, a wrong version or no storage at all still covers", () => {
    for (const store of [{ [BOOT_PAINT_KEY]: "{not json" }, { [BOOT_PAINT_KEY]: JSON.stringify({ v: 2, vars: { "--bg": "#000" } }) }]) {
      const r = boot(store);
      expect(r.props.size).toBe(0);
      expect(r.classes.has("ag-covering")).toBe(true);
    }
    expect(boot({}, { storageThrows: true }).classes.has("ag-covering")).toBe(true);
  });

  test("switched off in Settings, it is the plain boot screen", () => {
    const r = boot({ [SPLASH_KEY]: "off" });
    expect(r.classes.has("ag-covering")).toBe(true);
    expect(r.classes.has("agc-off")).toBe(true);
  });
});

describe("the boot script's last word, when the bundle never draws", () => {
  const watchdog = (r: ReturnType<typeof boot>) => {
    const t = r.timers.find((x) => x.ms === 20000);
    expect(t, "a 20 s watchdog").toBeDefined();
    t!.fn();
  };

  test("nothing drawn in twenty seconds is said as a failure, with Reload focused and the app inert", () => {
    const r = boot({});
    watchdog(r);
    expect(r.coverClasses.has("agc-failed")).toBe(true);
    expect(r.card.hidden).toBe(false);
    expect(r.card.kids.get(".agc-err-detail")!.textContent).toBe("Nothing had drawn after 20 seconds.");
    expect(r.reload.focused).toBe(true);
    expect(r.app.attrs.has("inert")).toBe(true);
    r.reload.onclick!();
    expect(r.reloaded()).toBe(true);
  });

  test("an app that drew is never left behind a cover nobody took down", () => {
    const r = boot({});
    r.app.firstElementChild = {};
    watchdog(r);
    expect(r.cover.gone).toBe(true);
    expect(r.classes.has("ag-covering")).toBe(false);
    expect(r.card.hidden).toBe(true);
  });

  test("a bundle that cannot be fetched is said at once", () => {
    const r = boot({});
    const onError = r.listeners.find((l) => l.type === "error")!;
    onError.fn({ target: { tagName: "SCRIPT", src: "agentglass://app/assets/index-x.js" } });
    expect(r.card.hidden).toBe(false);
    expect(r.card.kids.get(".agc-err-detail")!.textContent).toContain("assets/index-x.js");
  });

  test("an error thrown before anything drew is said after a grace, and not at all if the app then drew", () => {
    const r = boot({});
    const onError = r.listeners.find((l) => l.type === "error")!;
    const win = {} as unknown;
    onError.fn({ target: win, message: "boom" });
    // The script compares against its own `window`: a target that is neither a
    // script nor the page is a picture or a sheet, which is not the end of it.
    expect(r.card.hidden).toBe(true);
    const r2 = boot({});
    r2.listeners.find((l) => l.type === "error")!.fn({ target: undefined, message: "boom" });
    const grace = r2.timers.find((x) => x.ms === 1500)!;
    r2.app.firstElementChild = {};
    grace.fn();
    expect(r2.card.hidden).toBe(true);
    const r3 = boot({});
    r3.listeners.find((l) => l.type === "error")!.fn({ target: undefined, error: new Error("boom") });
    r3.timers.find((x) => x.ms === 1500)!.fn();
    expect(r3.card.hidden).toBe(false);
    expect(r3.card.kids.get(".agc-err-detail")!.textContent).toBe("boom");
  });
});

describe("what applyTheme leaves for it", () => {
  // themes.ts → api.ts reads `location` at module scope. Set only if absent:
  // other files lean on the same stub, and taking it away would break them.
  if (!(globalThis as any).location) (globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };
  const store = new Map<string, string>();
  const style = new Map<string, string>();
  let told: string[] = [];
  const saved: Record<string, unknown> = {};
  const stubs: Record<string, unknown> = {
    localStorage: memoryStorage(store),
    document: {
      documentElement: {
        style: { setProperty: (k: string, v: string) => void style.set(k, v), getPropertyValue: (k: string) => style.get(k) ?? "" },
        setAttribute: () => {},
      },
    },
    getComputedStyle: () => ({ getPropertyValue: (k: string) => style.get(k) ?? "" }),
    window: { agentglass: { setWindowBackground: (c: string) => { told.push(c); } } },
  };
  beforeAll(() => { for (const [k, v] of Object.entries(stubs)) { saved[k] = (globalThis as any)[k]; (globalThis as any)[k] = v; } });
  afterAll(() => { for (const [k, v] of Object.entries(saved)) (globalThis as any)[k] = v; });

  test("a listed theme round-trips: what the boot script puts back is what was painted", async () => {
    const { applyTheme } = await import("../src/lib/themes.ts");
    store.clear(); style.clear(); told = [];
    applyTheme("porcelain");
    const saved = JSON.parse(store.get(BOOT_PAINT_KEY)!) as BootPaint;
    expect(saved.id).toBe("porcelain");
    expect(saved.dark).toBe(false);
    expect(saved.system).toBeUndefined();
    const back = boot(Object.fromEntries(store));
    for (const [k, v] of style) expect(back.props.get(k), k).toBe(v);
    expect(back.attrs.get("data-theme")).toBe("porcelain");
    // And the desktop shell heard the background it will open the next window on.
    expect(told).toEqual([style.get("--bg")!]);
  });

  test("in system mode both answers are left, each with its own background", async () => {
    const { applyTheme, SERIOUS_DARK, SERIOUS_LIGHT, THEMES } = await import("../src/lib/themes.ts");
    store.clear(); style.clear();
    store.set("agentglass-theme-mode", "system");
    applyTheme(SERIOUS_DARK);
    const saved = JSON.parse(store.get(BOOT_PAINT_KEY)!) as BootPaint;
    const bg = (id: string) => THEMES.find((t) => t.id === id)!.vars["--bg"];
    expect(saved.system?.dark.vars["--bg"]).toBe(bg(SERIOUS_DARK));
    expect(saved.system?.light.vars["--bg"]).toBe(bg(SERIOUS_LIGHT));
    expect(saved.system?.light.dark).toBe(false);
    expect(boot(Object.fromEntries(store), { osDark: false }).props.get("--bg")).toBe(bg(SERIOUS_LIGHT));
  });

  test("an accent laid over the theme is in the copy too", async () => {
    const { applyTheme } = await import("../src/lib/themes.ts");
    const { ACCENTS } = await import("../src/lib/accent.ts");
    const teal = ACCENTS.find((a) => a.id === "teal")!;
    store.clear(); style.clear();
    store.set("agentglass-accent", "teal");
    applyTheme("porcelain");
    const saved = JSON.parse(store.get(BOOT_PAINT_KEY)!) as BootPaint;
    expect(saved.vars["--primary"]).toBe(teal.primary);
    expect(saved.vars["--theme-primary"]).not.toBe(teal.primary);
  });

  test("dark and light are read off the background", () => {
    expect(bgIsDark("#0d1117")).toBe(true);
    expect(bgIsDark("#ffffff")).toBe(false);
    expect(bgIsDark("#fff")).toBe(false);
    expect(bgIsDark(undefined)).toBe(true);
  });
});

// ── the orbit ───────────────────────────────────────────────────────────────
/**
 * The landing moves the contact with SMIL along "M49.9 9.1 A29 8 -52 0 1 14.1
 * 54.9 A29 8 -52 0 1 49.9 9.1" at constant speed (paced). The app's copy is a
 * turning arm in a squashed, tilted plane; these check it draws the same path
 * at the same pace, from the keyframes actually in the page.
 */
describe("the living mark rides the landing's orbit", () => {
  const frames = (name: string) => {
    const body = HTML.match(new RegExp(`@keyframes ${name}\\{((?:[^{}]*\\{[^{}]*\\})+)\\}`));
    expect(body, name).not.toBeNull();
    return [...body![1].matchAll(/([\d.]+)%\{transform:([^}]*)\}/g)].map((m) => ({ at: Number(m[1]) / 100, t: m[2] }));
  };
  const deg = (s: string) => Number(s.match(/rotate\((-?[\d.]+)deg\)/)![1]);
  const RX = 29, RY = 8, TILT = -52, C = 32;
  // The plane is rotate(TILT) scaleY(RY/RX); the arm turns a point at (RX, 0).
  const at = (theta: number) => {
    const t = (theta * Math.PI) / 180, r = (TILT * Math.PI) / 180;
    const x = RX * Math.cos(t), y = RY * Math.sin(t);
    return [C + x * Math.cos(r) - y * Math.sin(r), C + x * Math.sin(r) + y * Math.cos(r)];
  };
  const arm = frames("ag-lm-arm");

  test("one full turn, starting and ending where the landing's path does", () => {
    expect(arm[0]).toEqual({ at: 0, t: "rotate(0deg)" });
    expect(arm[arm.length - 1]).toEqual({ at: 1, t: "rotate(360deg)" });
    const [x0, y0] = at(0), [x1, y1] = at(180);
    expect(Math.hypot(x0 - 49.9, y0 - 9.1)).toBeLessThan(0.1);
    expect(Math.hypot(x1 - 14.1, y1 - 54.9)).toBeLessThan(0.1);
  });

  test("the front half takes exactly half the time, as the SMIL copies swap at .5", () => {
    expect(arm.find((f) => deg(f.t) === 180)?.at).toBe(0.5);
    expect(HTML).toContain("@keyframes ag-lm-f{0%{opacity:1}50%,100%{opacity:0}}");
    expect(HTML).toContain("@keyframes ag-lm-b{0%{opacity:0}50%,100%{opacity:1}}");
  });

  test("paced: the contact covers the same distance in the same time all the way round", () => {
    const speeds: number[] = [];
    for (let i = 1; i < arm.length; i++) {
      const [ax, ay] = at(deg(arm[i - 1].t)), [bx, by] = at(deg(arm[i].t));
      speeds.push(Math.hypot(bx - ax, by - ay) / (arm[i].at - arm[i - 1].at));
    }
    const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    for (const s of speeds) expect(Math.abs(s - mean) / mean).toBeLessThan(0.05);
  });

  test("the contact counter-turns and stays round at every stop", () => {
    const dot = frames("ag-lm-dot");
    expect(dot).toHaveLength(arm.length);
    type M = [number, number, number, number];
    const mul = (a: M, b: M): M => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3]];
    const rot = (d: number): M => { const r = (d * Math.PI) / 180; return [Math.cos(r), -Math.sin(r), Math.sin(r), Math.cos(r)]; };
    const sy = (k: number): M => [1, 0, 0, k];
    for (let i = 0; i < dot.length; i++) {
      const [d1, k, d2] = [...dot[i].t.matchAll(/(?:rotate|scaleY)\((-?[\d.]+)/g)].map((m) => Number(m[1]));
      const whole = mul(mul(mul(rot(TILT), sy(RY / RX)), rot(deg(arm[i].t))), mul(mul(rot(d1), sy(k)), rot(d2)));
      expect(whole[0]).toBeCloseTo(1, 3); expect(whole[1]).toBeCloseTo(0, 3);
      expect(whole[2]).toBeCloseTo(0, 3); expect(whole[3]).toBeCloseTo(1, 3);
    }
  });
});

describe("one mark lands, and it is the title bar's", () => {
  test("TopBar draws the living mark as the cover's target, and nothing else claims to be one", () => {
    const top = src("../src/components/TopBar.tsx");
    expect(top).toMatch(/<LivingMark[^>]*\bcoverTarget\b/);
    const all = ["../src/App.tsx", "../src/components/TopBar.tsx", "../src/components/Logo.tsx"].map(src).join("\n");
    expect(all.match(/<LivingMark[^>]*\bcoverTarget\b/g)).toHaveLength(1);
  });

  test("the shell says whether it is the app's own tmux, and the desk waits for its strip only then", () => {
    const server = src("../../server/src/terminal.ts");
    const ready = server.slice(server.indexOf('t: "ready", mode'), server.indexOf("});", server.indexOf('t: "ready", mode')));
    expect(ready).toContain("engine: !!engine");
    expect(src("../src/components/TerminalPanel.tsx")).toContain("s.tmuxDue = f.engine === true");
  });

  test("and on the app's own tmux the strip is swept from the first redraw, not the next poll", () => {
    const server = src("../../server/src/terminal.ts");
    const at = server.indexOf("const nudgeTmux = () => {");
    expect(at).toBeGreaterThan(0);
    const body = server.slice(at, server.indexOf("\n  };\n", at));
    const code = body.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(code).toContain("(!session.tmux && !session.onEngine) || session.closed");
  });
});

describe("the window's own ground (electron/main.js)", () => {
  const main = src("../../electron/main.js");
  const body = main.slice(main.indexOf("function windowBackground(c) {"), main.indexOf("\n}\n", main.indexOf("function windowBackground(c) {")) + 2);
  const windowBackground = new Function(`${body}; return windowBackground;`)() as (c: unknown) => string | null;

  test("takes a plain #rrggbb, lowercased, and nothing else", () => {
    expect(windowBackground("#0D1117")).toBe("#0d1117");
    for (const bad of ["#fff", "red", "#12345g", "#0d1117ff", "url(x)", "", null, 42, { toString: () => "#000000" }]) {
      expect(windowBackground(bad), String(bad)).toBeNull();
    }
  });

  test("opens the next window on it, and in system mode on the ground the OS is in", () => {
    const create = main.slice(main.indexOf("function createWindow() {"), main.indexOf("new BrowserWindow({", main.indexOf("function createWindow() {")));
    expect(create).toContain("nativeTheme.shouldUseDarkColors ? st.bgSystem.dark : st.bgSystem.light");
    expect(main).toMatch(/backgroundColor: ground \|\| "#0d1117"/);
  });
});
