import { describe, expect, test } from "bun:test";
import {
  LITELLM_PRICING_URL,
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

/*
 * An absent cache rate is the common case, not the exception: in the catalogue
 * as it stands, 843 rows price a discounted read and no write (OpenAI's and
 * Gemini's shape) and 1,971 price neither. Reading those as free replaced rates
 * verified by hand with zero, understated every cached turn on those models,
 * and — because the rebuild insight prices `cache_write - cache_read` — made
 * that card disappear for them.
 */
describe("a cache rate the catalogue does not give", () => {
  test("falls back to the input rate, which is the floor a cache write can cost", () => {
    const mapped = mapLiteLlmPricing({
      "openai/gpt-shape": {
        input_cost_per_token: 0.000_00125,
        output_cost_per_token: 0.000_01,
        cache_read_input_token_cost: 0.000_000_125,
      },
      "vendor/no-caching-at-all": {
        input_cost_per_token: 0.000_000_15,
        output_cost_per_token: 0.000_000_6,
      },
    });

    expect(mapped.get("openai/gpt-shape")).toMatchObject({ input: 1.25, cache_write: 1.25, cache_read: 0.125 });
    expect(mapped.get("vendor/no-caching-at-all")).toMatchObject({ cache_write: 0.15, cache_read: 0.15 });
  });

  test("an explicit zero is meant and is kept", () => {
    const mapped = mapLiteLlmPricing({
      "vendor/free-writes": {
        input_cost_per_token: 0.000_001,
        output_cost_per_token: 0.000_002,
        cache_creation_input_token_cost: 0,
        cache_read_input_token_cost: 0,
      },
    });

    expect(mapped.get("vendor/free-writes")).toMatchObject({ cache_write: 0, cache_read: 0 });
  });

  test("a rate that is present and nonsense still drops the model", () => {
    expect(mapLiteLlmPricing({
      "vendor/negative-cache": {
        input_cost_per_token: 0.000_001,
        output_cost_per_token: 0.000_002,
        cache_read_input_token_cost: -1,
      },
    }).size).toBe(0);
  });
});

/*
 * egress.ts is the one place that answers "may this process talk to that host".
 * This read goes through it — not because the constant needs the opt-in today,
 * but so that editing the constant cannot quietly route the fetch somewhere
 * that meets no gate at all.
 */
describe("the refresh asks the egress boundary first", () => {
  test("the catalogue URL is the trusted host, and it is reached", async () => {
    const catalog = new PricingCatalog(PRICE_TABLE);
    let asked: string | URL | Request | null = null;
    const ok = await refreshLiteLlmPricing(catalog, async (url) => {
      asked = url;
      return new Response(JSON.stringify(remoteRows()));
    });

    expect(ok).toBe(true);
    expect(String(asked)).toBe(LITELLM_PRICING_URL);
  });

  test("it is refused where AGENTGLASS_ALLOW_REMOTE would be needed and is absent", async () => {
    const catalog = new PricingCatalog(PRICE_TABLE);
    // The guard reads process.env at call time, so a URL off the trusted host is
    // the way to exercise the refusal without editing the environment.
    const { outboundDestination } = await import("../src/egress.ts");
    const refused = outboundDestination("https://example.invalid/prices.json", "test", [], {});

    expect(refused.ok).toBe(false);
    expect(catalog.provenance().source).toBe("bundled");
  });
});
