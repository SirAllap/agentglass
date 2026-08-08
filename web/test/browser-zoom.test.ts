/*
 * Remembering how far the browser is zoomed.
 *
 * The arithmetic is the part worth pinning: Electron's zoom is a LEVEL on a
 * logarithmic ladder and every human-facing number is a percentage, so a
 * mistake here is invisible in code review and obvious on screen. The rest is
 * the storage behaving like the rest of this file's settings — clamped, and
 * unbothered by a value somebody else wrote.
 */
import { describe, expect, test, beforeEach } from "bun:test";

// A real one, in memory: these tests are about what is written and read back,
// so the no-op stub the other suites use would pass while storing nothing.
// Installed before the module under test is imported, since it reads at call
// time but the import itself must not throw.
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
};

const { ZOOM_KEY, ZOOM_MAX, ZOOM_MIN, setZoomLevel, zoomLevel, zoomPercent } = await import("../src/lib/browserPrefs.ts");

beforeEach(() => store.clear());

describe("the zoom level", () => {
  test("100% is level zero, and it is not stored at all", () => {
    expect(zoomLevel()).toBe(0);
    setZoomLevel(0);
    // Nothing written: an entry meaning "the default" is an entry that has to
    // be explained to whoever reads this storage next.
    expect(localStorage.getItem(ZOOM_KEY)).toBeNull();
  });

  test("survives a reload", () => {
    setZoomLevel(2);
    expect(zoomLevel()).toBe(2);
  });

  test("is held to the range the shell enforces", () => {
    setZoomLevel(99);
    expect(zoomLevel()).toBe(ZOOM_MAX);
    setZoomLevel(-99);
    expect(zoomLevel()).toBe(ZOOM_MIN);
  });

  test("a stored value that is not a number reads as not zoomed", () => {
    localStorage.setItem(ZOOM_KEY, "enormous");
    expect(zoomLevel()).toBe(0);
  });

  test("the percentage is Chrome's own ladder", () => {
    // 1.2 per step, which is what Ctrl+plus walks in a real browser.
    expect(zoomPercent(0)).toBe(100);
    expect(zoomPercent(1)).toBe(120);
    expect(zoomPercent(2)).toBe(144);
    expect(zoomPercent(-1)).toBe(83);
    // And the ends of the range are the range people expect to find there.
    expect(zoomPercent(ZOOM_MAX)).toBeGreaterThan(300);
    expect(zoomPercent(ZOOM_MIN)).toBeLessThan(30);
  });
});
