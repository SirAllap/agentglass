/*
 * With the finder open on a file, a click inside the reader and then Ctrl+Shift+P
 * did nothing: the reader stops every key so an arrow scrolls it instead of
 * walking the list behind, and that included the chord the app answers on
 * `window`. Clicking the box again brought the shortcut back. The reader now
 * asks `isAppChord` before it stops a key; these pin the answer and that the
 * reader asks it first.
 */
import { beforeEach, describe, expect, it } from "bun:test";

// keybindings.ts reaches api.ts, which reads `location` at module scope.
(globalThis as unknown as { location: unknown }).location = { hostname: "localhost", origin: "http://localhost:4000" };
const store = new Map<string, string>();
// @ts-expect-error — enough of a localStorage for a module that reads and writes.
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
};

const kb = await import("../src/lib/keybindings.ts");
const palette = await Bun.file(new URL("../src/components/FilePalette.tsx", import.meta.url)).text();

const press = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

beforeEach(() => { store.clear(); kb.resetAppChords(); kb.resetChords(); kb.resetBindings(); });

describe("isAppChord", () => {
  it("counts the palette chord, so the reader lets it reach window", () => {
    expect(kb.isAppChord(press("P", { ctrlKey: true, shiftKey: true }))).toBe(true);
  });
  it("counts the reserved ones (⌘K, zoom)", () => {
    expect(kb.isAppChord(press("k", { ctrlKey: true }))).toBe(true);
    expect(kb.isAppChord(press("=", { ctrlKey: true }))).toBe(true);
  });
  it("follows a rebinding instead of a hard-coded key", () => {
    expect(kb.rebindAppChord("files.palette", "mod+alt+f")).toEqual({ ok: true });
    expect(kb.isAppChord(press("f", { ctrlKey: true, altKey: true }))).toBe(true);
    expect(kb.isAppChord(press("P", { ctrlKey: true, shiftKey: true }))).toBe(false);
  });
  it("leaves the reader's own keys to the reader", () => {
    expect(kb.isAppChord(press("ArrowDown"))).toBe(false);
    expect(kb.isAppChord(press("Escape"))).toBe(false);
    expect(kb.isAppChord(press("/"))).toBe(false);
    // The chords the reader answers itself: find, and the bench.
    expect(kb.isAppChord(press("f", { ctrlKey: true }))).toBe(false);
    expect(kb.isAppChord(press("Enter", { ctrlKey: true }))).toBe(false);
  });
});

describe("the reader", () => {
  it("asks before it stops a key", () => {
    const from = palette.indexOf("onKeyDown={(e) => {\n                  if (e.target instanceof HTMLInputElement) return;");
    expect(from).not.toBe(-1);
    const body = palette.slice(from, palette.indexOf("}}>", from));
    const ask = body.indexOf("isAppChord(e.nativeEvent)");
    const stop = body.indexOf("e.stopPropagation()");
    expect(ask).not.toBe(-1);
    expect(stop).not.toBe(-1);
    expect(ask).toBeLessThan(stop);
  });
});

describe("a menu", () => {
  it("asks before it stops a key, so an app chord works with a menu open", () => {
    const from = palette.indexOf("const menuKeys = (");
    expect(from).not.toBe(-1);
    const body = palette.slice(from, palette.indexOf("\n};", from));
    const ask = body.indexOf("isAppChord(e.nativeEvent)");
    const stop = body.indexOf("e.stopPropagation()");
    expect(ask).not.toBe(-1);
    expect(stop).not.toBe(-1);
    expect(ask).toBeLessThan(stop);
  });
});
