/*
 * Which gauge the notch shows.
 *
 * "In context" is deliberately not "whatever the dashboard filter says". The
 * notch lives in the workspace, where you are inside one chat with one agent —
 * and the quota that matters while you drive a Codex turn is Codex's, however
 * the dashboard behind it happens to be filtered.
 */
import { describe, expect, test } from "bun:test";
import { providerInContext } from "../src/lib/providerContext.ts";

describe("providerInContext", () => {
  test("the focused agent wins over the filter", () => {
    expect(providerInContext("codex", "Anthropic")).toBe("codex");
    expect(providerInContext("antigravity", "Anthropic")).toBe("antigravity");
    expect(providerInContext("claude", "OpenAI")).toBe("anthropic");
  });

  test("falls back to the filter when no chat is focused", () => {
    expect(providerInContext(null, "Anthropic")).toBe("anthropic");
    expect(providerInContext(null, "OpenAI")).toBe("codex");
    expect(providerInContext(null, "Google")).toBe("antigravity");
  });

  test("no context at all is null, not a guess", () => {
    expect(providerInContext(null, "")).toBe(null);
    // A provider we have no gauge for must not borrow another's.
    expect(providerInContext(null, "Mistral")).toBe(null);
    expect(providerInContext(null, "unknown")).toBe(null);
  });
});
