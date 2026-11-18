/*
 * The ring follows a field pointMatch tagged inside a same-origin frame or an
 * open shadow root (electron/guide-observer.js), measured in the top page's
 * coordinates; and only the person's main-button press on the target is the
 * click a step waits for. The real observer script, against a small fake page.
 */
import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { observerSource, BINDING } = require("../../electron/guide-observer.js") as { observerSource: (s: unknown) => string; BINDING: string };

const SEL = '[data-agx-guide="g1"]';

function fakePage(where: "frame" | "shadow") {
  const reports: Array<Record<string, unknown>> = [];
  const listeners: Record<string, (e: unknown) => void> = {};
  const top: Record<string, unknown> = {};
  const frameWin: Record<string, unknown> = { parent: top, getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
  const node: Record<string, unknown> = {
    tagName: "DIV", isConnected: true, parentElement: null, closest: () => null,
    ownerDocument: where === "frame" ? { defaultView: frameWin } : { defaultView: top },
    getBoundingClientRect: () => ({ x: 5, y: 6, width: 80, height: 20 }),
    addEventListener: (t: string, f: (e: unknown) => void) => { listeners[t] = f; }, removeEventListener() {}, scrollIntoView() {},
  };
  const inner = { querySelectorAll: (s: string) => (s === SEL ? [node] : []), querySelector: (s: string) => (s === SEL ? node : null) };
  const host: Record<string, unknown> = { tagName: where === "frame" ? "IFRAME" : "ORBIT-FIELD", clientLeft: 0, clientTop: 0,
    getBoundingClientRect: () => ({ x: 100, y: 50, width: 400, height: 300 }) };
  if (where === "frame") { host.contentDocument = inner; frameWin.frameElement = host; } else host.shadowRoot = inner;
  class Obs { constructor(public fn: () => void) {} observe() {} disconnect() {} }
  const env: Record<string, unknown> = {
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    matchMedia: () => ({ matches: false }), window: top, innerWidth: 1000, innerHeight: 800,
    document: { querySelector: () => null, querySelectorAll: (s: string) => (s === "*" ? [host] : []), documentElement: {}, body: {} },
    [BINDING]: (m: string) => reports.push(JSON.parse(m)),
    ResizeObserver: Obs, IntersectionObserver: Obs, MutationObserver: Obs,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {},
    addEventListener() {}, removeEventListener() {}, visualViewport: undefined,
  };
  const found = new Function("env", `with (env) { return ${observerSource({ selector: SEL })} }`)(env) as unknown;
  return { found, reports, listeners };
}

describe("the ring reaches fields in frames and shadow roots", () => {
  it("a field tagged inside a same-origin frame is watched, and its rect is in the top page's coordinates", () => {
    const p = fakePage("frame");
    expect(p.found).toBe(true);
    expect(p.reports[0]!.rect).toMatchObject({ x: 105, y: 56, w: 80, h: 20 });
  });

  it("a field tagged inside an open shadow root is watched where it is", () => {
    const p = fakePage("shadow");
    expect(p.found).toBe(true);
    expect(p.reports[0]!.rect).toMatchObject({ x: 5, y: 6 });
  });

  it("only a trusted main-button press is the person's click", () => {
    const p = fakePage("shadow");
    const n = p.reports.length;
    p.listeners.pointerdown!({ isTrusted: true, button: 2 });
    p.listeners.pointerdown!({ isTrusted: true, button: 1 });
    p.listeners.pointerdown!({ isTrusted: false, button: 0 });
    expect(p.reports.slice(n).some((r) => r.clicked)).toBe(false);
    p.listeners.pointerdown!({ isTrusted: true, button: 0 });
    expect(p.reports.slice(n).some((r) => r.clicked)).toBe(true);
  });

  it("a keyboard press on the target (Enter on a link, Space on a button) is the person's click too", () => {
    const p = fakePage("shadow");
    const n = p.reports.length;
    /* A pointer click (detail 1) was already told by its pointerdown; an untrusted one is the page's. */
    p.listeners.click!({ isTrusted: true, detail: 1 });
    p.listeners.click!({ isTrusted: false, detail: 0 });
    expect(p.reports.slice(n).some((r) => r.clicked)).toBe(false);
    p.listeners.click!({ isTrusted: true, detail: 0 });
    expect(p.reports.slice(n).some((r) => r.clicked)).toBe(true);
  });

  it("Enter on a link target is told at keydown, before the click can unload the page", () => {
    const p = fakePage("shadow");
    const n = p.reports.length;
    p.listeners.keydown!({ isTrusted: true, key: "Enter", repeat: false, target: { closest: () => null } });
    p.listeners.keydown!({ isTrusted: false, key: "Enter", repeat: false, target: { closest: () => ({}) } });
    p.listeners.keydown!({ isTrusted: true, key: "a", repeat: false, target: { closest: () => ({}) } });
    expect(p.reports.slice(n).some((r) => r.clicked)).toBe(false);
    p.listeners.keydown!({ isTrusted: true, key: "Enter", repeat: false, target: { closest: () => ({}) } });
    expect(p.reports.slice(n).some((r) => r.clicked)).toBe(true);
    /* The click that follows is the same press: not told twice. */
    p.listeners.click!({ isTrusted: true, detail: 0 });
    expect(p.reports.slice(n).filter((r) => r.clicked)).toHaveLength(1);
  });

  it("a nav step listens for the person's submit too", () => {
    expect(observerSource({ selector: SEL, wait: "nav" })).toContain('spec.wait === "submit" || spec.wait === "nav"');
  });
});
