/*
 * The usage popover's "Weighted tokens by day" chart arrived a few hundred ms
 * after the rest of the box (it was a fetch fired on mount, and it drew
 * nothing until it answered), so the box grew under the pointer. The strip
 * now owns its height from the first frame in every state, and the state
 * decision is a pure function so it is asserted here rather than by eye.
 */
import { describe, expect, test } from "bun:test";
import { dayCells, stripState, STRIP_HEIGHT } from "../src/lib/dayStrip.ts";
import type { UsageDay } from "../../shared/types.ts";

const day = (d: string, equiv: number): UsageDay =>
  ({ day: d, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, equiv_tokens: equiv }) as UsageDay;
const NOW = Date.parse("2026-09-26T12:00:00Z");

describe("stripState", () => {
  test("no answer yet is loading, an answer with no tokens is empty", () => {
    expect(stripState(null)).toBe("loading");
    expect(stripState([])).toBe("empty");
    expect(stripState([day("2026-09-26", 0)])).toBe("empty");
    expect(stripState([day("2026-09-26", 5)])).toBe("data");
  });
});

describe("dayCells", () => {
  test("always seven slots, oldest first, today last, gaps are zero", () => {
    const cells = dayCells([day("2026-09-26", 9)], NOW);
    expect(cells).toHaveLength(7);
    expect(cells[0]!.key).toBe("2026-09-20");
    expect(cells[6]!.key).toBe("2026-09-26");
    expect(cells[6]!.tokens).toBe(9);
    expect(cells[3]!.tokens).toBe(0);
    expect(dayCells([], NOW)).toHaveLength(7);
  });
});

describe("DayStrip source", async () => {
  const src = await Bun.file(new URL("../src/components/PlanPace.tsx", import.meta.url)).text();
  const start = src.indexOf("export function DayStrip(");
  const body = src.slice(start);
  test("the reserved height is applied and no state returns null after the anthropic check", () => {
    expect(STRIP_HEIGHT).toBeGreaterThan(0);
    expect(body).toContain("STRIP_HEIGHT");
    const afterGuard = body.slice(body.indexOf("if (!wanted) return null"));
    expect(afterGuard.match(/return null/g)?.length).toBe(1);
  });
  test("loading and empty are drawn, and reduced motion is respected", async () => {
    expect(body).toContain('state === "loading"');
    expect(body).toContain('state === "empty"');
    const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
    const at = css.indexOf(".agx-daybar-pulse");
    expect(at).toBeGreaterThan(-1);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)[^}]*\{[^}]*\.agx-daybar-pulse[^}]*animation: none/s);
  });
  test("the fetch is warmed before the popover opens", async () => {
    const top = await Bun.file(new URL("../src/components/TopBar.tsx", import.meta.url)).text();
    expect(top).toContain("warmDayStrip(");
  });
  test("an answer already in hand is not fetched again on every expand of the fold", () => {
    // The fold unmounts and remounts this; `inflight` is cleared once the
    // answer lands, so without the guard each expand was another GET for a
    // chart that changes daily.
    const guard = body.indexOf("if (lastWeek()?.length) return;");
    const warm = body.indexOf("warmDayStrip()");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(warm);
  });
});
