import { describe, expect, test } from "bun:test";
import { failedSendNote } from "../src/lib/diffReview.ts";

describe("failedSendNote", () => {
  test("an agent that is not installed says so and where to fix it", () => {
    const n = failedSendNote("Claude Code is not installed here", 2);
    expect(n.kind).toBe("missing-cli");
    expect(n.title).toBe("No agent CLI found on PATH.");
    expect(n.body).toContain("Your review is kept: 2 comments");
    expect(n.body).toContain("Set an agent in Settings");
  });
  test("any other failure keeps the generic wording and the error", () => {
    const n = failedSendNote("the terminal did not answer", 1);
    expect(n.kind).toBe("failed");
    expect(n.body).toContain("the terminal did not answer. Your review is kept: 1 comment,");
  });
  test("no error text at all still says what happened", () => {
    expect(failedSendNote(undefined, 1).body).toContain("no answer");
  });
});
