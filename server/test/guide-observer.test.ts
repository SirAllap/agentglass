/*
 * Guide mode's observer in the guest (electron/guide-observer.js), driven by a
 * fake CDP: the isolated world is made, the pointed node's rect and the
 * person's press reach the panel as guide events, a navigation is reported and
 * the world is made again, and end takes it down.
 */
import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
type Ev = Record<string, unknown>;
const { createGuideObserver, observerSource, offView, hiddenWhy, firstLook, BINDING, WORLD } = require("../../electron/guide-observer.js") as {
  offView: (r: { x: number; y: number; w: number; h: number }, vw: number, vh: number) => boolean;
  hiddenWhy: (s: Record<string, unknown>) => string;
  firstLook: (why: string, run: boolean) => "watch" | "wait" | "refuse";
  createGuideObserver: (o: { send: (m: string, p: unknown) => Promise<unknown>; emit: (e: Ev) => void }) => {
    start: (s: Record<string, unknown>) => Promise<{ ok: boolean; found?: boolean; error?: string; reason?: string }>;
    stop: () => Promise<void>;
    onMessage: (m: string, p: unknown) => void;
    settle: () => Promise<unknown>;
    readonly live: boolean;
  };
  observerSource: (s: unknown) => string;
  BINDING: string;
  WORLD: string;
};

function fakeCdp(opts: { failWorld?: boolean; found?: boolean | string } = {}) {
  const calls: { m: string; p: Record<string, unknown> }[] = [];
  let ctx = 40;
  const send = async (m: string, p: unknown) => {
    calls.push({ m, p: (p ?? {}) as Record<string, unknown> });
    if (m === "Page.getFrameTree") return { frameTree: { frame: { id: "F1", url: "http://127.0.0.1/a" } } };
    if (m === "Page.createIsolatedWorld") {
      if (opts.failWorld) throw new Error("Target crashed");
      return { executionContextId: ++ctx };
    }
    if (m === "Runtime.evaluate") return { result: { value: typeof opts.found === "string" ? opts.found : opts.found !== false } };
    return {};
  };
  return { calls, send, ctx: () => ctx };
}

const spec = { tab: "t1", selector: "#save", role: "button", name: "Save", waitClick: true, step: { n: 1, m: 3 }, say: "Press Save" };

describe("guide observer", () => {
  it("makes an isolated world with a binding scoped to it, and runs only there", async () => {
    const cdp = fakeCdp();
    const o = createGuideObserver({ send: cdp.send, emit: () => {} });
    expect(await o.start(spec)).toEqual({ ok: true, found: true });
    const bind = cdp.calls.find((c) => c.m === "Runtime.addBinding")!;
    expect(bind.p).toEqual({ name: BINDING, executionContextName: WORLD });
    const world = cdp.calls.find((c) => c.m === "Page.createIsolatedWorld")!;
    expect(world.p.frameId).toBe("F1");
    expect(world.p.worldName).toBe(WORLD);
    const ev = cdp.calls.find((c) => c.m === "Runtime.evaluate")!;
    expect(ev.p.contextId).toBe(cdp.ctx());
    expect(String(ev.p.expression)).toContain('"selector":"#save"');
    /* Never the page's own world: every evaluate names our context. */
    expect(cdp.calls.filter((c) => c.m === "Runtime.evaluate").every((c) => c.p.contextId === cdp.ctx())).toBe(true);
  });

  it("the script watches with observers and pointerdown, never a polling timer", () => {
    const src = observerSource({ selector: "#a" });
    for (const s of ["ResizeObserver", "IntersectionObserver", "pointerdown", "MutationObserver", "requestAnimationFrame"]) expect(src).toContain(s);
    expect(src).not.toMatch(/setInterval/);
    /* Three timeouts, each armed once by an event, never a poll: soon's stand-in
       for the frame, a run's typing pause (1.5 s after a key) and its lost
       clock (2 s after the wait begins), and the scroll-settle debounce (150 ms
       after a hashchange/popstate or a scroll event). */
    expect(src.match(/setTimeout\(/g)).toHaveLength(4);
    expect(src).toMatch(/typeTimer = setTimeout\([\s\S]{0,200}\}, 1500\)/);
    expect(src).toMatch(/lostTimer = setTimeout\([\s\S]{0,200}\}, 2000\)/);
    expect(() => new Function(src)).not.toThrow();
  });

  it("rect changes and the press reach the panel as guide events", async () => {
    const cdp = fakeCdp();
    const out: Ev[] = [];
    const o = createGuideObserver({ send: cdp.send, emit: (e) => out.push(e) });
    await o.start(spec);
    const ctx = cdp.ctx();
    o.onMessage("Runtime.bindingCalled", { name: BINDING, executionContextId: ctx, payload: JSON.stringify({ rect: { x: 10, y: 20, w: 80, h: 30 } }) });
    o.onMessage("Runtime.bindingCalled", { name: BINDING, executionContextId: ctx, payload: JSON.stringify({ rect: { x: 10, y: 5, w: 80, h: 30 }, clicked: true }) });
    expect(out).toEqual([
      { kind: "guide", tab: "t1", phase: "wait", step: { n: 1, m: 3 }, waitClick: true, target: { rect: { x: 10, y: 20, w: 80, h: 30 } } },
      { kind: "guide", tab: "t1", phase: "wait", step: { n: 1, m: 3 }, waitClick: true, target: { rect: { x: 10, y: 5, w: 80, h: 30 } }, clicked: true },
    ]);
  });

  it("the page's width rides with the rect, so the panel can scale a zoomed page", async () => {
    const cdp = fakeCdp();
    const out: Ev[] = [];
    const o = createGuideObserver({ send: cdp.send, emit: (e) => out.push(e) });
    await o.start(spec);
    o.onMessage("Runtime.bindingCalled", { name: BINDING, executionContextId: cdp.ctx(), payload: JSON.stringify({ rect: { x: 10, y: 20, w: 80, h: 30, vw: 1280 } }) });
    expect((out[0] as { target: { rect: unknown } }).target.rect).toEqual({ x: 10, y: 20, w: 80, h: 30, vw: 1280 });
    expect(observerSource({ selector: "#a" })).toContain("vw: innerWidth");
  });

  /* The real observer script, run against a fake page: listeners are kept, frames run when flushed. */
  function fakePage(o: { tag?: string; open?: boolean; absent?: boolean; hidden?: boolean; spec?: Record<string, unknown> } = {}) {
    const box = { x: 10, y: 300, width: 80, height: 30 };
    const view = { innerWidth: 1000, innerHeight: 600 };
    const style = { display: o.hidden ? "none" : "block", visibility: "visible" };
    const on: Record<string, Array<() => void>> = {};
    const frames: Array<() => void> = [];
    const reports: Array<{ rect: Record<string, number> }> = [];
    /* The page's root holds the target; `other` is an element beside it. */
    const root = { contains: () => true };
    const other = { contains: () => false };
    const node: Record<string, unknown> = {
      tagName: (o.tag ?? "div").toUpperCase(), open: o.open ?? false, isConnected: true, parentElement: null,
      getBoundingClientRect: () => ({ ...box }), addEventListener() {}, removeEventListener() {}, scrollIntoView() {},
    };
    // Like the DOM's: the node itself is the first candidate.
    node.closest = (sel: string) => (sel === String(node.tagName).toLowerCase() ? node : null);
    let present = !o.absent;
    let finds = 0;
    class Obs {
      on = false; opts: Record<string, unknown> = {};
      constructor(public fn: (r?: unknown[]) => void) { obs.push(this); }
      observe(_t: unknown, opts?: Record<string, unknown>) { this.on = true; this.opts = opts ?? {}; observed.push(this.opts); }
      disconnect() { this.on = false; }
    }
    class RO extends Obs { constructor(fn: () => void) { super(fn); ros.push(this); } }
    class MO extends Obs { constructor(fn: (r?: unknown[]) => void) { super(fn); mos.push(this); } }
    const obs: Obs[] = [], ros: Obs[] = [], mos: Obs[] = [];
    const observed: Array<Record<string, unknown>> = [];
    const env: Record<string, unknown> = {
      getComputedStyle: () => style,
      matchMedia: () => ({ matches: false }),
      window: {} as Record<string, unknown>,
      document: { querySelector: () => { finds++; return present ? node : null; }, querySelectorAll: () => [], documentElement: root, body: {} },
      [BINDING]: (m: string) => reports.push(JSON.parse(m)),
      ResizeObserver: RO, IntersectionObserver: Obs, MutationObserver: MO,
      requestAnimationFrame: (f: () => void) => { frames.push(f); return frames.length; },
      cancelAnimationFrame() {},
      addEventListener: (t: string, f: () => void) => { (on[t] ??= []).push(f); },
      removeEventListener() {},
      visualViewport: undefined,
    };
    Object.defineProperty(env, "innerWidth", { get: () => view.innerWidth });
    Object.defineProperty(env, "innerHeight", { get: () => view.innerHeight });
    const run = new Function("env", `with (env) { return ${observerSource(o.spec ?? { selector: "#a" })} }`) as (e: unknown) => boolean | string;
    const found = run(env);
    const flush = () => { for (const f of frames.splice(0)) f(); };
    const fire = (t: string) => { for (const f of on[t] ?? []) f(); flush(); };
    const layout = () => { for (const o of obs) if (o.on) o.fn(); flush(); };
    /* Like the DOM's: a record reaches only an observer whose options ask for it. */
    type Rec = { type: "childList" | "attributes"; attributeName?: string; target: unknown };
    const mutate = (r: Rec, now = true) => {
      for (const o of mos) {
        if (!o.on) continue;
        if (r.type === "attributes" && (!o.opts.attributes || (Array.isArray(o.opts.attributeFilter) && !o.opts.attributeFilter.includes(r.attributeName)))) continue;
        if (r.type === "childList" && !o.opts.childList) continue;
        o.fn([r]);
      }
      if (now) flush();
    };
    /* Only the ResizeObservers: a size change that is not a DOM change. */
    const resized = () => { for (const o of ros) if (o.on) o.fn(); flush(); };
    const add = () => { present = true; };
    const stop = () => { const w = env.window as { __agxGuideStop?: () => void }; w.__agxGuideStop?.(); };
    return { found, box, view, style, reports, fire, layout, add, observed, mutate, resized, flush, node, root, other, finds: () => finds, stop };
  }

  it("a closed <details> that is itself the target is seen through its summary, and is watched", () => {
    expect(fakePage({ tag: "details", open: false }).found).toBe(true);
  });

  it("a target added hidden and shown later is watched once it shows", () => {
    const p = fakePage({ absent: true });
    expect(p.found).toBe(false);
    p.add();
    p.style.display = "none";
    p.mutate({ type: "childList", target: p.root });
    expect(p.reports).toEqual([]);
    // A style change on the target, not a new child: the wait must hear it too.
    p.style.display = "block";
    p.mutate({ type: "attributes", attributeName: "style", target: p.node });
    expect(p.reports.at(-1)!.rect).toMatchObject({ y: 300 });
  });

  it("a run's target hidden at the step's start (a #hash section shown on hashchange) is waited for and ringed", () => {
    const p = fakePage({ hidden: true, spec: { selector: "#a", watchLost: true } });
    expect(p.found).toBe(false);
    expect(p.reports).toEqual([]);
    // The page's hashchange handler shows the section by a style write on the target itself.
    p.style.display = "block";
    p.mutate({ type: "attributes", attributeName: "style", target: p.node });
    expect(p.reports.at(-1)!.rect).toMatchObject({ y: 300 });
    p.stop();
  });

  it("a single point's target hidden at the start is refused with why, not waited for", () => {
    const p = fakePage({ hidden: true });
    expect(p.found).toMatch(/display:none/);
  });

  it("a target that shows with no DOM change (an <img> 0x0 until it loads) is watched", () => {
    const p = fakePage({ absent: true });
    p.add();
    p.box.width = 0; p.box.height = 0;
    p.mutate({ type: "childList", target: p.root });
    expect(p.reports).toEqual([]);
    p.box.width = 80; p.box.height = 30; // the image loaded: its size changed, the DOM did not
    p.resized();
    expect(p.reports.at(-1)!.rect).toMatchObject({ w: 80, h: 30 });
  });

  it("a target a media query shows (the viewport changed, the DOM did not) is watched", () => {
    const p = fakePage({ absent: true });
    p.add();
    p.style.display = "none";
    p.mutate({ type: "childList", target: p.root });
    p.style.display = "block";
    p.fire("resize");
    expect(p.reports.at(-1)!.rect).toMatchObject({ y: 300 });
  });

  it("the wait looks once per frame, and not at style writes that cannot show the target", () => {
    const p = fakePage({ absent: true });
    const at = p.finds();
    // A JS-animated page: style written every frame, and nothing to find yet.
    for (let i = 0; i < 50; i++) p.mutate({ type: "attributes", attributeName: "style", target: p.other });
    expect(p.finds()).toBe(at);
    // Three batches in one frame are one look.
    for (let i = 0; i < 3; i++) p.mutate({ type: "childList", target: p.root }, false);
    p.flush();
    expect(p.finds()).toBe(at + 1);
    // With a hidden candidate, a class change beside it that leaves it hidden is not a reason to look.
    p.add(); p.style.display = "none";
    p.mutate({ type: "childList", target: p.root });
    const seen = p.finds();
    for (let i = 0; i < 20; i++) p.mutate({ type: "attributes", attributeName: "class", target: p.other });
    expect(p.finds()).toBe(seen);
    // A style write beside it is never one, even when it would show.
    p.style.display = "block";
    p.mutate({ type: "attributes", attributeName: "style", target: p.other });
    expect(p.finds()).toBe(seen);
  });

  it("a hidden target a sibling's class write shows (.toggle.open + .menu) is watched", () => {
    const p = fakePage({ absent: true });
    p.add(); p.style.visibility = "hidden";
    p.mutate({ type: "childList", target: p.root });
    expect(p.reports).toEqual([]);
    // Its size never changes, so no ResizeObserver fires: only the sibling's class write tells.
    p.style.visibility = "visible";
    p.mutate({ type: "attributes", attributeName: "class", target: p.other });
    expect(p.reports.at(-1)!.rect).toMatchObject({ y: 300 });
  });

  it("the rect is recomputed when the page scrolls", () => {
    const p = fakePage();
    expect(p.found).toBe(true);
    expect(p.reports.at(-1)!.rect).toMatchObject({ y: 300, vw: 1000, vh: 600 });
    p.box.y = 120;
    p.fire("scroll");
    expect(p.reports.at(-1)!.rect).toMatchObject({ y: 120 });
    p.box.y = -50;
    p.fire("scroll");
    expect(p.reports.at(-1)!.rect).toMatchObject({ y: -50 });
  });

  it("the rect is recomputed when the zoom factor changes (the page's own width moves)", () => {
    const p = fakePage();
    // Zoom 1 to 1.25 in a 1000 px pane: the page is now 800 CSS px wide and the element sits nearer the top-left.
    p.view.innerWidth = 800; p.view.innerHeight = 480; p.box.x = 8; p.box.y = 240;
    p.fire("resize");
    expect(p.reports.at(-1)!.rect).toEqual({ x: 8, y: 240, w: 80, h: 30, vw: 800, vh: 480 });
  });

  it("the rect is recomputed when the pane or window is resized, and on a layout shift", () => {
    const p = fakePage();
    p.view.innerWidth = 640; p.box.y = 410;
    p.fire("resize");
    expect(p.reports.at(-1)!.rect).toMatchObject({ y: 410, vw: 640 });
    const n = p.reports.length;
    p.box.y = 460; // a banner pushed the element down; nothing resized, the DOM changed
    p.layout();
    expect(p.reports.at(-1)!.rect).toMatchObject({ y: 460 });
    expect(p.reports.length).toBe(n + 1);
    p.layout(); // a change that did not move it says nothing
    expect(p.reports.length).toBe(n + 1);
  });

  it("an OK step reports phase point; a call from another context or binding is ignored", async () => {
    const cdp = fakeCdp();
    const out: Ev[] = [];
    const o = createGuideObserver({ send: cdp.send, emit: (e) => out.push(e) });
    await o.start({ tab: "t1", selector: "#x", say: "Look here" });
    o.onMessage("Runtime.bindingCalled", { name: BINDING, executionContextId: 999, payload: JSON.stringify({ rect: { x: 1, y: 1, w: 1, h: 1 } }) });
    o.onMessage("Runtime.bindingCalled", { name: "other", executionContextId: cdp.ctx(), payload: "{}" });
    o.onMessage("Runtime.bindingCalled", { name: BINDING, executionContextId: cdp.ctx(), payload: "not json" });
    expect(out).toEqual([]);
    o.onMessage("Runtime.bindingCalled", { name: BINDING, executionContextId: cdp.ctx(), payload: JSON.stringify({ rect: { x: 1, y: 2, w: 3, h: 4 } }) });
    expect(out[0]!.phase).toBe("point");
    expect(out[0]!.waitClick).toBe(false);
  });

  it("point, the person clicks a link, the page navigates: clicked, then navigated, then the world is made again", async () => {
    const cdp = fakeCdp();
    const out: Ev[] = [];
    const o = createGuideObserver({ send: cdp.send, emit: (e) => out.push(e) });
    await o.start(spec);
    const first = cdp.ctx();
    o.onMessage("Runtime.bindingCalled", { name: BINDING, executionContextId: first, payload: JSON.stringify({ rect: { x: 0, y: 0, w: 5, h: 5 }, clicked: true }) });
    o.onMessage("Page.frameNavigated", { frame: { id: "F1", url: "http://127.0.0.1/b" } });
    await o.settle();
    expect(out.map((e) => [e.clicked ?? null, e.navigated ?? null])).toEqual([[true, null], [null, { url: "http://127.0.0.1/b" }]]);
    expect(cdp.calls.filter((c) => c.m === "Page.createIsolatedWorld").length).toBe(2);
    const second = cdp.ctx();
    expect(second).not.toBe(first);
    /* The old world's reports are stale now; the new one's are heard. */
    o.onMessage("Runtime.bindingCalled", { name: BINDING, executionContextId: first, payload: JSON.stringify({ rect: { x: 9, y: 9, w: 9, h: 9 } }) });
    o.onMessage("Runtime.bindingCalled", { name: BINDING, executionContextId: second, payload: JSON.stringify({ rect: { x: 1, y: 1, w: 9, h: 9 } }) });
    expect(out.length).toBe(3);
    expect(out[2]!.target).toEqual({ rect: { x: 1, y: 1, w: 9, h: 9 } });
  });

  it("a subframe navigation is not the page changing", async () => {
    const cdp = fakeCdp();
    const out: Ev[] = [];
    const o = createGuideObserver({ send: cdp.send, emit: (e) => out.push(e) });
    await o.start(spec);
    o.onMessage("Page.frameNavigated", { frame: { id: "F2", parentId: "F1", url: "http://ads/" } });
    expect(out).toEqual([]);
  });

  it("a lost world comes back on the next default context", async () => {
    const cdp = fakeCdp();
    const o = createGuideObserver({ send: cdp.send, emit: () => {} });
    await o.start(spec);
    o.onMessage("Runtime.executionContextDestroyed", { executionContextId: cdp.ctx() });
    o.onMessage("Runtime.executionContextCreated", { context: { id: 7, auxData: { isDefault: true, frameId: "F1" } } });
    await o.settle();
    expect(cdp.calls.filter((c) => c.m === "Page.createIsolatedWorld").length).toBe(2);
  });

  it("falls back with an error when the world cannot be made", async () => {
    const cdp = fakeCdp({ failWorld: true });
    const o = createGuideObserver({ send: cdp.send, emit: () => {} });
    const r = await o.start(spec);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Target crashed");
    expect(o.live).toBe(false);
  });

  it("stop takes the watchers and the binding down, and nothing is reported after", async () => {
    const cdp = fakeCdp();
    const out: Ev[] = [];
    const o = createGuideObserver({ send: cdp.send, emit: (e) => out.push(e) });
    await o.start(spec);
    const ctx = cdp.ctx();
    await o.stop();
    const tail = cdp.calls.slice(-2);
    expect(tail[0]).toEqual({ m: "Runtime.evaluate", p: { expression: "window.__agxGuideStop && window.__agxGuideStop()", contextId: ctx } });
    expect(tail[1]).toEqual({ m: "Runtime.removeBinding", p: { name: BINDING } });
    o.onMessage("Runtime.bindingCalled", { name: BINDING, executionContextId: ctx, payload: JSON.stringify({ rect: { x: 1, y: 1, w: 1, h: 1 } }) });
    o.onMessage("Page.frameNavigated", { frame: { id: "F1", url: "x" } });
    expect(out).toEqual([]);
    expect(o.live).toBe(false);
  });
});

describe("a new target retires the old world", () => {
  it("start() runs __agxGuideStop in the previous context, and its reports are dropped", async () => {
    const cdp = fakeCdp();
    const out: Ev[] = [];
    const o = createGuideObserver({ send: cdp.send, emit: (e) => out.push(e) });
    await o.start(spec);
    const first = cdp.ctx();
    await o.start({ ...spec, selector: "#next", say: "Then Next" });
    const stops = cdp.calls.filter((c) => c.m === "Runtime.evaluate" && c.p.expression === "window.__agxGuideStop && window.__agxGuideStop()");
    expect(stops.map((c) => c.p.contextId)).toEqual([first]);
    o.onMessage("Runtime.bindingCalled", { name: BINDING, executionContextId: first, payload: JSON.stringify({ rect: { x: 1, y: 1, w: 1, h: 1 } }) });
    expect(out).toEqual([]);
    o.onMessage("Runtime.bindingCalled", { name: BINDING, executionContextId: cdp.ctx(), payload: JSON.stringify({ rect: { x: 1, y: 1, w: 1, h: 1 } }) });
    expect(out).toHaveLength(1);
    expect("say" in out[0]!).toBe(false);
  });
});

describe("a report belongs to its step", () => {
  it("every report carries the step id of the point that started it", async () => {
    const cdp = fakeCdp();
    const out: Ev[] = [];
    const o = createGuideObserver({ send: cdp.send, emit: (e) => out.push(e) });
    await o.start({ ...spec, stepId: 4 });
    o.onMessage("Runtime.bindingCalled", { name: BINDING, executionContextId: cdp.ctx(), payload: JSON.stringify({ rect: { x: 1, y: 1, w: 1, h: 1 } }) });
    o.onMessage("Page.frameNavigated", { frame: { id: "F1", url: "http://127.0.0.1/b" } });
    await o.settle();
    expect(out.map((e) => e.stepId)).toEqual([4, 4]);
  });

  it("while the old world stops, a navigation of the old step is not reported", async () => {
    let release: () => void = () => {};
    const cdp = fakeCdp();
    const send = async (m: string, p: unknown) => {
      if (m === "Runtime.evaluate" && String((p as Ev).expression).startsWith("window.__agxGuideStop")) await new Promise<void>((r) => { release = r; });
      return cdp.send(m, p);
    };
    const out: Ev[] = [];
    const o = createGuideObserver({ send, emit: (e) => out.push(e) });
    await o.start({ ...spec, stepId: 1 });
    const next = o.start({ ...spec, selector: "#next", stepId: 2 });
    await Promise.resolve();
    o.onMessage("Page.frameNavigated", { frame: { id: "F1", url: "http://127.0.0.1/late" } });
    o.onMessage("Runtime.bindingCalled", { name: BINDING, executionContextId: cdp.ctx(), payload: JSON.stringify({ rect: { x: 1, y: 1, w: 1, h: 1 }, clicked: true }) });
    expect(out).toEqual([]);
    release();
    expect(await next).toEqual({ ok: true, found: true });
  });

  it("a late navigation from the step before does not answer the new step, but the world is still made again", async () => {
    const cdp = fakeCdp();
    const out: Ev[] = [];
    const o = createGuideObserver({ send: cdp.send, emit: (e) => out.push(e) });
    await o.start({ ...spec, stepId: 1 });
    /* Step 1's submit: the server is slow, the load is still in flight. */
    o.onMessage("Page.frameRequestedNavigation", { frameId: "F1", url: "http://127.0.0.1/slow" });
    o.onMessage("Page.frameStartedLoading", { frameId: "F1" });
    await o.start({ ...spec, selector: "#next", stepId: 2 });
    const worlds = cdp.calls.filter((c) => c.m === "Page.createIsolatedWorld").length;
    o.onMessage("Page.frameNavigated", { frame: { id: "F1", url: "http://127.0.0.1/slow" } });
    await o.settle();
    expect(out.filter((e) => e.navigated)).toEqual([]);
    expect(cdp.calls.filter((c) => c.m === "Page.createIsolatedWorld").length).toBe(worlds + 1);
    o.onMessage("Page.frameStoppedLoading", { frameId: "F1" });
    /* Step 2's own navigation is heard. */
    o.onMessage("Page.frameRequestedNavigation", { frameId: "F1", url: "http://127.0.0.1/b" });
    o.onMessage("Page.frameNavigated", { frame: { id: "F1", url: "http://127.0.0.1/b" } });
    await o.settle();
    expect(out.filter((e) => e.navigated).map((e) => [e.stepId, e.navigated])).toEqual([[2, { url: "http://127.0.0.1/b" }]]);
  });

  it("End guide while a point is starting leaves no observer on", async () => {
    let release: () => void = () => {};
    const cdp = fakeCdp();
    const send = async (m: string, p: unknown) => {
      if (m === "Runtime.evaluate" && String((p as Ev).expression).startsWith("window.__agxGuideStop")) await new Promise<void>((r) => { release = r; });
      return cdp.send(m, p);
    };
    const o = createGuideObserver({ send, emit: () => {} });
    await o.start({ ...spec, stepId: 1 });
    const next = o.start({ ...spec, selector: "#next", stepId: 2 });
    await Promise.resolve();
    const ended = o.stop();
    release();
    expect(await next).toEqual({ ok: true, found: false });
    await ended;
    expect(o.live).toBe(false);
    expect(cdp.calls.filter((c) => c.m === "Page.createIsolatedWorld").length).toBe(1);
  });

  it("main passes the step id through to the observer", async () => {
    const MAIN = await Bun.file(resolve(import.meta.dir, "../../electron/main.js")).text();
    expect(MAIN).toMatch(/stepId: s\.stepId/);
  });
});

describe("main.js wiring", async () => {
  const MAIN = await Bun.file(resolve(import.meta.dir, "../../electron/main.js")).text();
  const PKG = await Bun.file(resolve(import.meta.dir, "../../electron/package.json")).text();
  it("main requires the observer, and the package ships it", () => {
    expect(MAIN).toContain('require("./guide-observer.js")');
    expect(PKG).toContain('"guide-observer.js"');
  });
  it("the observer is removed when the guest goes away", () => {
    expect(MAIN).toMatch(/ag:browserGuideObserve/);
    expect(MAIN).toMatch(/guideObservers[\s\S]{0,400}destroyed/);
  });
});

describe("point brings its target into view, or says why it cannot", () => {
  it("a rect below the fold (or past any edge) asks for a scroll; one inside does not", () => {
    expect(offView({ x: 10, y: 2400, w: 80, h: 30 }, 1280, 800)).toBe(true);
    expect(offView({ x: 10, y: -40, w: 80, h: 30 }, 1280, 800)).toBe(true);
    expect(offView({ x: 1250, y: 100, w: 80, h: 30 }, 1280, 800)).toBe(true);
    expect(offView({ x: 10, y: 100, w: 80, h: 30 }, 1280, 800)).toBe(false);
  });

  it("firstLook: a seen target is watched; a hidden one waits on a run and is refused on a single point", () => {
    expect(firstLook("", false)).toBe("watch");
    expect(firstLook("", true)).toBe("watch");
    expect(firstLook("the target is display:none", true)).toBe("wait");
    expect(firstLook("the target is display:none", false)).toBe("refuse");
  });

  it("zero size, display:none, a closed <details> or a hiding parent is a reason; a seen box is none", () => {
    expect(hiddenWhy({ w: 0, h: 0, display: "block", visibility: "visible" })).toMatch(/zero size/);
    expect(hiddenWhy({ w: 0, h: 0, display: "none", visibility: "visible" })).toMatch(/display:none/);
    expect(hiddenWhy({ w: 80, h: 30, display: "block", visibility: "hidden" })).toMatch(/visibility/);
    expect(hiddenWhy({ w: 0, h: 0, display: "block", visibility: "visible", closedDetails: true })).toMatch(/closed <details>/);
    expect(hiddenWhy({ w: 0, h: 0, display: "block", visibility: "visible", unrendered: true })).toMatch(/parent/);
    expect(hiddenWhy({ w: 80, h: 30, display: "block", visibility: "visible" })).toBe("");
  });

  it("the script scrolls the target to the centre before it measures, instant under reduced motion", () => {
    const src = observerSource({ selector: "#a" });
    expect(src).toContain('scrollIntoView({ block: "center"');
    expect(src).toContain("prefers-reduced-motion: reduce");
    expect(src.indexOf("reveal(node);")).toBeLessThan(src.indexOf("send();\n    return true;"));
    expect(() => new Function(src)).not.toThrow();
  });

  it("a target that is there but hidden answers found:false with the reason, and nothing is watched", async () => {
    const cdp = fakeCdp({ found: "the target has zero size" });
    const o = createGuideObserver({ send: cdp.send, emit: () => {} });
    expect(await o.start(spec)).toEqual({ ok: true, found: false, reason: "the target has zero size" });
  });
  it("the first point on a page answers found:true though Runtime.enable replays the default context", async () => {
    const cdp = fakeCdp();
    let o: ReturnType<typeof createGuideObserver>;
    const send = async (m: string, p: unknown) => {
      const r = await cdp.send(m, p);
      /* What the first attach does: the page's existing default context arrives as an event. */
      if (m === "Runtime.enable") o.onMessage("Runtime.executionContextCreated", { context: { id: 3, auxData: { isDefault: true, frameId: "F1" } } });
      return r;
    };
    o = createGuideObserver({ send, emit: () => {} });
    expect(await o.start(spec)).toEqual({ ok: true, found: true });
    expect(cdp.calls.filter((c) => c.m === "Page.createIsolatedWorld").length).toBe(1);
  });

  it("a scroll or resize reports on a timer too, not only on an animation frame a hidden guest never runs", () => {
    const src = observerSource({ selector: "#a" });
    expect(src).toMatch(/frame = requestAnimationFrame\(flush\); tick = setTimeout\(flush, \d+\)/);
    expect(src).toContain("if (tick) clearTimeout(tick);");
    expect(() => new Function(src)).not.toThrow();
  });
});
