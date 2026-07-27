import { describe, expect, test } from "bun:test";

process.env.AGENTGLASS_SCAN_DISABLED = "1";

const { completeJsonlLines } = await import("../src/transcripts.ts");

describe("completeJsonlLines", () => {
  test("returns newline-terminated records", () => {
    expect(completeJsonlLines('{"id":1}\n{"id":2}\n')).toEqual(['{"id":1}', '{"id":2}']);
  });

  test("holds an incomplete final record for the next scan", () => {
    expect(completeJsonlLines('{"id":1}\n{"id":')).toEqual(['{"id":1}']);
  });

  test("does not treat an unterminated record as complete", () => {
    expect(completeJsonlLines('{"id":1}')).toEqual([]);
  });
});
