/*
 * The boot paint is skipped when it is already stored, not when it was merely
 * written once.
 *
 * writeBootPaint remembered the last copy in a module variable and skipped an
 * identical one. `bun test` shares that variable across files, so a file that
 * painted the same theme earlier left the next file's `store.clear()` looking
 * like a copy that was still there: the write was skipped and the test read
 * nothing back (seeded runs of cover.test.ts). The same is true outside tests
 * when site data is cleared under an open window.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";
import { BOOT_PAINT_KEY, bootEntry, writeBootPaint, type BootPaint } from "../src/lib/bootPaint.ts";

const stubGlobal = globalStubs();
let store = new Map<string, string>();
let full = false;
beforeEach(() => {
  store = new Map();
  full = false;
  stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { if (full) throw new Error("quota"); store.set(k, v); },
  });
});

let n = 0;
const paint = (): BootPaint => ({ v: 1, ...bootEntry(`theme-${++n}`, { "--bg": "#101018" }) });

describe("writeBootPaint", () => {
  test("an identical copy that is still stored is skipped", () => {
    const p = paint();
    expect(writeBootPaint(p)).toBe(true);
    expect(writeBootPaint(p)).toBe(false);
  });

  test("an identical copy that was emptied from storage is written again", () => {
    const p = paint();
    expect(writeBootPaint(p)).toBe(true);
    store.clear();
    expect(writeBootPaint(p)).toBe(true);
    expect(JSON.parse(store.get(BOOT_PAINT_KEY)!).id).toBe(p.id);
  });

  test("storage that refuses the write is not asked again for the same copy", () => {
    full = true;
    const p = paint();
    expect(writeBootPaint(p)).toBe(true);
    expect(writeBootPaint(p)).toBe(false);
  });
});
