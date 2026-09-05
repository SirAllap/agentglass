// Claude Code's `claude_code.api_request` event, read the way it is written.
//
// Its documented attribute table names the cache buckets bare —
// `cache_read_tokens` / `cache_creation_tokens` — and neither spelling was in
// the mapper's alias lists, which between them accepted nine other names for
// the same two numbers. The failure was invisible for the usual reason: the
// record still landed (the log check accepts anything carrying `event.name`),
// so the session appeared, the model resolved and a turn was counted. Only the
// tokens were missing — and on a Claude Code session the cache buckets ARE the
// token volume, because every turn replays a cached prompt.
//
// The same record also states `cost_usd`, the amount actually charged. Pricing
// it from the local list-rate table instead was the second half of the same
// bug: a real number thrown away and an estimate written in its place.
import { describe, expect, test } from "bun:test";
import { otlpLogsToEvents, otlpTracesToEvents } from "../src/otlp.ts";
import { MAX_REPORTED_COST_USD } from "../src/ingest.ts";

const kv = (key: string, value: string | number) => ({
  key,
  value: typeof value === "number" ? { intValue: value } : { stringValue: value },
});
const dbl = (key: string, value: number) => ({ key, value: { doubleValue: value } });

const logs = (attributes: Array<ReturnType<typeof kv> | ReturnType<typeof dbl>>) => ({
  resourceLogs: [{
    resource: { attributes: [kv("service.name", "claude-code")] },
    scopeLogs: [{
      logRecords: [{
        timeUnixNano: "1700000000000000000",
        attributes,
      }],
    }],
  }],
});

const usageOf = (event: { payload?: Record<string, unknown> }) =>
  event.payload?.usage as Record<string, number>;

describe("the bare cache names are the same numbers as the gen_ai.* ones", () => {
  // The whole point: an exporter using Anthropic's documented spelling must be
  // accounted identically to one using the OpenTelemetry spelling. Two records
  // saying the same thing, compared against each other rather than against a
  // constant, so neither shape can drift alone.
  const BARE = [
    kv("event.name", "claude_code.api_request"),
    kv("session.id", "cc-session"),
    kv("model", "claude-sonnet-4-5-20250929"),
    kv("input_tokens", 4_200),
    kv("output_tokens", 310),
    kv("cache_read_tokens", 3_600),
    kv("cache_creation_tokens", 400),
  ];
  const OFFICIAL = [
    kv("event.name", "gen_ai.client.inference.operation.details"),
    kv("session.id", "cc-session"),
    kv("model", "claude-sonnet-4-5-20250929"),
    kv("gen_ai.usage.input_tokens", 4_200),
    kv("gen_ai.usage.output_tokens", 310),
    kv("gen_ai.usage.cache_read.input_tokens", 3_600),
    kv("gen_ai.usage.cache_creation.input_tokens", 400),
  ];

  test("the two spellings are two different claims, and are read as such", () => {
    /*
     * They deliberately do NOT agree, and an earlier draft of this file
     * asserting that they must was the bug.
     *
     * The bare names are Claude Code's own export, carrying Anthropic's usage
     * object through unchanged — where the input count already has the cache
     * buckets taken out of it. The `gen_ai.usage.*` names come from a
     * third-party instrumentor following the semantic convention, which calls
     * that field the prompt TOTAL. Same numbers on the wire, opposite meanings,
     * so reading them the same way has to be wrong for one of them.
     */
    const [bare] = otlpLogsToEvents(logs(BARE));
    const [official] = otlpLogsToEvents(logs(OFFICIAL));
    expect(usageOf(bare).input_tokens).toBe(4_200);
    expect(usageOf(official).input_tokens).toBe(200); // 4200 - 3600 - 400
    for (const k of ["output_tokens", "cache_read_tokens", "cache_creation_tokens"] as const) {
      expect(usageOf(bare)[k]).toBe(usageOf(official)[k]);
    }
  });

  test("and Anthropic's input count is taken as it is, not as a total to split", () => {
    /*
     * Pinned as a literal too, so "they agree" cannot pass by both being zero.
     *
     * 4200, not 200. Anthropic reports the input count with the cache buckets
     * ALREADY out of it, so subtracting them again deletes the uncached tokens
     * — the ones charged at full rate. A real transcript on the machine this
     * was written on settles it: `input_tokens: 2` sitting next to
     * `cache_read_input_tokens: 22124`. A total cannot be smaller than one of
     * its own parts.
     *
     * Codex reports the opposite way round and test/otlp-codex.ts pins that,
     * which is why the mapper reads the vendor and not the attribute name.
     */
    const [bare] = otlpLogsToEvents(logs(BARE));
    expect(usageOf(bare)).toEqual({
      input_tokens: 4_200,
      output_tokens: 310,
      cache_read_tokens: 3_600,
      cache_creation_tokens: 400,
    });
  });

  test("the turn is a Turn complete on the session the record names", () => {
    const [bare] = otlpLogsToEvents(logs(BARE));
    expect(bare.hook_event_type).toBe("Turn complete");
    expect(bare.session_id).toBe("cc-session");
    expect(bare.model_name).toBe("claude-sonnet-4-5-20250929");
  });

  test("a span using the bare names is read the same way", () => {
    // Traces and logs share one mapper; this is the test that keeps them shared.
    const [event] = otlpTracesToEvents({
      resourceSpans: [{
        resource: { attributes: [kv("service.name", "claude-code")] },
        scopeSpans: [{
          spans: [{
            traceId: "trace-cc-1",
            spanId: "span-cc-1",
            name: "chat",
            startTimeUnixNano: "1700000000000000000",
            endTimeUnixNano: "1700000001000000000",
            attributes: [
              kv("gen_ai.system", "anthropic"),
              kv("input_tokens", 4_200),
              kv("output_tokens", 310),
              kv("cache_read_tokens", 3_600),
              kv("cache_creation_tokens", 400),
            ],
          }],
        }],
      }],
    });
    expect(usageOf(event)).toEqual({
      input_tokens: 4_200,
      output_tokens: 310,
      cache_read_tokens: 3_600,
      cache_creation_tokens: 400,
    });
  });

  test("the gen_ai.* names still win when a record carries both", () => {
    // Order in the alias lists is precedence, and the bare names were appended
    // after the prefixed ones, so nothing that worked before changes.
    const [event] = otlpLogsToEvents(logs([
      kv("event.name", "claude_code.api_request"),
      kv("gen_ai.usage.cache_read.input_tokens", 11),
      kv("cache_read_tokens", 9_999),
      kv("gen_ai.usage.input_tokens", 50),
    ]));
    expect(usageOf(event).cache_read_tokens).toBe(11);
  });
});

describe("a record that states its cost is not re-priced from the table", () => {
  const withCost = (extra: Array<ReturnType<typeof kv> | ReturnType<typeof dbl>>) =>
    otlpLogsToEvents(logs([
      kv("event.name", "claude_code.api_request"),
      kv("session.id", "cc-session"),
      kv("model", "claude-sonnet-4-5-20250929"),
      kv("input_tokens", 4_200),
      kv("output_tokens", 310),
      kv("cache_read_tokens", 3_600),
      kv("cache_creation_tokens", 400),
      ...extra,
    ]))[0];

  test("cost_usd becomes the event's authoritative cost", () => {
    // db.ts prefers reported_cost_usd over costUsd(); carrying it here is how
    // the provider's own figure reaches that branch.
    expect(withCost([dbl("cost_usd", 0.0731)]).reported_cost_usd).toBe(0.0731);
  });

  test("cost_usd_micros is the same number, scaled", () => {
    expect(withCost([kv("cost_usd_micros", 73_100)]).reported_cost_usd).toBe(0.0731);
  });

  test("a record carrying both is charged once, not twice", () => {
    const event = withCost([dbl("cost_usd", 0.0731), kv("cost_usd_micros", 73_100)]);
    expect(event.reported_cost_usd).toBe(0.0731);
  });

  test("an honest zero is a statement, not an absence", () => {
    expect(withCost([dbl("cost_usd", 0)]).reported_cost_usd).toBe(0);
  });

  test("a record with no cost is left to local pricing", () => {
    // The field must be absent, not 0 — 0 would bill a real turn as free.
    const event = withCost([]);
    expect(event.reported_cost_usd).toBeUndefined();
  });

  test("nonsense from an unauthenticated exporter falls back to pricing", () => {
    // /v1/logs is exempt from auth and skips the POST /ingest validation, so
    // the bound has to be enforced here or not at all.
    expect(withCost([dbl("cost_usd", -5)]).reported_cost_usd).toBeUndefined();
    expect(withCost([dbl("cost_usd", MAX_REPORTED_COST_USD + 1)]).reported_cost_usd).toBeUndefined();
    expect(withCost([dbl("cost_usd", Number.NaN)]).reported_cost_usd).toBeUndefined();
  });

  test("a tool record is never given a cost", () => {
    const [event] = otlpLogsToEvents(logs([
      kv("event.name", "claude_code.tool_result"),
      kv("tool_name", "Bash"),
      dbl("cost_usd", 0.05),
    ]));
    expect(event.hook_event_type).toBe("PostToolUse");
    expect(event.reported_cost_usd).toBeUndefined();
  });
});
