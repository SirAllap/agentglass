import { test, expect, describe, beforeAll } from "bun:test";

// The header's provider filter, reported wrong twice: once when Codex sessions
// were invisible for want of a project, and again when a quiet agent aged out
// of the live event buffer and took its provider with it.

let derive: typeof import("../src/lib/derive.ts");
beforeAll(async () => {
  (globalThis as any).location ??= new URL("http://localhost:5173/");
  (globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  derive = await import("../src/lib/derive.ts");
});

const s = (session_id: string, model_name: string | null) => ({ session_id, model_name });

describe("providersSeen", () => {
  test("a quiet agent is not lost when the event buffer moves on", () => {
    // The actual failure: an Antigravity chat ran nine events an hour ago, a
    // busy Claude session filled the capped buffer, and the filter then claimed
    // Anthropic was the only provider this machine had ever seen — while the
    // server's own scoped answer still listed gemini-3.6-flash-low.
    const sessions = [s("a", "claude-opus-5"), s("b", "gemini-3.6-flash-low")];
    const live = [s("a", "claude-opus-5")]; // only the busy one survived
    expect(derive.providersSeen(sessions, live)).toEqual(["Anthropic", "Google"]);
  });

  test("a session too new for the roll-up still counts", () => {
    // The other direction, and why neither source alone is right: /sessions is
    // polled, so a chat started since the last poll exists only in the buffer.
    expect(derive.providersSeen([], [s("c", "gpt-5.6-sol")])).toEqual(["OpenAI"]);
  });

  test("the live buffer wins on a model that resolved later", () => {
    // A session whose model was unknown at roll-up time and named since.
    expect(derive.providersSeen([s("d", null)], [s("d", "claude-opus-5")])).toEqual(["Anthropic"]);
  });

  test("unknown is a real bucket, and always last", () => {
    // Kept so it can be filtered to and the per-provider views still add up.
    const out = derive.providersSeen([s("e", "mystery-model-9")], [s("f", "claude-opus-5")]);
    expect(out).toEqual(["Anthropic", "unknown"]);
  });

  test("one session counted once, whichever source it came from", () => {
    expect(derive.providersSeen([s("g", "claude-opus-5")], [s("g", "claude-opus-5")])).toEqual(["Anthropic"]);
  });

  test("nothing seen yet is an empty list, not a fake default", () => {
    // The header renders a disabled single-provider chip when there is exactly
    // one; claiming a provider nobody has used would make that chip a lie.
    expect(derive.providersSeen([], [])).toEqual([]);
  });
});
