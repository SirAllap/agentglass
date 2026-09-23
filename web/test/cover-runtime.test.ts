/*
 * The launch cover's runtime (lib/cover.ts) against a stub page: what takes
 * it down, what keeps it up, and what happens when the motion cannot run.
 *
 * cover.ts reads the page and the shell once, when it loads — as it must, it
 * runs before React — so every case imports its own copy (`?case=…`) after
 * building the page it should find. Nothing here has a real DOM: the stubs
 * carry exactly what cover.ts touches, and the assertions are on what it did
 * to them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

class FakeEl {
  hidden = false;
  textContent = "";
  style: Record<string, string> = {};
  attrs = new Map<string, string>();
  classes = new Set<string>();
  removed = false;
  animated: { frames: Keyframe[]; opts: KeyframeAnimationOptions }[] = [];
  focused = false;
  onclick: (() => void) | null = null;
  kids = new Map<string, FakeEl>();
  rect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  throwOnAnimate = false;
  classList = {
    add: (c: string) => void this.classes.add(c),
    remove: (c: string) => void this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
  };
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  removeAttribute(k: string) { this.attrs.delete(k); }
  querySelector(sel: string) { return this.kids.get(sel) ?? null; }
  querySelectorAll(_sel: string) { return [] as FakeEl[]; }
  getBoundingClientRect() { return this.rect; }
  getAnimations() { return []; }
  focus() { this.focused = true; }
  remove() { this.removed = true; }
  animate(frames: Keyframe[], opts: KeyframeAnimationOptions) {
    if (this.throwOnAnimate) throw new TypeError("'linear(...)' is not a valid value for easing");
    this.animated.push({ frames, opts });
    return { finished: Promise.resolve(), cancel() {}, commitStyles() {} };
  }
}
const box = (x: number, y: number, w: number): FakeEl["rect"] => ({ left: x, top: y, width: w, height: w, right: x + w, bottom: y + w });

interface Page {
  root: FakeEl; cover: FakeEl; app: FakeEl; msg: FakeEl; target: FakeEl | null; card: FakeEl;
  go: FakeEl; again: FakeEl; mark: FakeEl; reloaded: boolean;
}

/** A page as web/index.html leaves it: covering, with the mark and the card. */
function page({ off = false, target = true } = {}): Page {
  const root = new FakeEl(), cover = new FakeEl(), app = new FakeEl(), msg = new FakeEl();
  root.classes.add("ag-covering");
  if (off) root.classes.add("agc-off");
  const card = new FakeEl(); card.hidden = true;
  const go = new FakeEl(); go.hidden = true;
  const again = new FakeEl();
  card.kids.set(".agc-err-title", new FakeEl());
  card.kids.set(".agc-err-detail", new FakeEl());
  card.kids.set('[data-act="continue"]', go);
  card.kids.set('[data-act="reload"]', again);
  const mark = new FakeEl(); mark.rect = box(590, 310, 260);
  cover.kids.set(".agc-error", card);
  cover.kids.set(".ag-lm", mark);
  for (const k of [".agc-enter", ".agc-fx", ".agc-fy", ".agc-fs", ".agc-rings", ".agc-bg"]) cover.kids.set(k, new FakeEl());
  const t = target ? new FakeEl() : null;
  if (t) t.rect = box(10, 4, 22);
  return { root, cover, app, msg, target: t, card, go, again, mark, reloaded: false };
}

const saved: Record<string, unknown> = {};
const G = globalThis as Record<string, unknown>;
let reduced = false;
beforeAll(() => {
  for (const k of ["document", "window", "matchMedia", "innerWidth", "innerHeight", "getComputedStyle", "HTMLElement", "Element", "location", "performance"]) saved[k] = G[k];
  // The cap is measured from the start of navigation: performance.now()'s zero.
  // In `bun test` that zero is the start of the whole run, and fifteen seconds
  // of other files put every case here past the cap before it began.
  const real = saved.performance as Performance;
  const zero = real.now();
  G.performance = { now: () => real.now() - zero, mark: (name: string) => real.mark(name) };
  G.HTMLElement = FakeEl;
  G.Element = FakeEl;
  G.innerWidth = 1440;
  G.innerHeight = 900;
  G.matchMedia = (q: string) => ({ matches: q.includes("reduced-motion") ? reduced : false });
  G.getComputedStyle = () => ({ opacity: "1" });
});
afterAll(() => { for (const [k, v] of Object.entries(saved)) G[k] = v; });

let n = 0;
/** Install `p` as the document (and `shell` as the desktop bridge) and load a fresh cover.ts. */
async function load(p: Page, shell?: Record<string, unknown>) {
  G.document = {
    documentElement: p.root,
    getElementById: (id: string) => (id === "ag-cover" ? (p.cover.removed ? null : p.cover) : id === "root" ? p.app : id === "agc-msg" ? p.msg : null),
    querySelector: (sel: string) => (sel === "[data-cover-target]" ? p.target : null),
  };
  G.window = shell ? { agentglass: shell } : {};
  G.location = { reload: () => { p.reloaded = true; } };
  return (await import(`../src/lib/cover.ts?case=${++n}`)) as typeof import("../src/lib/cover.ts");
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gone = (p: Page) => p.cover.removed && !p.root.classes.has("ag-covering");

describe("what takes the cover down", () => {
  test("not while a panel holds it; after the last one lets go and the settle, it flies to the title bar", async () => {
    reduced = false;
    const p = page();
    const c = await load(p);
    expect(c.coverIsUp()).toBe(true);
    const letGo = c.holdCover("terminal");
    c.coverMounted();
    await wait(90);
    expect(p.cover.removed).toBe(false);
    expect(p.msg.textContent).toBe("opening the terminal…");
    letGo();
    await wait(90);
    expect(gone(p)).toBe(true);
    // The flight: three moves (x, y, scale) on the mark's layers, landing on
    // the title bar's mark, which was hidden for it and is shown again.
    const fs = p.cover.kids.get(".agc-fs")!.animated[0];
    expect(fs.frames[1].transform).toBe(`scale(${22 / 260})`);
    expect(p.cover.kids.get(".agc-fx")!.animated[0].frames[1].transform).toBe(`translateX(${21 - 720}px)`);
    expect(p.target!.style.visibility).toBe("");
    expect(c.coverIsUp()).toBe(false);
  });

  test("a hold that lets go as another takes over keeps it up", async () => {
    const p = page();
    const c = await load(p);
    const project = c.holdCover("project");
    c.coverMounted();
    project();
    const terminal = c.holdCover("terminal"); // the same breath: the shell it opens
    await wait(90);
    expect(p.cover.removed).toBe(false);
    terminal();
    await wait(90);
    expect(gone(p)).toBe(true);
  });

  test("a hold taken after it is down changes nothing", async () => {
    const p = page();
    const c = await load(p);
    c.coverMounted();
    await wait(90);
    expect(gone(p)).toBe(true);
    expect(c.refusalFinal()).toBe(true); // no shell: the page came from the server, a refusal is real
    const late = c.holdCover("git");
    late();
    expect(c.coverIsUp()).toBe(false);
  });

  test("switched off in Settings, it goes the moment React mounts, with no motion", async () => {
    const p = page({ off: true });
    const c = await load(p);
    c.holdCover("terminal"); // a panel still loading does not keep a plain boot screen up
    c.coverMounted();
    expect(gone(p)).toBe(true);
    expect(p.cover.animated).toHaveLength(0);
  });

  test("reduced motion cross-fades the whole cover instead of flying", async () => {
    reduced = true;
    const p = page();
    const c = await load(p);
    c.coverMounted();
    await wait(90);
    reduced = false;
    expect(gone(p)).toBe(true);
    expect(p.cover.animated.map((a) => a.frames.map((f) => f.opacity))).toEqual([[1, 0]]);
    expect(p.cover.kids.get(".agc-fx")!.animated).toHaveLength(0);
  });

  test("with nowhere to land it fades", async () => {
    const p = page({ target: false });
    const c = await load(p);
    c.coverMounted();
    await wait(90);
    expect(gone(p)).toBe(true);
    expect(p.cover.animated).toHaveLength(1);
  });

  test("motion that throws still takes it down, and never leaves the title bar's mark hidden", async () => {
    const p = page();
    p.cover.kids.get(".agc-fx")!.throwOnAnimate = true; // an engine without linear() easing
    const c = await load(p);
    c.coverMounted();
    await wait(90);
    expect(gone(p)).toBe(true);
    expect(p.target!.style.visibility ?? "").toBe("");
  });
});

describe("the server, as the desktop shell tells it", () => {
  test("a server still starting holds the cover, whatever the panels say, until the shell has seen it", async () => {
    let up = false;
    const p = page();
    const c = await load(p, { sidecarUp: () => up, sidecarFailure: null, onServerFailed: () => () => {} });
    expect(c.serverSettled()).toBe(false);
    c.coverMounted();
    await wait(200);
    expect(p.cover.removed).toBe(false);
    expect(p.msg.textContent).toBe("starting the server…");
    up = true;
    await wait(400);
    expect(c.serverSettled()).toBe(true);
    // Up is not failed: a request that raced it is asked again, not taken as the answer.
    expect(c.refusalFinal()).toBe(false);
    expect(gone(p)).toBe(true);
  });

  test("a server that failed is said on the cover, keyboard on the card and the app behind it inert", async () => {
    let hear: ((f: unknown) => void) | null = null;
    let up = false;
    const p = page();
    const c = await load(p, {
      sidecarUp: () => up,
      sidecarFailure: { reason: "spawn", what: "The server program could not start.", fix: "Reinstall the app." },
      onServerFailed: (fn: (f: unknown) => void) => { hear = fn; return () => { hear = null; }; },
    });
    expect(p.card.hidden).toBe(false);
    expect(p.card.kids.get(".agc-err-title")!.textContent).toBe("The server did not start");
    expect(p.card.kids.get(".agc-err-detail")!.textContent).toContain("Reinstall the app.");
    expect(p.go.hidden).toBe(false);
    expect(p.go.focused).toBe(true);
    expect(p.app.attrs.has("inert")).toBe(true);
    const terminal = c.holdCover("terminal");
    c.coverMounted();
    await wait(90);
    expect(p.cover.removed).toBe(false); // a failure is not a reason to lift over it
    // A restart worked: the card goes and the app is reachable again, while the
    // cover keeps waiting for the panel still loading.
    up = true;
    hear!(null);
    await wait(90);
    expect(p.card.hidden).toBe(true);
    expect(p.app.attrs.has("inert")).toBe(false);
    expect(p.cover.removed).toBe(false);
    terminal();
    await wait(90);
    expect(gone(p)).toBe(true);
  });

  test("the card's way on is the app itself, and Reload reloads", async () => {
    const p = page();
    const c = await load(p, { sidecarUp: () => false, sidecarFailure: { reason: "missing", what: "No server program.", fix: "Install it." }, onServerFailed: () => () => {} });
    c.coverMounted();
    p.again.onclick!();
    expect(p.reloaded).toBe(true);
    p.go.onclick!();
    await wait(90);
    expect(gone(p)).toBe(true);
    expect(p.app.attrs.has("inert")).toBe(false);
  });

  test("a timeout is not a card: the shell stopped waiting, the server may yet come", async () => {
    const p = page();
    const c = await load(p, { sidecarUp: () => false, sidecarFailure: { reason: "timeout", what: "No answer yet.", fix: "Wait." }, onServerFailed: () => () => {} });
    expect(p.card.hidden).toBe(true);
    expect(c.serverSettled()).toBe(true); // its fate is known: panels may take refusals as answers now
    expect(c.refusalFinal()).toBe(true);
    c.coverMounted();
    await wait(90);
    expect(gone(p)).toBe(true);
  });
});
