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
  test("the tile is Strata's card: the picture + 12, a 70 px caption block with its gaps, never narrower than 120", () => {
    expect(tileSize(32)).toEqual({ w: 120, h: 32 + 74 });
    expect(tileSize(64)).toEqual({ w: 120, h: 64 + 74 });
    expect(tileSize(256).w).toBe(272);
    expect(tileSize(256).h).toBe(330);
  });
  test("tiles per line follow the tile", () => {
    expect(tilesPerRow(912, 64)).toBe(7);
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
  const thumb = Bun.file(new URL("../src/components/finder/machine/Thumb.tsx", import.meta.url)).text();
  const col = Bun.file(new URL("../src/components/finder/machine/Column.tsx", import.meta.url)).text();
  test("only through isThumbable, lazily, and falls back to the icon when the picture fails", async () => {
    const s = await src;
    expect(s).toContain("isThumbable(");
    const t = await thumb;
    expect(t).toContain('loading="lazy"');
    expect(t).toContain("onError");
    expect(t).toContain("fallback");
  });
  test("a column row draws it too, at 17 px, for a file and never for a folder or a locked one", async () => {
    const c = await col;
    expect(c).toContain("const ROW_THUMB = 17;");
    expect(c).toContain("!r.locked && !dir && isThumbable(r.name)");
  });
});
