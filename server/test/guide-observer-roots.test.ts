/*
 * The observer's search of shadow roots and same-origin frames stays bounded
 * (electron/guide-observer.js roots()): a page with hundreds of web components
 * is searched in at most 64 roots, not every one, on each look.
 */
import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { observerSource, BINDING } = require("../../electron/guide-observer.js") as { observerSource: (s: unknown) => string; BINDING: string };

describe("roots() is capped", () => {
  it("200 shadow hosts on the top page: at most 64 roots are searched", () => {
    let searched = 0;
    const hosts = Array.from({ length: 200 }, () => ({
      tagName: "ORBIT-CARD",
      shadowRoot: { querySelectorAll: (s: string) => { if (s === "*") searched++; return []; }, querySelector: () => null },
    }));
    class Obs { constructor(public fn: () => void) {} observe() {} disconnect() {} }
    const env: Record<string, unknown> = {
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      matchMedia: () => ({ matches: false }), window: {}, innerWidth: 1000, innerHeight: 800, location: { href: "https://orbit.test/" },
      document: { querySelector: () => null, querySelectorAll: (s: string) => (s === "*" ? hosts : []), documentElement: {}, body: {} },
      [BINDING]: () => {},
      ResizeObserver: Obs, IntersectionObserver: Obs, MutationObserver: Obs,
      requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {},
      addEventListener() {}, removeEventListener() {}, visualViewport: undefined,
    };
    new Function("env", `with (env) { return ${observerSource({ selector: ".missing" })} }`)(env);
    expect(searched).toBeLessThanOrEqual(64);
  });
});

describe("a hidden target shown by the hash (:target)", () => {
  it("a hashchange looks again, so a section shown by CSS alone is watched, not lost", () => {
    const reports: Array<Record<string, unknown>> = [];
    const on: Record<string, () => void> = {};
    let frames: Array<() => void> = [];
    let visibility = "hidden";
    const node = {
      tagName: "SECTION", isConnected: true, parentElement: null, closest: () => null, ownerDocument: undefined,
      getBoundingClientRect: () => ({ x: 10, y: 20, width: 300, height: 100 }),
      addEventListener() {}, removeEventListener() {}, scrollIntoView() {},
    };
    class Obs { constructor(public fn: () => void) {} observe() {} disconnect() {} }
    const env: Record<string, unknown> = {
      getComputedStyle: () => ({ display: "block", visibility }),
      matchMedia: () => ({ matches: false }), window: {}, innerWidth: 1000, innerHeight: 800, location: { href: "https://orbit.test/faq" },
      document: { querySelector: (s: string) => (s === "#faq" ? node : null), querySelectorAll: (s: string) => (s === "#faq" ? [node] : []), documentElement: {}, body: {} },
      [BINDING]: (m: string) => reports.push(JSON.parse(m)),
      ResizeObserver: Obs, IntersectionObserver: Obs, MutationObserver: Obs,
      requestAnimationFrame: (f: () => void) => { frames.push(f); return frames.length; }, cancelAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {},
      addEventListener: (t: string, f: () => void) => { on[t] = f; }, removeEventListener() {}, visualViewport: undefined,
    };
    const found = new Function("env", `with (env) { return ${observerSource({ selector: "#faq", watchLost: true })} }`)(env);
    expect(found).toBe(false);
    visibility = "visible";
    expect(typeof on.hashchange).toBe("function");
    on.hashchange!();
    const run = frames; frames = []; for (const f of run) f();
    expect(reports.some((r) => r.rect)).toBe(true);
  });
});

describe("a target inside a same-origin frame", () => {
  it("the frame's own scroll, submit and DOM are heard, and let go on stop", () => {
    const frameOn: Record<string, unknown> = {};
    const observed: unknown[] = [];
    const frameRoot = { id: "frame-root" };
    const top: Record<string, unknown> = {};
    const frameWin: Record<string, unknown> = {
      parent: top, getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      addEventListener: (t: string, f: unknown) => { frameOn[t] = f; },
      removeEventListener: (t: string) => { delete frameOn[t]; },
    };
    const frameDoc = { defaultView: frameWin, documentElement: frameRoot };
    const node = {
      tagName: "BUTTON", isConnected: true, parentElement: null, closest: () => null, ownerDocument: frameDoc,
      getBoundingClientRect: () => ({ x: 5, y: 6, width: 80, height: 20 }),
      addEventListener() {}, removeEventListener() {}, scrollIntoView() {},
    };
    const SEL = '[data-agx-guide="g1"]';
    const inner = { querySelectorAll: (s: string) => (s === SEL ? [node] : []), querySelector: (s: string) => (s === SEL ? node : null) };
    const host = { tagName: "IFRAME", contentDocument: inner, clientLeft: 0, clientTop: 0, getBoundingClientRect: () => ({ x: 100, y: 50, width: 400, height: 300 }) };
    frameWin.frameElement = host;
    class Obs { constructor(public fn: () => void) {} observe(t: unknown) { observed.push(t); } disconnect() {} }
    const env: Record<string, unknown> = {
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      matchMedia: () => ({ matches: false }), window: top, innerWidth: 1000, innerHeight: 800, location: { href: "https://orbit.test/" },
      document: { querySelector: () => null, querySelectorAll: (s: string) => (s === "*" ? [host] : []), documentElement: {}, body: {} },
      [BINDING]: () => {},
      ResizeObserver: Obs, IntersectionObserver: Obs, MutationObserver: Obs,
      requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {},
      addEventListener() {}, removeEventListener() {}, visualViewport: undefined,
    };
    Object.assign(top, env);
    const found = new Function("env", `with (env) { const r = ${observerSource({ selector: SEL, wait: "submit" })}; return [r, window.__agxGuideStop]; }`)(env) as [unknown, () => void];
    expect(found[0]).toBe(true);
    expect(typeof frameOn.scroll).toBe("function");
    expect(typeof frameOn.submit).toBe("function");
    expect(observed).toContain(frameRoot);
    found[1]();
    expect(frameOn.scroll).toBeUndefined();
    expect(frameOn.submit).toBeUndefined();
  });
});

describe("--text picks a match in a shadow root when the top page's match has other text", () => {
  it("button.save 'Save draft' on top, 'Publish' in a shadow root: --text Publish finds the shadow one", () => {
    const reports: Array<Record<string, unknown>> = [];
    const mk = (text: string) => ({
      tagName: "BUTTON", isConnected: true, parentElement: null, closest: () => null, ownerDocument: undefined, innerText: text,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ x: 1, y: 2, width: 60, height: 20 }),
      addEventListener() {}, removeEventListener() {}, scrollIntoView() {},
    });
    const draft = mk("Save draft"), publish = mk("Publish");
    const host = { tagName: "ORBIT-BAR", shadowRoot: { querySelectorAll: (s: string) => (s === "button.save" ? [publish] : []), querySelector: () => null } };
    class Obs { constructor(public fn: () => void) {} observe() {} disconnect() {} }
    const env: Record<string, unknown> = {
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      matchMedia: () => ({ matches: false }), window: {}, innerWidth: 1000, innerHeight: 800, location: { href: "https://orbit.test/" },
      document: {
        querySelector: () => null,
        querySelectorAll: (s: string) => (s === "*" ? [host] : s === "button.save" ? [draft] : []), documentElement: {}, body: {},
      },
      [BINDING]: (m: string) => reports.push(JSON.parse(m)),
      ResizeObserver: Obs, IntersectionObserver: Obs, MutationObserver: Obs,
      requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {},
      addEventListener() {}, removeEventListener() {}, visualViewport: undefined,
    };
    const found = new Function("env", `with (env) { return ${observerSource({ again: { selector: "button.save" }, text: "Publish" })} }`)(env);
    expect(found).toBe(true);
  });
});
