import { describe, expect, test } from "bun:test";
import { submitLabel, submitBlocked, viewedProgress, queueSummary, summaryRows } from "../src/lib/reviewBlock.ts";

describe("review block decisions", () => {
  test("the button is named after the verdict", () => {
    expect(submitLabel("approve")).toBe("Approve");
    expect(submitLabel("request_changes")).toBe("Request changes");
    expect(submitLabel("comment")).toBe("Comment");
  });
  test("only an approval may go out empty", () => {
    expect(submitBlocked({ verb: "approve", body: "", queued: 0 })).toBeNull();
    expect(submitBlocked({ verb: "request_changes", body: "  ", queued: 0 })).toBe("Add a summary to request changes");
    expect(submitBlocked({ verb: "comment", body: "", queued: 0 })).toBe("Add a summary to comment");
  });
  test("a summary, a queued comment or a held draft unblocks", () => {
    expect(submitBlocked({ verb: "request_changes", body: "x", queued: 0 })).toBeNull();
    expect(submitBlocked({ verb: "comment", body: "", queued: 1 })).toBeNull();
    expect(submitBlocked({ verb: "comment", body: "", queued: 0, held: 2 })).toBeNull();
  });
  test("an agent-filled form holds Submit even for an approval", () => {
    expect(submitBlocked({ verb: "approve", body: "", queued: 0, held_by_agent: true })).not.toBeNull();
  });
  test("progress clamps and never divides by zero", () => {
    expect(viewedProgress(0, 10)).toEqual({ seen: 0, total: 10, pct: 0, done: false });
    expect(viewedProgress(3, 0)).toEqual({ seen: 0, total: 0, pct: 0, done: false });
    expect(viewedProgress(14, 10).pct).toBe(100);
    expect(viewedProgress(10, 10).done).toBe(true);
    expect(viewedProgress(-2, 10).seen).toBe(0);
  });
  test("queue summary pluralises", () => {
    expect(queueSummary(0)).toBe("No line comments yet");
    expect(queueSummary(1)).toBe("1 line comment queued");
    expect(queueSummary(200)).toBe("200 line comments queued");
  });
  test("summary rows grow then cap", () => {
    expect(summaryRows("")).toBe(3);
    expect(summaryRows("a\n".repeat(8))).toBe(9);
    expect(summaryRows("x".repeat(5000))).toBe(14);
  });
});
