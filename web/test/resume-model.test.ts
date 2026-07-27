import { describe, expect, it } from "bun:test";
import { resumeModel } from "../src/mobile/resumeModel.ts";

/**
 * Replying to a session from the phone must not move it to another model.
 *
 * The ternary this replaces had the same expression on both branches, so every
 * resume went out as Opus — including sessions started on Haiku, which is
 * somebody's bill and not a detail the phone gets to decide.
 */
describe("resumeModel", () => {
  it("keeps a session on the family it was started with", () => {
    expect(resumeModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(resumeModel("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(resumeModel("claude-opus-5")).toBe("claude-opus-5");
  });

  it("matches however the model name was written down", () => {
    expect(resumeModel("Claude Haiku 4.5")).toBe("claude-haiku-4-5");
    expect(resumeModel("anthropic/claude-sonnet-5-20250219")).toBe("claude-sonnet-5");
  });

  it("falls back to the default rather than guessing", () => {
    expect(resumeModel(null)).toBe("claude-opus-5");
    expect(resumeModel(undefined)).toBe("claude-opus-5");
    expect(resumeModel("")).toBe("claude-opus-5");
    expect(resumeModel("some-other-model")).toBe("claude-opus-5");
  });
});
