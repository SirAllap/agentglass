import { describe, expect, test } from "bun:test";
import { placeFlow } from "../src/lib/settingsFlow.ts";

const card = (h: number) => ({ h, wide: false });

describe("placeFlow: stable columns", () => {
  test("a card's column is its position, not the heights around it", () => {
    const before = placeFlow([card(100), card(100), card(100), card(100)], 2).map((s) => s.col);
    // The first card grows (a disclosure opened): nobody changes column.
    const after = placeFlow([card(900), card(100), card(100), card(100)], 2).map((s) => s.col);
    expect(before).toEqual([1, 2, 1, 2]);
    expect(after).toEqual(before);
  });
  test("a card that grows pushes down only what is under it in its own column", () => {
    const a = placeFlow([card(100), card(100), card(100), card(100)], 2);
    const b = placeFlow([card(500), card(100), card(100), card(100)], 2);
    expect(b[1]).toEqual(a[1]);
    expect(b[3]).toEqual(a[3]);
    expect(b[2]!.row).toBe(501);
  });
  test("a wide card spans every column and starts under the tallest", () => {
    const s = placeFlow([card(100), card(300), { h: 50, wide: true }, card(10)], 2);
    expect(s[2]).toEqual({ col: "all", row: 301, span: 50 });
    expect(s[3]).toMatchObject({ col: 1, row: 351 });
  });
  test("one column is a plain stack", () => {
    const s = placeFlow([card(10), card(20)], 1);
    expect(s.map((x) => x.row)).toEqual([1, 11]);
  });
});

test("the page container is wired to the placement", async () => {
  const modal = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url).pathname).text();
  const css = await Bun.file(new URL("../src/index.css", import.meta.url).pathname).text();
  expect(modal).toContain("useStableFlow(colRef,");
  expect(css).toMatch(/\.agx-settings-col\[data-stable\] \{[^}]*display: grid/);
});
