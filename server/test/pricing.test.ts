// Pricing matcher + cost math. Pure functions, no I/O.
// Covers wishlist item from #10: model-name substring matching,
// cache rates, and unknown models falling back without NaN.
import { describe, expect, test } from "bun:test";
import { costUsd, modelLabel, priceFor, DEFAULT_PRICE } from "../src/pricing.ts";

describe("priceFor", () => {
  test("matches Anthropic family names case-insensitively", () => {
    expect(priceFor("claude-sonnet-4")?.label).toBe("Sonnet");
    expect(priceFor("Claude-Opus-4.5")?.label).toBe("Opus");
    expect(priceFor("claude-3-5-haiku-latest")?.label).toBe("Haiku");
  });

  test("the premium Claude tiers are priced apart from Opus", () => {
    // Both are $10/$50 rather than Opus's $5/$25, and neither name contains
    // "opus"/"sonnet"/"haiku", so a missing row would silently fall through to
    // DEFAULT_PRICE and under-report the cost by ~3x rather than fail.
    expect(priceFor("claude-fable-5")?.label).toBe("Fable");
    expect(priceFor("claude-mythos-5")?.label).toBe("Mythos");
    expect(priceFor("claude-mythos-5")?.input).toBe(10);
    expect(priceFor("claude-mythos-5")?.output).toBe(50);
  });

  test("more specific OpenAI fragments win over generic ones", () => {
    expect(priceFor("gpt-4o-mini")?.label).toBe("GPT-4o mini");
    expect(priceFor("chatgpt-4o-latest")?.label).toBe("GPT-4o");
    expect(priceFor("o4-mini-2025")?.label).toBe("o-mini");
  });

  test("Gemini pro variants beat generic flash/gemini match", () => {
    expect(priceFor("gemini-2.5-pro")?.label).toBe("Gemini Pro");
    expect(priceFor("gemini-2.0-flash-lite")?.label).toBe("Gemini Flash-Lite");
    expect(priceFor("gemini-2.0-flash")?.label).toBe("Gemini Flash");
  });

  test("Kimi K3 aliases use Moonshot's published API rates", () => {
    for (const model of ["k3", "kimi-k3", "kimi-code/k3"]) {
      expect(priceFor(model)).toMatchObject({
        label: "K3",
        input: 3,
        output: 15,
        cache_read: 0.3,
      });
    }
    expect(priceFor("task3-custom-model")).toBeNull();
  });

  // K3's rate is flat across its whole window, so a context suffix is the same
  // model at the same price. It used to be spelled out one window at a time
  // here while providerOf and modelLabelOf already took any suffix, so a name
  // could read "Moonshot / K3" in the UI and still be billed at the fallback.
  test("a K3 context suffix is the same model, not an unknown one", () => {
    for (const model of ["k3[1m]", "k3[512k]", "K3[1M]"]) {
      expect(priceFor(model)?.label).toBe("K3");
      expect(priceFor(model)).toBe(priceFor("k3"));
    }
  });

  test("unknown and empty model names return null", () => {
    expect(priceFor(null)).toBeNull();
    expect(priceFor(undefined)).toBeNull();
    expect(priceFor("")).toBeNull();
    expect(priceFor("totally-made-up-model-xyz")).toBeNull();
  });
});

describe("costUsd", () => {
  test("uses matched model rates for input/output tokens", () => {
    // Sonnet: input 3 / output 15 per MTok
    const cost = costUsd({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, "claude-sonnet-4");
    expect(cost).toBe(3 + 15);
  });

  test("applies cache_write and cache_read rates", () => {
    // Haiku: cache_write 1.25, cache_read 0.1 per MTok
    const cost = costUsd(
      { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 1_000_000, cache_read_tokens: 1_000_000 },
      "claude-3-5-haiku",
    );
    expect(cost).toBeCloseTo(1.25 + 0.1, 10);
  });

  test("prices Kimi cache misses, cache hits, and output separately", () => {
    const cost = costUsd(
      {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_creation_tokens: 1_000_000,
        cache_read_tokens: 1_000_000,
      },
      "kimi-k3",
    );
    expect(cost).toBeCloseTo(3 + 15 + 3 + 0.3, 10);
  });

  test("unknown model falls back to DEFAULT_PRICE, never NaN", () => {
    const cost = costUsd({ input_tokens: 1_000_000, output_tokens: 0 }, "no-such-model");
    expect(Number.isFinite(cost)).toBe(true);
    expect(Number.isNaN(cost)).toBe(false);
    expect(cost).toBe(DEFAULT_PRICE.input);
  });

  test("MiniMax M3 and M2.7 are priced at their standard rates, not the doubled ones", () => {
    // $0.60/$2.40 is the trap here, and it is a plausible one: it is M3's
    // long-context rate (the whole request doubles past 512K input tokens) AND
    // the price of the `-highspeed` M2.7 variant, so it turns up next to these
    // models often enough to look like the headline number. Every other row in
    // this table quotes the standard rate, and a table that quoted the ceiling
    // for one vendor would report twice the real spend on ordinary turns.
    for (const id of ["MiniMax-M3", "MiniMax-M2.7"]) {
      expect(priceFor(id), id).toMatchObject({
        input: 0.3,
        output: 1.2,
        cache_write: 0.375,
        cache_read: 0.06,
      });
    }
    expect(priceFor("MiniMax-M3")?.label).toBe("MiniMax M3");
    expect(priceFor("MiniMax-M2.7")?.label).toBe("MiniMax M2.7");
  });

  test("a MiniMax model this table has not met is still priced as MiniMax", () => {
    // shared/models.ts labels any `minimax` id "MiniMax", so without the
    // catch-all row the next model out of that vendor would read as a named
    // MiniMax model charged at DEFAULT_PRICE — $3/$15, ten times over. The
    // catch-all has to stay LAST of the three, which is what the labels assert:
    // hoisted above them it would swallow M3 and M2.7 too.
    expect(priceFor("MiniMax-M4-preview")).toMatchObject({ label: "MiniMax", input: 0.3, output: 1.2 });
    expect(priceFor("minimax-text-01")?.label).toBe("MiniMax");
    expect(priceFor("MiniMax-M3")?.label).toBe("MiniMax M3");
    expect(priceFor("MiniMax-M2.7")?.label).toBe("MiniMax M2.7");
  });

  test("MiniMax cost math sums each token class at its own rate", () => {
    const cost = costUsd(
      {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_creation_tokens: 1_000_000,
        cache_read_tokens: 1_000_000,
      },
      "MiniMax-M3",
    );
    expect(cost).toBeCloseTo(0.3 + 1.2 + 0.375 + 0.06, 10);
  });

  test("missing usage fields count as zero", () => {
    expect(costUsd({}, "claude-sonnet-4")).toBe(0);
    expect(costUsd({ input_tokens: 0 }, null)).toBe(0);
  });
});

describe("modelLabel", () => {
  test("returns table label when matched, otherwise the raw name", () => {
    expect(modelLabel("claude-opus-4")).toBe("Opus");
    expect(modelLabel("custom-finetune-xyz")).toBe("custom-finetune-xyz");
    expect(modelLabel(null)).toBe("unknown");
  });
});
