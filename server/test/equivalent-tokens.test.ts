/*
 * One comparable number instead of four kinds of token — #298.
 *
 * A token is not a token. On Opus an output token costs five uncached input
 * tokens, a cache write costs 1.25 and a cache read costs a tenth — a spread of
 * fifty to one inside a single figure the UI has been calling "tokens". Adding
 * them up gives a number that is not comparable between two sessions, and the
 * error does not even point one way: a cache-heavy session looks enormous and
 * is cheap.
 *
 * The assertion that matters is the identity — weighted tokens times the base
 * input rate is exactly the cost — and it is asserted over the whole price
 * table rather than over the two models somebody thought of, because a row
 * added next month is where this would quietly stop being true.
 */
import { describe, expect, test } from "bun:test";
import { costUsd, equivalentTokens, weightsFor, weightsFromPrice, priceFor, PRICE_TABLE, DEFAULT_PRICE } from "../src/pricing.ts";

const usage = { input_tokens: 10_000, output_tokens: 2_000, cache_creation_tokens: 5_000, cache_read_tokens: 400_000 };

describe("the weights", () => {
  test("input is the unit, so it does not appear", () => {
    // Everything is expressed *in* uncached input tokens. A weight for input
    // would be 1 by construction and an invitation to set it to something else.
    expect(Object.keys(weightsFor("claude-opus-4.5")).sort()).toEqual(["cache_read", "cache_write", "output"]);
  });

  test("are ratios, so they survive a table where every rate is doubled", () => {
    // The point of the unit: it says something about the *shape* of the usage,
    // not about what a provider is charging this week. Cost moves with prices;
    // this does not.
    const opus = weightsFor("claude-opus-4.5");
    expect(opus.output).toBe(5);        // $25 output over $5 input
    expect(opus.cache_write).toBe(1.25);
    expect(opus.cache_read).toBe(0.1);
  });

  test("and a cache read really is a tenth, not a tenth of a percent", () => {
    // The whole reason the raw sum misleads: 400k cache reads are 40k
    // input-equivalents, so a session that reads a big context every turn is
    // not the monster the token count makes it look.
    expect(equivalentTokens({ cache_read_tokens: 400_000 }, "claude-opus-4.5")).toBe(40_000);
  });

  test("a model with no rate at all is weighted like the fallback, not like nothing", () => {
    // `costUsd` already falls back to DEFAULT_PRICE for an unknown model, and
    // the two must agree or the identity below breaks for exactly the rows
    // where somebody is most likely to be surprised.
    expect(priceFor("some-model-nobody-has-heard-of")).toBeNull();
    expect(weightsFor("some-model-nobody-has-heard-of"))
      .toEqual({ output: DEFAULT_PRICE.output / DEFAULT_PRICE.input,
                 cache_write: DEFAULT_PRICE.cache_write / DEFAULT_PRICE.input,
                 cache_read: DEFAULT_PRICE.cache_read / DEFAULT_PRICE.input });
  });
});

describe("the identity, over the whole table", () => {
  test("weighted tokens times the base input rate is the cost", () => {
    /*
     * What makes the number worth leading with: it converts to money with one
     * multiplication, so it is not a second, differently-wrong figure sitting
     * beside the cost. Asserted for every priced row, because a row added next
     * month with a rate structure nobody anticipated is exactly where this
     * would quietly stop holding.
     */
    for (const p of PRICE_TABLE) {
      const model = p.exact?.[0] ?? p.match[0]!;
      if (!(p.input > 0)) continue; // a free model has no base to express anything in
      const equiv = equivalentTokens(usage, model);
      const viaWeights = (equiv * p.input) / 1_000_000;
      const direct = costUsd(usage, model);
      // Rounded to whole tokens, so the two agree to within one token's worth
      // of the base rate rather than exactly.
      expect(Math.abs(viaWeights - direct), `${p.label} (${model})`).toBeLessThan(p.input / 1_000_000);
    }
  });

  test("and it holds for a model the table has never heard of", () => {
    const equiv = equivalentTokens(usage, "who-knows");
    expect(Math.abs((equiv * DEFAULT_PRICE.input) / 1_000_000 - costUsd(usage, "who-knows")))
      .toBeLessThan(DEFAULT_PRICE.input / 1_000_000);
  });
});

describe("what it refuses to divide by", () => {
  test("a model whose input is free gets weights of one, not Infinity", () => {
    /*
     * There is no base to express anything in when the base is free. Dividing
     * anyway gives Infinity, and `fmtTokens(Infinity)` on the headline is worse
     * than the raw sum this replaces. Falling back to 1 makes the figure the
     * plain token count, which is the honest answer when there is no price to
     * weight by.
     *
     * Not hypothetical: AGENTGLASS_PRICING takes a whole table from the user,
     * and a local model behind an OpenAI-shaped endpoint costs nothing to run.
     */
    expect(weightsFromPrice({ input: 0, output: 0, cache_write: 0, cache_read: 0 }))
      .toEqual({ output: 1, cache_write: 1, cache_read: 1 });
    // …and a hand-written table with a missing or nonsense rate lands here too,
    // rather than producing NaN that formats as "NaN tokens".
    for (const bad of [undefined, null, NaN, -3] as unknown as number[]) {
      const w = weightsFromPrice({ input: bad, output: 15, cache_write: 3.75, cache_read: 0.3 });
      expect(Number.isFinite(w.output), String(bad)).toBe(true);
    }
  });

  test("a zero rate for one class is kept, because only the base is special", () => {
    // gpt-5.2-pro charges nothing for cache writes or reads. Those weights are
    // genuinely zero and must not be swept up by the free-input fallback.
    const w = weightsFor("gpt-5.2-pro");
    expect(w.cache_write).toBe(0);
    expect(w.cache_read).toBe(0);
    expect(w.output).toBeGreaterThan(1);
  });

  test("so a million free cache writes weigh nothing", () => {
    // OpenAI did not charge for cache creation before the 5.6 family. Reading
    // that zero as "unknown, use 1" would invent a million tokens of spend on
    // every GPT-5.x session in the fleet.
    expect(equivalentTokens({ cache_creation_tokens: 1_000_000 }, "gpt-5.4")).toBe(0);
  });

  test("an empty usage is zero, not NaN", () => {
    expect(equivalentTokens({}, "claude-opus-4.5")).toBe(0);
    expect(equivalentTokens({}, null)).toBe(0);
  });
});

describe("what it is not", () => {
  test("it is not the raw sum, and the difference is the whole point", () => {
    // If these ever agree for a cache-heavy usage, the weighting has been
    // removed and nothing else would notice.
    const raw = usage.input_tokens + usage.output_tokens + usage.cache_creation_tokens + usage.cache_read_tokens;
    expect(equivalentTokens(usage, "claude-opus-4.5")).toBeLessThan(raw / 2);
  });

  test("and it is not input+output, which is what the UI showed instead", () => {
    // The old headline dropped cache entirely. On a session that reads a large
    // context every turn, that is most of the money.
    expect(equivalentTokens(usage, "claude-opus-4.5"))
      .toBeGreaterThan(usage.input_tokens + usage.output_tokens);
  });
});
