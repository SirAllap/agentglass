/*
 * The bench's tab strip was clipped at the top or bottom depending on where the
 * panel sat: the strip's scroller (overflow-x forces overflow-y to clip) was
 * shorter than a 28px button plus its 1px border, and a percentage rect put the
 * panel on fractional pixels. Source assertions: web/ has no DOM harness.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/bench/FloatingBench.tsx", import.meta.url), "utf8");

test("the strip and every tab take their height from HIT", () => {
  expect(src).toContain('import { HIT, ICON } from "../../lib/iconSize.ts"');
  expect(src).toContain("overflow-x-auto agx-scroll\" style={{ height: HIT }}");
  expect((src.match(/height: HIT, background/g) ?? []).length).toBe(2);
  expect(src).not.toContain("height: 28");
});

test("a tab does not clip itself", () => {
  expect(src).not.toContain("shrink-0 flex items-center rounded-md overflow-hidden");
});

test("the bench rect is rounded to whole pixels", () => {
  expect(src).toContain("round(${pct}%, 1px)");
  for (const k of ["x", "y", "w", "h"]) expect(src).toContain(`wholePx(st.geom.${k})`);
  expect(src).not.toMatch(/`\$\{st\.geom\.[xywh]\}%`/);
});
