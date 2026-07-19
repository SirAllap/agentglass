// Ingest pure helpers from #10 wishlist: detectError on tool_response shapes
// and transcript token summing (usage_is_cumulative path).
import { describe, expect, test } from "bun:test";
import { detectError, sumTranscriptTokens } from "../src/ingest.ts";

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
});
