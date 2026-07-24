// Ingest pure helpers from #10 wishlist: detectError on tool_response shapes
// and transcript token summing (usage_is_cumulative path).
import { describe, expect, test } from "bun:test";
import { detectError, sumTranscriptTokens, normalize, clampIngestTimestamp } from "../src/ingest.ts";
import type { IngestBody } from "../../shared/types.ts";

const MAX_FIELD = 64 * 1024; // must match ingest.ts

describe("detectError", () => {
  test("PostToolUseFailure is always an error", () => {
    const r = detectError("PostToolUseFailure", { error: "boom" });
    expect(r.is_error).toBe(1);
    expect(r.error_text).toBe("boom");
  });

  test("payload is_error / isError flags", () => {
    expect(detectError("PostToolUse", { is_error: true, message: "nope" }).is_error).toBe(1);
    expect(detectError("PostToolUse", { isError: true, error_text: "bad" }).error_text).toBe("bad");
  });

  test("tool_response success:false / interrupted / is_error", () => {
    expect(
      detectError("PostToolUse", {
        tool_response: { success: false, stderr: "exit 1" },
      }).error_text,
    ).toBe("exit 1");
    expect(
      detectError("PostToolUse", {
        tool_response: { interrupted: true, error: "user cancelled" },
      }).is_error,
    ).toBe(1);
    expect(
      detectError("PostToolUse", {
        tool_response: { is_error: true, returnCodeInterpretation: "Non-zero exit" },
      }).is_error,
    ).toBe(1);
  });

  test("strong shell markers in stderr/stdout", () => {
    const r = detectError("PostToolUse", {
      tool_response: { stdout: "ok", stderr: "bash: foo: command not found" },
    });
    expect(r.is_error).toBe(1);
    expect(r.error_text?.toLowerCase()).toContain("command not found");
  });

  test("successful tool response is not an error", () => {
    const r = detectError("PostToolUse", {
      tool_response: { success: true, stdout: "hello world" },
    });
    expect(r.is_error).toBe(0);
    expect(r.error_text).toBeNull();
  });

  test("benign output mentioning the word error is not flagged", () => {
    // firstMarker only runs inside tool_response; top-level "error" string is flagged.
    // Successful stdout that merely greps for "error" should stay clean.
    const r = detectError("PostToolUse", {
      tool_response: { success: true, stdout: "matched line: no error found" },
    });
    expect(r.is_error).toBe(0);
  });
});

describe("sumTranscriptTokens", () => {
  test("sums assistant message.usage rows", () => {
    const chat = [
      { type: "assistant", message: { usage: { input_tokens: 100, output_tokens: 20 } } },
      { type: "assistant", message: { usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 5 } } },
    ];
    const u = sumTranscriptTokens(chat);
    expect(u.input_tokens).toBe(150);
    expect(u.output_tokens).toBe(30);
    expect(u.cache_read_tokens).toBe(5);
  });

  test("tolerates prompt_tokens / completion_tokens aliases", () => {
    const u = sumTranscriptTokens([
      { message: { usage: { prompt_tokens: 10, completion_tokens: 3 } } },
    ]);
    expect(u.input_tokens).toBe(10);
    expect(u.output_tokens).toBe(3);
  });

  test("empty / non-array chat yields zeros", () => {
    expect(sumTranscriptTokens(undefined).input_tokens).toBe(0);
    expect(sumTranscriptTokens([] as unknown[]).output_tokens).toBe(0);
  });

  test("a forged transcript cannot sum past the session ceiling", () => {
    // Each entry is clamped to the 20M per-turn max, but the running sum had no
    // ceiling of its own — 200 fabricated max turns used to total 4 billion,
    // sailing past the clamp it was supposed to respect. The total is bounded now
    // (1e9), so no honest session is affected while a forged one is capped.
    const chat = Array.from({ length: 200 }, () => ({
      message: { usage: { input_tokens: 20_000_000, output_tokens: 20_000_000, cache_read_input_tokens: 20_000_000 } },
    }));
    const u = sumTranscriptTokens(chat);
    expect(u.input_tokens).toBeLessThanOrEqual(1_000_000_000);
    expect(u.output_tokens).toBeLessThanOrEqual(1_000_000_000);
    expect(u.cache_read_tokens).toBeLessThanOrEqual(1_000_000_000);
  });

  test("an honest transcript is summed exactly, well under the ceiling", () => {
    const chat = Array.from({ length: 10 }, () => ({ message: { usage: { input_tokens: 1000, output_tokens: 200 } } }));
    const u = sumTranscriptTokens(chat);
    expect(u.input_tokens).toBe(10_000);
    expect(u.output_tokens).toBe(2_000);
  });
});

describe("normalize bounds every untrusted string", () => {
  const big = "x".repeat(MAX_FIELD + 50_000);
  const base = (over: Partial<IngestBody>): IngestBody =>
    ({ source_app: "app", session_id: "sess", hook_event_type: "Notification", ...over }) as IngestBody;

  test("caps a large value under a key the old allowlist never named", () => {
    // The hole: capPayload only truncated a fixed set of keys, so a 32MB blob
    // under any other key became a 32MB row, FTS entry and websocket frame.
    const ev = normalize(base({ payload: { some_unlisted_key: big, nested: { deep: big } } }));
    expect((ev.payload.some_unlisted_key as string).length).toBeLessThanOrEqual(MAX_FIELD + 20);
    expect(((ev.payload.nested as Record<string, unknown>).deep as string).length).toBeLessThanOrEqual(MAX_FIELD + 20);
  });

  test("caps a large string buried inside an array", () => {
    const ev = normalize(base({ payload: { items: ["ok", big] } }));
    expect(((ev.payload.items as string[])[1]).length).toBeLessThanOrEqual(MAX_FIELD + 20);
  });

  test("caps the top-level summary, which skipped capPayload entirely", () => {
    const ev = normalize(base({ summary: big }));
    expect((ev.summary as string).length).toBeLessThanOrEqual(MAX_FIELD + 20);
  });

  test("caps the top-level column strings too (source_app, session_id, tool name)", () => {
    const ev = normalize(base({
      source_app: big, session_id: big,
      payload: { tool_name: big },
    }));
    expect(ev.source_app.length).toBeLessThanOrEqual(MAX_FIELD + 20);
    expect(ev.session_id.length).toBeLessThanOrEqual(MAX_FIELD + 20);
    expect((ev.tool_name ?? "").length).toBeLessThanOrEqual(MAX_FIELD + 20);
  });

  test("leaves small fields untouched", () => {
    const ev = normalize(base({ summary: "all good", payload: { prompt: "hi", n: 3 } }));
    expect(ev.summary).toBe("all good");
    expect(ev.payload.prompt).toBe("hi");
    expect(ev.payload.n).toBe(3);
  });
});

describe("clampIngestTimestamp", () => {
  const now = 1_700_000_000_000; // fixed server clock for the whole block

  test("keeps an in-band timestamp exactly (tool-latency deltas rely on this)", () => {
    expect(clampIngestTimestamp(now, now)).toBe(now);
    expect(clampIngestTimestamp(now - 30_000, now)).toBe(now - 30_000); // 30s late: fine
    expect(clampIngestTimestamp(now + 30_000, now)).toBe(now + 30_000); // 30s ahead: fine
    expect(clampIngestTimestamp(now - 4 * 60_000, now)).toBe(now - 4 * 60_000); // 4m late: still in band
  });

  test("pins a future-skewed clock to now (the named 2h-fast host)", () => {
    expect(clampIngestTimestamp(now + 2 * 3_600_000, now)).toBe(now);
    expect(clampIngestTimestamp(now + 61_000, now)).toBe(now); // just past the 1m future bound
  });

  test("pins an absurdly-past clock to now", () => {
    expect(clampIngestTimestamp(now - 2 * 3_600_000, now)).toBe(now); // 2h slow
    expect(clampIngestTimestamp(0, now)).toBe(now); // epoch
    expect(clampIngestTimestamp(now - 6 * 60_000, now)).toBe(now); // just past the 5m past bound
  });

  test("coerces non-finite input to now", () => {
    expect(clampIngestTimestamp(NaN, now)).toBe(now);
    expect(clampIngestTimestamp(Infinity, now)).toBe(now);
    expect(clampIngestTimestamp(-Infinity, now)).toBe(now);
  });
});
