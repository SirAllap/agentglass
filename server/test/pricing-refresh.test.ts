import { describe, expect, test } from "bun:test";
import {
  PRICE_TABLE,
  PricingCatalog,
  mapLiteLlmPricing,
  refreshLiteLlmPricing,
} from "../src/pricing.ts";

function remoteRows(count = 100): Record<string, Record<string, number>> {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [
    `community/model-${i}`,
    {
      input_cost_per_token: (i + 1) / 1_000_000,
      output_cost_per_token: (i + 2) / 1_000_000,
      cache_read_input_token_cost: 0.25 / 1_000_000,
    },
  ]));
}

describe("LiteLLM pricing refresh", () => {
  test("maps only complete, non-negative token rates into exact model prices", () => {
    const mapped = mapLiteLlmPricing({
      "vendor/model": {
        input_cost_per_token: 0.000_003,
        output_cost_per_token: 0.000_015,
        cache_creation_input_token_cost: 0.000_00375,
        cache_read_input_token_cost: 0.000_0003,
      },
      "vendor/missing-output": { input_cost_per_token: 0.000_003 },
      "vendor/negative": { input_cost_per_token: -1, output_cost_per_token: 1 },
    });

    expect(mapped.size).toBe(1);
    expect(mapped.get("vendor/model")).toMatchObject({
      exact: ["vendor/model"],
      input: 3,
      output: 15,
      cache_write: 3.75,
      cache_read: 0.3,
    });
  });

  test("live exact rates win while unmatched models retain bundled fallback", () => {
    const catalog = new PricingCatalog(PRICE_TABLE);
    const mapped = mapLiteLlmPricing(remoteRows());
    mapped.set("claude-sonnet-4", {
      match: [], exact: ["claude-sonnet-4"], label: "claude-sonnet-4",
      input: 4, output: 20, cache_write: 5, cache_read: 0.4,
    });
    catalog.installLive(mapped, "2026-09-07");

    expect(catalog.priceFor("claude-sonnet-4")?.input).toBe(4);
    expect(catalog.priceFor("claude-sonnet-4[1m]")?.output).toBe(20);
    expect(catalog.priceFor("claude-opus-4")?.label).toBe("Opus");
    expect(catalog.provenance()).toEqual({ source: "live", provider: "litellm", updated_at: "2026-09-07" });
  });

  test("a user table remains authoritative even after a live install", () => {
    const user = [{ match: ["private-model"], label: "Private", input: 9, output: 10, cache_write: 0, cache_read: 0 }];
    const catalog = new PricingCatalog(PRICE_TABLE, user, "2026-09-06");
    catalog.installLive(mapLiteLlmPricing(remoteRows()), "2026-09-07");

    expect(catalog.priceFor("private-model-v2")?.label).toBe("Private");
    expect(catalog.priceFor("claude-sonnet-4")).toBeNull();
    expect(catalog.provenance()).toEqual({ source: "user", updated_at: "2026-09-06" });
  });

  test("a failed refresh retains the last complete live catalogue", async () => {
    const catalog = new PricingCatalog(PRICE_TABLE);
    const ok = await refreshLiteLlmPricing(
      catalog,
      async () => new Response(JSON.stringify(remoteRows())),
      Date.parse("2026-09-07T03:00:00Z"),
    );
    const failed = await refreshLiteLlmPricing(
      catalog,
      async () => new Response("unavailable", { status: 503 }),
    );

    expect(ok).toBe(true);
    expect(failed).toBe(false);
    expect(catalog.priceFor("community/model-4")?.input).toBe(5);
    expect(catalog.provenance()).toEqual({ source: "live", provider: "litellm", updated_at: "2026-09-07" });
  });

  test("an incomplete response cannot replace a complete catalogue", () => {
    const catalog = new PricingCatalog(PRICE_TABLE);
    catalog.installLive(mapLiteLlmPricing(remoteRows()), "2026-09-07");

    expect(() => catalog.installLive(mapLiteLlmPricing(remoteRows(99)), "2026-09-08")).toThrow("only 99 usable models");
    expect(catalog.priceFor("community/model-99")?.input).toBe(100);
    expect(catalog.provenance().updated_at).toBe("2026-09-07");
  });

  test("a declared oversized response is refused before it can replace fallback", async () => {
    const catalog = new PricingCatalog(PRICE_TABLE);
    const ok = await refreshLiteLlmPricing(
      catalog,
      async () => new Response(JSON.stringify(remoteRows()), { headers: { "content-length": "6000000" } }),
    );

    expect(ok).toBe(false);
    expect(catalog.provenance().source).toBe("bundled");
    expect(catalog.priceFor("claude-sonnet-4")?.label).toBe("Sonnet");
  });
});
