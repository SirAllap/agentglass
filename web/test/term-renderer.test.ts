// The renderer choice: WebGL is fast but blanks the terminal white on some
// Linux GPU/compositor stacks, so "auto" defaults to DOM on Linux and WebGL
// elsewhere, and an explicit choice always wins. These pin that decision table
// down by faking navigator.userAgent and localStorage.
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

import { rendererPref, setRendererPref, wantsWebgl, RENDERER_KEY } from "../src/lib/termRenderer.ts";

const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Electron";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 Chrome/120";
const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120";

beforeEach(() => { store = {}; });

test("auto defaults to the DOM renderer on Linux (where the white-out lives)", () => {
  mockEnv(LINUX);
  expect(wantsWebgl()).toBe(false);
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
