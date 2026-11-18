/*
 * The terminal is one surface.
 *
 * The chrome wore the phone's palette and the pane the desk's, so on a light
 * phone the header and key bar were light around a dark pane — a seam across
 * the one screen people sit on. Everything the pane screen draws itself reads
 * the pane's palette (`K`); the sheets over it are the app's and keep `C`.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../app/(tabs)/terminal.tsx", import.meta.url)).text();
const bar = await Bun.file(new URL("../src/nav/TabBar.tsx", import.meta.url)).text();

const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/[^\n]*/g, "");

describe("one surface", () => {
  test("the pane screen draws nothing in the phone's palette before its sheets", () => {
    const start = src.indexOf("const K = paneColours;");
    const sheets = src.search(/<ThisWindowSheet\s+more=\{more\}/);
    expect(start).toBeGreaterThan(-1);
    expect(sheets).toBeGreaterThan(start);
    const drawn = code(src.slice(start, sheets));
    const phone = drawn.match(/\bC\.(bg\d?|text\d?|border\d?|primary|error|warning|success|info)\b/g) ?? [];
    expect(phone, "chrome in the phone's palette puts the seam back").toEqual([]);
  });

  test("and the bar under it wears the same colours while it is the destination", () => {
    expect(src).toContain("setTerminalPalette(K)");
    expect(bar).toMatch(/const K = here === "terminal" && desk \? desk : C;/);
  });
});
