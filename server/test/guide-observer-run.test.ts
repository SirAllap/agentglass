/*
 * The guest observer's part in guide run (electron/guide-observer.js), with a
 * fake CDP: the person's typing, their submit and a lost target reach the
 * panel as guide events of the step; only trusted events count; and main.js
 * passes the run's fields through as data.
 */
import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
type Ev = Record<string, unknown>;
const { createGuideObserver, observerSource, BINDING } = require("../../electron/guide-observer.js") as {
  createGuideObserver: (o: { send: (m: string, p: unknown) => Promise<unknown>; emit: (e: Ev) => void }) => {
    start: (s: Record<string, unknown>) => Promise<{ ok: boolean; found?: boolean }>;
    onMessage: (m: string, p: unknown) => void;
  };
  observerSource: (s: unknown) => string;
  BINDING: string;
};

function fakeCdp() {
  const calls: { m: string; p: Record<string, unknown> }[] = [];
  let ctx = 40;
  const send = async (m: string, p: unknown) => {
    calls.push({ m, p: (p ?? {}) as Record<string, unknown> });
    if (m === "Page.getFrameTree") return { frameTree: { frame: { id: "F1", url: "http://127.0.0.1/a" } } };
    if (m === "Page.createIsolatedWorld") return { executionContextId: ++ctx };
    if (m === "Runtime.evaluate") return { result: { value: true } };
    return {};
  };
  return { calls, send, ctx: () => ctx };
}

const spec = { tab: "t1", selector: "#name", stepId: 4, wait: "input", watchLost: true, text: "Name", again: { selector: "input.name" } };

describe("guide run in the observer", () => {
  it("typing done, a submit, lost and found again reach the panel as the step's events", async () => {
    const cdp = fakeCdp();
    const out: Ev[] = [];
    const o = createGuideObserver({ send: cdp.send, emit: (e) => out.push(e) });
    await o.start(spec);
    const fire = (m: unknown) => o.onMessage("Runtime.bindingCalled", { name: BINDING, executionContextId: cdp.ctx(), payload: JSON.stringify(m) });
    fire({ input: true });
    fire({ submitted: true });
    fire({ gone: { url: "http://127.0.0.1/b" } });
    fire({ back: true, rect: { x: 1, y: 2, w: 3, h: 4 } });
    expect(out.map((e) => Object.keys(e).filter((k) => ["input", "submitted", "gone", "back"].includes(k))[0] ?? "rect")).toEqual(["input", "submitted", "gone", "back", "rect"]);
    expect(out.every((e) => e.stepId === 4 && e.tab === "t1")).toBe(true);
    expect(out[2]!.gone).toEqual({ url: "http://127.0.0.1/b" });
  });

  it("the run's fields reach the guest script as data, and only trusted typing and submits count", async () => {
    const cdp = fakeCdp();
    const o = createGuideObserver({ send: cdp.send, emit: () => {} });
    await o.start(spec);
    const expr = String(cdp.calls.find((c) => c.m === "Runtime.evaluate")!.p.expression);
    expect(expr).toContain('"wait":"input"');
    expect(expr).toContain('"watchLost":true');
    expect(expr).toContain('"again":{"selector":"input.name"}');
    const src = observerSource({ selector: "#a", wait: "submit" });
    expect(src).toMatch(/const typed = \(e\) => \{\s*if \(!typingCounts\(e\.isTrusted\)\) return;/);
    expect(src).toMatch(/const sentForm = \(e\) => \{\s*if \(!e\.isTrusted \|\| !el\) return;/);
    expect(() => new Function(src)).not.toThrow();
  });

  it("main.js passes text, again, wait and watchLost, and only the five waits", async () => {
    const MAIN = await Bun.file(resolve(import.meta.dir, "../../electron/main.js")).text();
    const at = MAIN.indexOf('ipcMain.handle("ag:browserGuideObserve"');
    const body = MAIN.slice(at, MAIN.indexOf("\n  });", at));
    for (const k of ["s.text", "s.again", "s.wait", "s.watchLost"]) expect(body).toContain(k);
    expect(body).toContain('["ok", "click", "nav", "input", "submit"].includes(s.wait)');
  });
});

describe("guide run: a nav step with no target (F3)", () => {
  it("the world's script finds nothing and arms no lost timer", () => {
    const timers: unknown[] = [];
    const run = new Function("window", "setTimeout", "document", "MutationObserver", `return ${observerSource({ selector: "", role: "", name: "", wait: "nav" })}`);
    expect(run({}, (f: unknown) => { timers.push(f); return 1; }, {}, undefined)).toBe(false);
    expect(timers).toHaveLength(0);
  });
});
