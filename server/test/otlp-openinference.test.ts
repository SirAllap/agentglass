// OpenInference reports usage under llm.token_count.* (#366).
//
// That is the convention Arize Phoenix and its instrumentors emit, and the
// mapper never read it. The failure was silent rather than loud, which is what
// made it worth fixing: the span is still recognised as a GenAI span, because
// the check accepts any attribute key starting with `llm.` — so the session
// lands, the model resolves, and tool spans pair up normally. Only the numbers
// are missing. An Arize user sees every session appear and every one cost
// $0.00, which reads as "agentglass can't price my provider" rather than "one
// attribute name is missing".
import { describe, expect, test } from "bun:test";
import { otlpTracesToEvents } from "../src/otlp.ts";

const kv = (key: string, value: string | number) => ({
  key,
  value: typeof value === "number" ? { intValue: value } : { stringValue: value },
});

const traces = (attributes: ReturnType<typeof kv>[], name = "ChatCompletion") => ({
  resourceSpans: [{
    resource: { attributes: [kv("service.name", "phoenix-app")] },
    scopeSpans: [{
      spans: [{
        traceId: "trace-oi-1",
        spanId: "span-oi-1",
        name,
        startTimeUnixNano: "1700000000000000000",
        endTimeUnixNano: "1700000001000000000",
        attributes,
      }],
    }],
  }],
});

const BASE = [
  kv("llm.model_name", "gpt-4o"),
  kv("llm.system", "openai"),
];

describe("an OpenInference span carries its tokens", () => {
  test("prompt and completion counts are read", () => {
    const [event] = otlpTracesToEvents(traces([
      ...BASE,
      kv("llm.token_count.prompt", 1_200),
      kv("llm.token_count.completion", 340),
    ]));
    expect(event).toBeDefined();
    expect(event.payload?.usage).toEqual({
      input_tokens: 1_200,
      output_tokens: 340,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });
  });

  test("the session still lands and the model still resolves", () => {
    // This was already true — and is exactly why the bug was invisible.
    const [event] = otlpTracesToEvents(traces([
      ...BASE,
      kv("llm.token_count.prompt", 10),
      kv("llm.token_count.completion", 5),
    ]));
    expect(event.session_id).toBe("trace-oi-1");
    expect(event.model_name).toBe("gpt-4o");
  });

  test("a span with no usage at all is still not charged something invented", () => {
    const [event] = otlpTracesToEvents(traces(BASE));
    expect(event.payload?.usage).toEqual({
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
    });
  });

  /**
   * The one judgement call in this change, written down as a test so it is
   * cheap to reverse.
   *
   * `llm.token_count.prompt_details.cache_read` is treated as a SUBSET of
   * `llm.token_count.prompt`, so it is subtracted out — the same contract every
   * other cache alias in that list already has, and what the mapper's
   * `input_tokens = total - cacheRead - cacheCreation` has always assumed.
   * `prompt_details` reads as a breakdown *of* the prompt, which is why.
   *
   * If some instrumentor turns out to report it additively, this is the test to
   * change: the expected input_tokens becomes 1_200 and the subtraction of
   * cacheRead has to stop for this alias.
   */
  test("cache reads are a subset of the prompt count", () => {
    const [event] = otlpTracesToEvents(traces([
      ...BASE,
      kv("llm.token_count.prompt", 1_200),
      kv("llm.token_count.completion", 340),
      kv("llm.token_count.prompt_details.cache_read", 900),
    ]));
    expect(event.payload?.usage).toEqual({
      input_tokens: 300, // 1200 - 900, not 1200
      output_tokens: 340,
      cache_read_tokens: 900,
      cache_creation_tokens: 0,
    });
  });

  test("input_tokens never goes negative if a source disagrees about that", () => {
    const [event] = otlpTracesToEvents(traces([
      ...BASE,
      kv("llm.token_count.prompt", 100),
      kv("llm.token_count.prompt_details.cache_read", 900),
    ]));
    expect((event.payload?.usage as any).input_tokens).toBe(0);
  });
});

describe("the gen_ai.* conventions still win where both are present", () => {
  // Order in the alias list is precedence, and llm.token_count.* is last, so a
  // span emitting both shapes is unaffected by this change.
  test("gen_ai.usage.input_tokens takes precedence", () => {
    const [event] = otlpTracesToEvents(traces([
      ...BASE,
      kv("gen_ai.usage.input_tokens", 50),
      kv("llm.token_count.prompt", 9_999),
    ]));
    expect((event.payload?.usage as any).input_tokens).toBe(50);
  });
});
