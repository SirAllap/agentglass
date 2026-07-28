/*
 * A list of thirty rows all reading `agentglass:cd3fa401`.
 *
 * `custom_title` is a rename by hand and `ai_title` is one the agent generated,
 * and both come from lines Claude Code writes into the transcript. A session
 * that never got one shows its own uuid forever — which on a real machine is
 * most of them, and a list nobody can scan by eye is the same as not having
 * one.
 *
 * The first thing you typed is a better name than a uuid, and it has been in
 * the database the whole time as a `UserPromptSubmit` event.
 */
import { describe, expect, test } from "bun:test";
import { sessionTitle, promptTitle } from "../src/lib/format.ts";

const base = { session_id: "cd3fa401-7cb5-4652-ac0b-785ed3751479", source_app: "agentglass" };

describe("what a session is called", () => {
  test("a rename wins over everything", () => {
    expect(sessionTitle({ ...base, custom_title: "Nightly", ai_title: "Something", first_prompt: "hello" }))
      .toBe("Nightly");
  });

  test("an AI title wins over the prompt", () => {
    // It was written to be a name; the prompt merely is one.
    expect(sessionTitle({ ...base, ai_title: "Rebuild the companion", first_prompt: "rework it" }))
      .toBe("Rebuild the companion");
  });

  test("the first prompt names a session nobody titled", () => {
    expect(sessionTitle({ ...base, first_prompt: "Rework the companion so it is instant" }))
      .toBe("Rework the companion so it is instant");
  });

  test("the uuid is the last resort, not the first", () => {
    expect(sessionTitle(base)).toBe("agentglass:cd3fa401");
  });

  test("a long prompt is clipped without a dangling space", () => {
    const t = sessionTitle({ ...base, first_prompt: "a".repeat(200) }, 20);
    expect(t).toHaveLength(20);
    expect(t.endsWith("…")).toBe(true);
    expect(sessionTitle({ ...base, first_prompt: "word ".repeat(50) }, 12)).not.toContain(" …");
  });
});

describe("reducing a prompt to a name", () => {
  test("the first line is the ask; the rest is context", () => {
    expect(promptTitle("Fix the egress path\n\nHere is the stack trace:\n...lots..."))
      .toBe("Fix the egress path");
  });

  test("a prompt that opens with a fenced block is not titled with code", () => {
    expect(promptTitle("```\nTypeError: undefined\n  at x.ts:1\n```\nWhy does this happen?"))
      .toBe("Why does this happen?");
  });

  test("quotes and markup are skipped", () => {
    expect(promptTitle("> pasted from the issue\n# Heading\nMake the diff open"))
      .toBe("Make the diff open");
  });

  test("whitespace is collapsed so a row does not gap", () => {
    expect(promptTitle("  Fix    the   egress\tpath  ")).toBe("Fix the egress path");
  });

  test("nothing usable is an empty string, not a guess", () => {
    expect(promptTitle("```\nonly code\n```")).toBe("");
    expect(promptTitle("")).toBe("");
    expect(promptTitle(null)).toBe("");
    expect(promptTitle(undefined)).toBe("");
  });

  test("an unterminated fence does not swallow the whole prompt", () => {
    // A prompt ending mid-block is common when something was pasted; the lines
    // before it are still the ask.
    expect(promptTitle("Why is this failing?\n```\nsome output")).toBe("Why is this failing?");
  });
});
