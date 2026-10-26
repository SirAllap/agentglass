/*
 * Which gauge the notch shows: the dashboard's provider filter, through an
 * explicit vendor map, and nothing when the filter names no vendor with a gauge.
 */
import { describe, expect, test } from "bun:test";
import { providerInContext } from "../src/lib/providerContext.ts";

describe("providerInContext", () => {
  test("the filter picks the meter", () => {
    expect(providerInContext("Anthropic")).toBe("anthropic");
    expect(providerInContext("OpenAI")).toBe("codex");
    expect(providerInContext("Google")).toBe("antigravity");
  });

  test("no context at all is null, not a guess", () => {
    expect(providerInContext("")).toBe(null);
    // A provider we have no gauge for must not borrow another's.
    expect(providerInContext("Mistral")).toBe(null);
    expect(providerInContext("unknown")).toBe(null);
  });
});
