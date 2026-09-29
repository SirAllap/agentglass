import { beforeAll, describe, expect, test } from "bun:test";

// Hermes's frames, folded into the same conversation the other three build.
// The interesting cases are the ones where this stream differs from Codex's in
// a way that looks the same: deltas that must concatenate, and usage that must
// add rather than be assigned.

let frames: typeof import("../src/lib/hermesFrames.ts");
beforeAll(async () => {
  (globalThis as any).location ??= new URL("http://localhost:5173/");
  (globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  frames = await import("../src/lib/hermesFrames.ts");
});

const SID = "20260917_104709_fdc54d";
const chat = (over: Record<string, unknown> = {}) => ({
  id: "c1", cwd: "/repo", agent: "hermes", model: "anthropic/claude-sonnet-4",
  mode: "default", title: "t", messages: [], sessionId: "", sending: true,
  draft: "", attachments: [], queued: [], createdAt: 1, abort: null, unread: false,
  attention: "none", ...over,
}) as any;

describe("init", () => {
  test("adopts the session id and the model actually run", () => {
    const c = chat();
    frames.applyHermesFrame(c, {
      type: "system", subtype: "init", session_id: SID, model: "deepseek/deepseek-v4-flash",
    });
    expect(c.sessionId).toBe(SID);
    expect(c.resolvedModel).toBe("deepseek/deepseek-v4-flash");
  });
});

describe("prose", () => {
  test("deltas concatenate rather than getting paragraph breaks", () => {
    const c = chat();
    frames.applyHermesFrame(c, { type: "text", text: "Hello, " });
    frames.applyHermesFrame(c, { type: "text", text: "world" });
    expect(c.messages[c.messages.length - 1].text).toBe("Hello, world");
  });

  test("result text fills in only when no delta arrived", () => {
    const c = chat();
    frames.applyHermesFrame(c, { type: "result", session_id: SID, exit_code: 0, text: "only here", tokens: {} });
    expect(c.messages[c.messages.length - 1].text).toBe("only here");
  });

  test("result text does not duplicate streamed deltas", () => {
    const c = chat();
    frames.applyHermesFrame(c, { type: "text", text: "streamed" });
    frames.applyHermesFrame(c, { type: "result", session_id: SID, exit_code: 0, text: "streamed", tokens: {} });
    expect(c.messages[c.messages.length - 1].text).toBe("streamed");
  });
});

describe("tools", () => {
  test("a tool result attaches to the call id the stream actually sends", () => {
    const c = chat();
    frames.applyHermesFrame(c, { type: "tool_use", name: "terminal", tool_call_id: "call_1", input: { command: "ls" } });
    frames.applyHermesFrame(c, { type: "tool_result", tool_call_id: "call_1", output: "ok", is_error: false });
    expect(c.messages[0].tools[0]).toMatchObject({
      id: "call_1", name: "terminal", target: "ls", output: "ok", error: false,
    });
  });

  test("an error result marks the tool", () => {
    const c = chat();
    frames.applyHermesFrame(c, { type: "tool_use", name: "terminal", tool_call_id: "call_2", input: { command: "false" } });
    frames.applyHermesFrame(c, { type: "tool_result", tool_call_id: "call_2", output: "failed", is_error: true });
    expect(c.messages[0].tools[0].error).toBe(true);
  });
});

describe("usage", () => {
  test("adds across turns, because these figures are per turn", () => {
    // Hermes stream-json tokens are this turn's counts (see hermes_cli/stream_json.py).
    // Codex's are cumulative and must be assigned instead — the two look alike
    // and mean opposite things.
    const c = chat();
    frames.applyHermesFrame(c, {
      type: "result", session_id: SID, exit_code: 0, text: "",
      tokens: { input: 10, output: 4, cache_read: 1, cache_write: 2 },
    });
    frames.applyHermesFrame(c, {
      type: "result", exit_code: 0,
      tokens: { input: 3, output: 1, cache_read: 0, cache_write: 0 },
    });
    expect(c.usage).toMatchObject({ input: 13, output: 5, cacheRead: 1, cacheWrite: 2, costUsd: 0 });
    // Context is the latest prompt, not the sum.
    expect(c.usage.contextTokens).toBe(3);
  });

  test("a failed turn says so on the reply", () => {
    const c = chat();
    frames.applyHermesFrame(c, { type: "result", exit_code: 1, error: "no provider", tokens: {} });
    expect(c.messages[c.messages.length - 1].text).toContain("no provider");
    expect(c.attention).toBe("blocked");
  });
});

describe("frames it does not know", () => {
  test("are ignored rather than shown", () => {
    const c = chat();
    const before = JSON.stringify(c.messages);
    frames.applyHermesFrame(c, { type: "something_new_entirely" });
    frames.applyHermesFrame(c, { type: "system", subtype: "not-init" });
    expect(JSON.stringify(c.messages)).toBe(before);
  });
});
