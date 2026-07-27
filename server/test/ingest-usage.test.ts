// A usage object that carries only cache tokens (a cache-read-only reply) is
// still usage. Counting only input+output tokens dropped those cache tokens and
// mislabeled the event as cumulative, which then re-summed it from the transcript.
import { describe, expect, test } from "bun:test";
import { normalize } from "../src/ingest.ts";
import type { IngestBody } from "../../shared/types.ts";

const body = (over: Partial<IngestBody>): IngestBody =>
  ({ source_app: "app", session_id: "sess", hook_event_type: "PostToolUse", ...over }) as IngestBody;

describe("payload usage detection", () => {
  test("cache-only usage is kept and not marked cumulative", () => {
    const ev = normalize(body({ payload: { usage: { cache_read_tokens: 500, cache_creation_tokens: 20 } } }));
    expect(ev.usage.cache_read_tokens).toBe(500);
    expect(ev.usage.cache_creation_tokens).toBe(20);
    expect(ev.usage_is_cumulative).toBe(false);
  });

  test("no usage at all still falls through to the transcript sum (cumulative)", () => {
    const ev = normalize(body({ payload: { prompt: "hi" } }));
    expect(ev.usage_is_cumulative).toBe(true);
  });

  test("Kimi's direct cached_tokens are split out of prompt_tokens", () => {
    const ev = normalize(body({
      model_name: "kimi-k3",
      payload: { usage: { prompt_tokens: 1_200, completion_tokens: 300, cached_tokens: 800 } },
    }));
    expect(ev.usage).toEqual({
      input_tokens: 400,
      output_tokens: 300,
      cache_creation_tokens: 0,
      cache_read_tokens: 800,
    });
    expect(ev.usage_is_cumulative).toBe(false);
  });

  test("Kimi's OpenAI-compatible nested cached tokens are split out too", () => {
    const ev = normalize(body({
      model_name: "kimi-code/k3",
      payload: {
        usage: {
          prompt_tokens: 1_200,
          completion_tokens: 300,
          prompt_tokens_details: { cached_tokens: 800 },
        },
      },
    }));
    expect(ev.usage.input_tokens).toBe(400);
    expect(ev.usage.output_tokens).toBe(300);
    expect(ev.usage.cache_read_tokens).toBe(800);
    expect(ev.usage_is_cumulative).toBe(false);
  });
});
