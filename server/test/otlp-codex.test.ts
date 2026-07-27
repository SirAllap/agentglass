// Codex CLI emits OTLP logs with its own stable field names rather than the
// gen_ai.* aliases used by traces. Keep a real response.completed fixture here
// so a telemetry rename cannot silently make Codex sessions disappear.
import { describe, expect, test } from "bun:test";
import { otlpLogsToEvents, otlpTracesToEvents } from "../src/otlp.ts";

const kv = (key: string, value: string | number) => ({
  key,
  value: typeof value === "number" ? { intValue: value } : { stringValue: value },
});

const logs = (attributes: ReturnType<typeof kv>[], serviceName = "codex_cli_rs") => ({
  resourceLogs: [{
    resource: { attributes: [kv("service.name", serviceName)] },
    scopeLogs: [{
      logRecords: [{
        timeUnixNano: "1700000000000000000",
        attributes,
      }],
    }],
  }],
});

describe("Codex OTLP logs", () => {
  test("maps response.completed token fields without charging cached input twice", () => {
    const [event] = otlpLogsToEvents(logs([
      kv("event.kind", "response.completed"),
      kv("conversation.id", "codex-session"),
      kv("model", "gpt-5.1-codex"),
      kv("input_token_count", 1_000),
      kv("output_token_count", 120),
      kv("cached_token_count", 600),
      kv("cache_write_token_count", 50),
    ]));

    expect(event).toBeDefined();
    expect(event.hook_event_type).toBe("Turn complete");
    expect(event.session_id).toBe("codex-session");
    expect(event.payload?.event).toBe("response.completed");
    expect(event.payload?.usage).toEqual({
      input_tokens: 350,
      output_tokens: 120,
      cache_read_tokens: 600,
      cache_creation_tokens: 50,
    });
  });

  test("never produces negative non-cached input when cache counters exceed the total", () => {
    const [event] = otlpLogsToEvents(logs([
      kv("event.kind", "response.completed"),
      kv("input_token_count", 100),
      kv("output_token_count", 1),
      kv("cached_token_count", 120),
      kv("cache_write_token_count", 20),
    ]));
    expect((event.payload?.usage as Record<string, number>).input_tokens).toBe(0);
  });

  test("separates cached input from standard gen_ai totals", () => {
    const [event] = otlpLogsToEvents(logs([
      kv("event.name", "gen_ai.response.completed"),
      kv("gen_ai.system", "openai"),
      kv("gen_ai.usage.input_tokens", 1_000),
      kv("gen_ai.usage.output_tokens", 120),
      kv("gen_ai.usage.cache_read.input_tokens", 600),
      kv("gen_ai.usage.cache_creation.input_tokens", 50),
    ]));
    expect(event.payload?.usage).toEqual({
      input_tokens: 350,
      output_tokens: 120,
      cache_read_tokens: 600,
      cache_creation_tokens: 50,
    });
  });

  test("separates official cache buckets from standard GenAI traces", () => {
    const [event] = otlpTracesToEvents({
      resourceSpans: [{
        resource: { attributes: [kv("service.name", "openai-sdk")] },
        scopeSpans: [{
          spans: [{
            name: "chat",
            startTimeUnixNano: "1000000",
            endTimeUnixNano: "2000000",
            attributes: [
              kv("gen_ai.system", "openai"),
              kv("gen_ai.operation.name", "chat"),
              kv("gen_ai.usage.input_tokens", 1_000),
              kv("gen_ai.usage.output_tokens", 120),
              kv("gen_ai.usage.cache_read.input_tokens", 600),
              kv("gen_ai.usage.cache_creation.input_tokens", 50),
            ],
          }],
        }],
      }],
    });
    expect(event.payload?.usage).toEqual({
      input_tokens: 350,
      output_tokens: 120,
      cache_read_tokens: 600,
      cache_creation_tokens: 50,
    });
  });

  test("keeps a fully cached response with zero output", () => {
    const [event] = otlpLogsToEvents(logs([
      kv("event.kind", "response.completed"),
      kv("input_token_count", 600),
      kv("output_token_count", 0),
      kv("cached_token_count", 600),
    ]));
    expect(event.hook_event_type).toBe("Turn complete");
    expect(event.payload?.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 600,
      cache_creation_tokens: 0,
    });
  });

  test("ignores a generic event.kind log without Codex or GenAI evidence", () => {
    expect(otlpLogsToEvents(logs([
      kv("event.kind", "job.completed"),
    ], "background-worker"))).toEqual([]);
  });
});
