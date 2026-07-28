/*
 * A price row is reached by substring, and "gpt-5" is a substring of every
 * GPT-5 variant there is. That makes ORDER the load-bearing property of this
 * part of the table, and ordering bugs are silent: the wrong row still returns
 * a number, the cost still renders, and nothing anywhere says it is the wrong
 * model's rate.
 *
 * This is not a restatement of the table. Each case below is a model id an
 * agent actually reports, checked against the rate its own vendor page gives
 * it — so a row inserted in the wrong place, or a `match` widened by one
 * character, fails here rather than in somebody's monthly total.
 *
 * Rates last verified 2026-07-28 against developers.openai.com's per-model
 * pages and BerriAI/litellm's model_prices_and_context_window.json, which
 * agreed on every value below.
 */
import { describe, expect, test } from "bun:test";
import { priceFor, costUsd } from "../src/pricing.ts";

/** [model id as reported, input, output, cache read] per 1M tokens. */
const RATES: [string, number, number, number][] = [
  // The regression. gpt-5 lived in the GPT-4.1 row at 2/8/0.5.
  ["gpt-5", 1.25, 10, 0.125],
  ["gpt-5-2025-08-07", 1.25, 10, 0.125],
  ["gpt-5-codex", 1.25, 10, 0.125], // what Codex CLI reports
  ["gpt-5-chat-latest", 1.25, 10, 0.125],
  ["gpt-5-mini", 0.25, 2, 0.025],
  ["gpt-5-nano", 0.05, 0.4, 0.005],
  ["gpt-5-pro", 15, 120, 0],
  // Every one of these contains "gpt-5", and each needs its own row to win.
  ["gpt-5.1", 1.25, 10, 0.125],
  ["gpt-5.1-codex-max", 1.25, 10, 0.125],
  ["gpt-5.1-codex-mini", 0.25, 2, 0.025],
  ["gpt-5.2", 1.75, 14, 0.175],
  ["gpt-5.2-pro", 21, 168, 0],
  ["gpt-5.3-codex", 1.75, 14, 0.175],
  ["gpt-5.4", 2.5, 15, 0.25],
  ["gpt-5.4-mini", 0.75, 4.5, 0.075],
  ["gpt-5.4-nano", 0.2, 1.25, 0.02],
  ["gpt-5.4-pro", 30, 180, 3],
  ["gpt-5.5", 5, 30, 0.5],
  ["gpt-5.5-pro", 30, 180, 3],
  ["gpt-5.6", 5, 30, 0.5],
  ["gpt-5.6-sol", 5, 30, 0.5],
  ["gpt-5.6-terra", 2.5, 15, 0.25],
  ["gpt-5.6-luna", 1, 6, 0.1],
  // The o-series split: o3-mini reads cache at half its input, the others at
  // a quarter. One shared row averaged that away.
  ["o3-mini", 1.1, 4.4, 0.55],
  ["o4-mini", 1.1, 4.4, 0.275],
  ["o3", 2, 8, 0.5],
  ["o3-pro", 20, 80, 0],
  // Untouched, and here so a reordering that breaks them is caught too.
  ["gpt-4.1", 2, 8, 0.5],
  ["gpt-4o", 2.5, 10, 1.25],
  ["gpt-4o-mini", 0.15, 0.6, 0.075],
];

describe("OpenAI rates resolve to the right row", () => {
  for (const [id, input, output, cache_read] of RATES) {
    test(id, () => {
      const p = priceFor(id);
      expect(p, `${id} matched no row — it now bills at DEFAULT_PRICE, which is Sonnet's rate`).not.toBeNull();
      expect({ input: p!.input, output: p!.output, cache_read }).toEqual({ input, output, cache_read });
      expect(p!.cache_read).toBe(cache_read);
    });
  }

  test("no GPT-5 id falls through to the GPT-4.1 row", () => {
    // The specific shape of the original bug, stated as itself: every id above
    // that starts with gpt-5 must land somewhere whose label says GPT-5.
    for (const [id] of RATES.filter(([i]) => i.startsWith("gpt-5"))) {
      expect(priceFor(id)!.label, `${id} is priced as ${priceFor(id)!.label}`).toContain("GPT-5");
    }
  });
});

describe("cache writes", () => {
  test("are free before the 5.6 family and charged after it", () => {
    // Not a rounding detail: OpenAI genuinely did not bill cache creation until
    // 5.6, which charges 1.25x the uncached input rate. A zero on the older
    // rows is a fact about the model; a zero on 5.6 would be lost money.
    for (const id of ["gpt-5", "gpt-5.5", "gpt-4o", "o3"]) {
      expect(priceFor(id)!.cache_write, `${id} should not bill cache writes`).toBe(0);
    }
    for (const id of ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      const p = priceFor(id)!;
      expect(p.cache_write, `${id} bills cache writes at 1.25x input`).toBeCloseTo(p.input * 1.25, 6);
    }
  });
});

describe("what the correction is worth", () => {
  test("a GPT-5 turn no longer costs what a GPT-4.1 turn would", () => {
    // A real shape: 200k in, 20k out, 800k read from cache — one long session.
    const usage = { input_tokens: 200_000, output_tokens: 20_000, cache_read_tokens: 800_000 };
    const now = costUsd(usage, "gpt-5");
    // What the old row charged: 2 / 8 / 0.5.
    const before = (200_000 * 2 + 20_000 * 8 + 800_000 * 0.5) / 1e6;
    expect(before).toBeCloseTo(0.96, 6);
    expect(now).toBeCloseTo(0.55, 6);
    // Not a rounding difference — the old number was nearly double.
    expect(before / now).toBeGreaterThan(1.7);
  });
});
