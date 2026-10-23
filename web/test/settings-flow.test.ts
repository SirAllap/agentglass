import { describe, expect, test } from "bun:test";
import { GAP, placeFlow } from "../src/lib/settingsFlow.ts";

const card = (h: number) => ({ h, wide: false });

/** Place like the hook: remember each card's column the first time and pass it back. */
function settle(hs: number[], cols: number, memo: (number | undefined)[] = []) {
  const slots = placeFlow(hs.map((h, i) => ({ h, wide: false, col: memo[i] })), cols);
  slots.forEach((s, i) => { memo[i] = s.col as number; });
  return slots;
}

describe("placeFlow: balanced, then stable columns", () => {
  test("at mount a tall card gets a column to itself, the short ones share the other", () => {
    const s = settle([1900, 300, 300, 300, 300], 2);
    expect(s.map((x) => x.col)).toEqual([1, 2, 2, 2, 2]);
    // Round robin would have given [1, 2, 1, 2, 1]: 2500 against 600.
  });
  test("a card growing later never moves another card to a different column", () => {
    const memo: (number | undefined)[] = [];
    const before = settle([100, 400, 100, 100, 250], 2, memo).map((s) => s.col);
    const after = settle([1500, 400, 100, 100, 250], 2, memo).map((s) => s.col);
    expect(after).toEqual(before);
  });
  test("a card added later takes the shortest column", () => {
    const memo: (number | undefined)[] = [];
    settle([900, 100], 2, memo);
    expect(settle([900, 100, 200], 2, memo)[2]!.col).toBe(2);
  });
  test("a card that grows pushes down only what is under it in its own column", () => {
    const memo: (number | undefined)[] = [];
    const a = settle([100, 100, 100, 100], 2, memo);
    const b = settle([500, 100, 100, 100], 2, memo);
    expect(b[1]).toEqual(a[1]);
    expect(b[3]).toEqual(a[3]);
    expect(b[2]!.row).toBe(a[2]!.row + 400);
    expect(b[0]!.span).toBe(500);
  });
  test("a wide card spans every column and starts under the tallest", () => {
    const s = placeFlow([card(100), card(300), { h: 50, wide: true }, card(10)], 2);
    expect(s[2]).toEqual({ col: "all", row: 301, span: 50 });
    expect(s[3]).toMatchObject({ col: 1, row: 351 });
  });
  test("a dominating card gets its own column wherever it sits in the page order", () => {
    // Page order A, B, C with C the 1373px one: greedy-in-order stacked B and C (1962 against 773).
    const s = settle([773, 389, 1373], 2);
    expect(s.map((x) => x.col)).toEqual([2, 2, 1]);
    const bottom = (c: number) => Math.max(...s.filter((x) => x.col === c).map((x) => x.row - 1 + x.span));
    expect(Math.abs(bottom(1) - bottom(2))).toBeLessThan(300);
  });
  test("opening a card above a wide one moves only the wide card and what is under it, never the other column's cards above it", () => {
    const memo: (number | undefined)[] = [];
    const items = (h0: number) => [h0, 300, 200, 250].map((h, i) => ({ h, wide: i === 2, col: memo[i] }));
    const a = placeFlow(items(100), 2); a.forEach((x, i) => { memo[i] = x.col as number; });
    const b = placeFlow(items(500), 2);
    expect(b[1]).toEqual(a[1]);
    expect(b[2]!.row).toBeGreaterThan(a[2]!.row - 1);
    expect(b[3]!.row - a[3]!.row).toBe(b[2]!.row - a[2]!.row);
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
  // One gap, one number: the span's gap, the grid's column gap and the margin the
  // column takes back all read the same token.
  expect(GAP).toBe(18);
  expect(css).toMatch(/--agx-gap: 18px/);
  expect(css).toMatch(/\.agx-settings-col\[data-stable\] \{[^}]*column-gap: var\(--agx-gap\)/);
  expect(css).toMatch(/margin-bottom: calc\(-1 \* var\(--agx-gap\)\)/);
});
