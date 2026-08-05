// The renderer choice: WebGL is fast but blanks the terminal white on some
// Linux GPU/compositor stacks, so "auto" turns it off on Linux (canvas takes
// over) and keeps it elsewhere, and an explicit choice always wins. A lost GL
// context drops to canvas — not DOM — so nobody who hit the white-out once is
// stranded on the slow renderer. These pin that table down by faking
// navigator.userAgent and localStorage.
import { test, expect, beforeEach } from "bun:test";

let store: Record<string, string> = {};
function mockEnv(userAgent: string) {
  Object.defineProperty(globalThis, "navigator", { value: { userAgent }, configurable: true });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    },
  });
}

import { rendererPref, setRendererPref, wantsWebgl, wantsCanvas, fallBackToCanvas, __resetRendererSession, RENDERER_KEY } from "../src/lib/termRenderer.ts";

const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Electron";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 Chrome/120";
const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120";

beforeEach(() => { store = {}; __resetRendererSession(); });

test("auto turns WebGL off on Linux (canvas takes over, not DOM)", () => {
  mockEnv(LINUX);
  expect(wantsWebgl()).toBe(false);
  expect(wantsCanvas()).toBe(true); // the fast renderer, not the DOM last resort
});

test("auto keeps WebGL on macOS and Windows", () => {
  mockEnv(MAC); expect(wantsWebgl()).toBe(true);
  mockEnv(WIN); expect(wantsWebgl()).toBe(true);
});

test("an explicit GPU choice forces WebGL, even on Linux", () => {
  mockEnv(LINUX); setRendererPref("gpu");
  expect(wantsWebgl()).toBe(true);
});

test("an explicit Compatibility choice forces DOM, even on macOS", () => {
  mockEnv(MAC); setRendererPref("dom");
  expect(wantsWebgl()).toBe(false);
});

test("the legacy \"off\" value still reads as the DOM renderer", () => {
  mockEnv(MAC); store[RENDERER_KEY] = "off";
  expect(rendererPref()).toBe("dom");
  expect(wantsWebgl()).toBe(false);
});

test("choosing Auto clears the key so the platform default applies again", () => {
  mockEnv(MAC); setRendererPref("dom");
  expect(rendererPref()).toBe("dom");
  setRendererPref("auto");
  expect(rendererPref()).toBe("auto");
  expect(wantsWebgl()).toBe(true); // back to the macOS default
});

test("an explicit Canvas choice turns WebGL off and canvas on, anywhere", () => {
  mockEnv(MAC); setRendererPref("canvas");
  expect(rendererPref()).toBe("canvas");
  expect(wantsWebgl()).toBe(false);
  expect(wantsCanvas()).toBe(true);
});

test("a lost GL context falls back to canvas, not DOM, and remembers it", () => {
  // On macOS, auto is WebGL; a context loss must not strand the shell on the
  // slow DOM renderer — it drops to canvas, and persists canvas.
  mockEnv(MAC);
  expect(wantsWebgl()).toBe(true);
  fallBackToCanvas();
  expect(wantsWebgl()).toBe(false);      // off the GPU this session
  expect(wantsCanvas()).toBe(true);      // …onto canvas, the fast one
  expect(store[RENDERER_KEY]).toBe("canvas"); // and never "dom"
  expect(rendererPref()).toBe("canvas");
});

test("Compatibility still forces DOM — canvas does not override an explicit DOM", () => {
  mockEnv(LINUX); setRendererPref("dom");
  expect(wantsWebgl()).toBe(false);
  expect(wantsCanvas()).toBe(false); // the user asked for DOM; honour it
});
