import { test, expect, describe, beforeAll } from "bun:test";

// Antigravity's frames, folded into the same conversation the other two build.
// The interesting cases are the ones where this stream differs from Codex's in
// a way that looks the same: deltas that must concatenate rather than get
// paragraph breaks, and usage that must add rather than be assigned.

let frames: typeof import("../src/lib/antigravityFrames.ts");
beforeAll(async () => {
  (globalThis as any).location ??= new URL("http://localhost:5173/");
  (globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  frames = await import("../src/lib/antigravityFrames.ts");
});

const UUID = "78126291-f204-4b7a-b218-9a7e7ba9ac9a";
const chat = (over: Record<string, unknown> = {}) => ({
  id: "c1", cwd: "/repo", agent: "antigravity", model: "gemini-3.6-flash-low",
  mode: "request-review", title: "t", messages: [], sessionId: "", sending: true,
  draft: "", attachments: [], queued: [], createdAt: 1, abort: null, unread: false,
  attention: "none", ...over,
}) as any;

const step = (o: Record<string, unknown>) => ({ event: "step_update", step_update: o });

describe("init", () => {
  test("adopts the conversation id and the model actually run", () => {
    const c = chat();
    frames.applyAntigravityFrame(c, {
      event: "init", conversation_id: UUID,
      init: { model: "gemini-3.1-pro-high", cwd: "/repo" },
    });
    expect(c.sessionId).toBe(UUID);
    // Unlike the Codex stream, this one names the model it resolved — which is
    // the better answer than the one we asked for, since `agy` can fall back.
    expect(c.resolvedModel).toBe("gemini-3.1-pro-high");
  });
});

describe("prose", () => {
  test("deltas concatenate rather than getting paragraph breaks", () => {
    // The Codex path inserts a blank line between blocks, because Codex says a
    // turn in several complete items. These really are deltas of one sentence,
    // so the same treatment would chop a reply mid-word.
    const c = chat();
    frames.applyAntigravityFrame(c, step({ step_type: "agent_response", text_delta: "Hello, " }));
    frames.applyAntigravityFrame(c, step({ step_type: "agent_response", text_delta: "world" }));
    expect(c.messages[c.messages.length - 1].text).toBe("Hello, world");
  });

  test("thinking is kept apart from the answer", () => {
    const c = chat();
    frames.applyAntigravityFrame(c, step({ step_type: "thinking", text_delta: "weighing it up" }));
    frames.applyAntigravityFrame(c, step({ step_type: "agent_response", text_delta: "done" }));
    const last = c.messages[c.messages.length - 1];
    expect(last.thinking).toBe("weighing it up");
    expect(last.text).toBe("done");
  });
});

describe("tools", () => {
  test("the two halves of one call are one row", () => {
    const c = chat();
    frames.applyAntigravityFrame(c, step({ step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "list_dir", tool_info: { name: "list_dir", parameters: { DirectoryPath: "/repo/src" } } }));
    frames.applyAntigravityFrame(c, step({ step_index: 3, state: "DONE", step_type: "tool", tool_name: "list_dir", tool_info: { name: "list_dir", output: "a\nb\n" } }));
    const tools = c.messages.flatMap((m: any) => m.tools);
    expect(tools).toHaveLength(1);
    // Claude's name for the same act, so the chip renderer and the tool-mix
    // chart do not split one category in two.
    expect(tools[0].name).toBe("Glob");
    expect(tools[0].target).toBe("/repo/src");
    expect(tools[0].output).toBe("a\nb");
  });

  test("a tool without a Claude counterpart keeps its own name", () => {
    const c = chat();
    frames.applyAntigravityFrame(c, step({ step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "generate_image" }));
    expect(c.messages.flatMap((m: any) => m.tools)[0].name).toBe("generate_image");
  });

  test("an error step marks the tool it followed, rather than printing nothing", () => {
    // The stream reports that something failed without saying what — the step
    // carries no message at all. Printing an empty `[error]` would be worse
    // than pointing at the call that produced it.
    const c = chat();
    frames.applyAntigravityFrame(c, step({ step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "view_file" }));
    frames.applyAntigravityFrame(c, step({ step_index: 3, state: "DONE", step_type: "error_message" }));
    expect(c.messages.flatMap((m: any) => m.tools)[0].error).toBe(true);
  });
});

describe("usage", () => {
  test("adds across turns, because these figures are per turn", () => {
    // Measured against agy 1.1.9: turn 1 reported 31789 input tokens and turn 2
    // reported 16609, which cannot be a running total. Codex's are cumulative
    // and must be assigned instead — the two streams look alike here and mean
    // opposite things, and getting it backwards over-reports spend severalfold.
    const c = chat();
    frames.applyAntigravityFrame(c, { event: "result", result: { status: "SUCCESS", usage: { input_tokens: 31789, output_tokens: 1226, cache_read_tokens: 65081 } } });
    frames.applyAntigravityFrame(c, { event: "result", result: { status: "SUCCESS", usage: { input_tokens: 16609, output_tokens: 108, cache_read_tokens: 61046 } } });
    expect(c.usage.input).toBe(31789 + 16609);
    expect(c.usage.output).toBe(1226 + 108);
    expect(c.usage.cacheRead).toBe(65081 + 61046);
  });

  test("no context meter, because nothing here measures one", () => {
    // `agy` reports no window and ctxLimitOf does not know the Gemini 3.x
    // families, so a bar drawn here would state a fullness nobody measured.
    const c = chat();
    frames.applyAntigravityFrame(c, { event: "result", result: { status: "SUCCESS", usage: { input_tokens: 9000 } } });
    expect(c.usage.contextTokens).toBe(0);
    // Nor a cost: there is no price on this stream and no table for a model mix
    // spanning three vendors.
    expect(c.usage.costUsd).toBe(0);
  });

  test("a turn that ended badly asks for you", () => {
    const c = chat();
    frames.applyAntigravityFrame(c, { event: "result", result: { status: "ERROR", usage: {} } });
    expect(c.attention).toBe("blocked");
    expect(c.messages[c.messages.length - 1].text).toContain("[error]");
  });
});

describe("frames it does not know", () => {
  test("are ignored rather than shown", () => {
    // The CLI ships new step types; a chat that printed "[unknown frame]" at
    // the user each time would be worse than one that does not draw it yet.
    const c = chat();
    const before = JSON.stringify(c.messages);
    frames.applyAntigravityFrame(c, step({ step_type: "browser_action", step_index: 9 }));
    frames.applyAntigravityFrame(c, step({ step_type: "checkpoint", step_index: 10 }));
    frames.applyAntigravityFrame(c, { event: "something_new_entirely" });
    expect(JSON.stringify(c.messages)).toBe(before);
  });
});
