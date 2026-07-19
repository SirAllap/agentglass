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

  test("unknown model falls back to DEFAULT_PRICE, never NaN", () => {
    const cost = costUsd({ input_tokens: 1_000_000, output_tokens: 0 }, "no-such-model");
    expect(Number.isFinite(cost)).toBe(true);
    expect(Number.isNaN(cost)).toBe(false);
    expect(cost).toBe(DEFAULT_PRICE.input);
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
