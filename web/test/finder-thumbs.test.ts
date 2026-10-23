/*
 * Icons view draws a real thumbnail for an image, at Strata's size scale
 * (32 to 256, 64 by default). The size decides the tile, and the tile decides
 * how many fit in a line, which the arrow keys walk.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_PREFS, THUMB_DEFAULT, THUMB_MAX, THUMB_MIN, isThumbable, readPrefs, tileSize, tilesPerRow } from "../src/lib/finderMiller.ts";

describe("thumbnail size", () => {
  test("Strata's scale and default", () => {
    expect([THUMB_MIN, THUMB_DEFAULT, THUMB_MAX]).toEqual([32, 64, 256]);
    expect(DEFAULT_PREFS.thumb).toBe(64);
  });
  test("a stored size is clamped, and a wrong type is the default", () => {
    expect(readPrefs(JSON.stringify({ thumb: 9999 })).thumb).toBe(256);
    expect(readPrefs(JSON.stringify({ thumb: 3 })).thumb).toBe(32);
    expect(readPrefs(JSON.stringify({ thumb: "big" })).thumb).toBe(64);
    expect(readPrefs(JSON.stringify({ thumb: 100.4 })).thumb).toBe(100);
  });
  test("the tile grows with the picture and never below the old 112 × 92", () => {
    expect(tileSize(32)).toEqual({ w: 112, h: 92 });
    expect(tileSize(64)).toEqual({ w: 112, h: 108 });
    expect(tileSize(256).w).toBe(288);
    expect(tileSize(256).h).toBe(300);
  });
  test("tiles per line follow the tile", () => {
    expect(tilesPerRow(912, 64)).toBe(8);
    expect(tilesPerRow(912, 256)).toBe(3);
    expect(tilesPerRow(10, 256)).toBe(1);
  });
});

describe("which files get a thumbnail", () => {
  test("pictures a browser draws itself", () => {
    for (const n of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.avif", "g.bmp", "h.svg", "i.ico"]) expect(isThumbable(n)).toBe(true);
  });
  test("not what it cannot: raw, tiff, heic, text, no extension, a dotfile", () => {
    for (const n of ["a.heic", "b.tiff", "c.txt", "d", ".png", "e.pdf"]) expect(isThumbable(n)).toBe(false);
  });
});

describe("the Icons view draws it", () => {
  const src = Bun.file(new URL("../src/components/finder/machine/FolderViews.tsx", import.meta.url)).text();
  test("only through isThumbable, lazily, and falls back to the icon when the picture fails", async () => {
    const s = await src;
    expect(s).toContain("isThumbable(");
    expect(s).toContain('loading="lazy"');
    expect(s).toContain("onError");
  });
});
