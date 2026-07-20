import { test, expect, beforeAll } from "bun:test";
import type { WatchEvent } from "../../shared/types.ts";

// The chat panel had no live subscription at all: a resumed session was a
// photograph taken when you clicked. These pin the routing that fixes it — and,
// more importantly, the two guards that stop it from double-drawing, since the
// same work reaches the panel twice on a normal turn (once over the send()
// stream, once over the socket once the transcript is scanned back off disk).

// chatStore reaches api.ts, which reads `location` at module scope.
let store: typeof import("../src/lib/chatStore.ts");
beforeAll(async () => {
  (globalThis as any).location ??= new URL("http://localhost:5173/");
  (globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  store = await import("../src/lib/chatStore.ts");
});

let id = 0;
const ev = (o: Partial<WatchEvent> & { session_id: string; hook_event_type: string }): WatchEvent => ({
  id: ++id, source_app: "orbit", tool_name: null, tool_use_id: null, agent_id: null, agent_type: null,
  model_name: null, is_error: 0, error_text: null, duration_ms: null, input_tokens: 0, output_tokens: 0,
  cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 0, summary: null,
  timestamp: Date.now() + 60_000, payload: {}, ...o,
});

/** A chat already adopted onto a session, with the live watermark behind us. */
function watching(sessionId: string) {
  const c = store.newChat("/tmp/repo");
  store.update(c.id, (x) => { x.sessionId = sessionId; x.liveFrom = 0; });
  return c.id;
}

test("a prompt and a reply from the session land in the chat", () => {
  const id = watching("s-basic");
  store.applyLiveEvent(ev({ session_id: "s-basic", hook_event_type: "UserPromptSubmit", payload: { prompt: "Continua" } }));
  store.applyLiveEvent(ev({ session_id: "s-basic", hook_event_type: "Stop", payload: { last_assistant_message: "Card configurada." } }));
  const msgs = store.getChat(id)!.messages;
  expect(msgs.map((m) => [m.role, m.text])).toEqual([["user", "Continua"], ["assistant", "Card configurada."]]);
  store.closeChat(id);
});

test("a tool call attaches to the turn above it, and its result fills it in", () => {
  const id = watching("s-tool");
  store.applyLiveEvent(ev({ session_id: "s-tool", hook_event_type: "Stop", payload: { last_assistant_message: "Reading." } }));
  store.applyLiveEvent(ev({
    session_id: "s-tool", hook_event_type: "PreToolUse", tool_name: "Bash", tool_use_id: "tu1",
    payload: { tool_input: { command: "ls -la", description: "list files" } },
  }));
  store.applyLiveEvent(ev({
    session_id: "s-tool", hook_event_type: "PostToolUse", tool_name: "Bash", tool_use_id: "tu1",
    payload: { tool_response: { content: "a.ts\nb.ts", is_error: false } },
  }));
  const msgs = store.getChat(id)!.messages;
  expect(msgs).toHaveLength(1);
  const [t] = msgs[0].tools;
  expect([t.name, t.target, t.note, t.output, t.error]).toEqual(["Bash", "ls -la", "list files", "a.ts\nb.ts", false]);
  store.closeChat(id);
});

test("a failed tool is marked from the event, not only from the payload", () => {
  const id = watching("s-err");
  store.applyLiveEvent(ev({
    session_id: "s-err", hook_event_type: "PreToolUse", tool_name: "Bash", tool_use_id: "tu2",
    payload: { tool_input: { command: "false" } },
  }));
  store.applyLiveEvent(ev({
    session_id: "s-err", hook_event_type: "PostToolUseFailure", tool_use_id: "tu2", is_error: 1,
    payload: { tool_response: { content: "exit 1" } },
  }));
  expect(store.getChat(id)!.messages[0].tools[0].error).toBe(true);
  store.closeChat(id);
});

test("a redelivered event is not drawn twice", () => {
  // The socket replays a window on every connect, and App feeds the whole
  // buffer on each flush — so the same event arrives many times by design.
  const id = watching("s-dup");
  const frame = ev({ session_id: "s-dup", hook_event_type: "Stop", payload: { last_assistant_message: "once" } });
  store.applyLiveEvent(frame);
  store.applyLiveEvent(frame);
  store.applyLiveEvent({ ...frame });
  expect(store.getChat(id)!.messages).toHaveLength(1);
  store.closeChat(id);
});

test("events already on screen from the replay are skipped", () => {
  const id = watching("s-mark");
  const now = Date.now();
  store.update(id, (c) => { c.liveFrom = now; });
  store.applyLiveEvent(ev({ session_id: "s-mark", hook_event_type: "Stop", timestamp: now - 1000, payload: { last_assistant_message: "old" } }));
  expect(store.getChat(id)!.messages).toHaveLength(0);
  store.applyLiveEvent(ev({ session_id: "s-mark", hook_event_type: "Stop", timestamp: now + 1000, payload: { last_assistant_message: "new" } }));
  expect(store.getChat(id)!.messages.map((m) => m.text)).toEqual(["new"]);
  store.closeChat(id);
});

test("a turn being streamed into the panel is not also taken off the socket", () => {
  const id = watching("s-send");
  store.update(id, (c) => { c.sending = true; });
  store.applyLiveEvent(ev({ session_id: "s-send", hook_event_type: "Stop", payload: { last_assistant_message: "from socket" } }));
  expect(store.getChat(id)!.messages).toHaveLength(0);
  store.closeChat(id);
});

test("but a subagent's work during your own turn still comes through", () => {
  // `stream-json` reports a spawned agent as one Task call and its final
  // answer, so without this the twenty minutes it spends reading the codebase
  // are a blank. Nothing sidechained reaches the send stream, so there is
  // nothing here to duplicate.
  const id = watching("s-sub");
  store.update(id, (c) => {
    c.sending = true;
    c.messages.push({ role: "assistant", text: "", tools: [], ts: Date.now() });
  });
  store.applyLiveEvent(ev({
    session_id: "s-sub", hook_event_type: "PreToolUse", tool_name: "Read", tool_use_id: "sub1",
    agent_id: "a1", agent_type: "Explore", payload: { tool_input: { file_path: "services.py" } },
  }));
  const [t] = store.getChat(id)!.messages[0].tools;
  expect([t.name, t.target, t.agentId]).toEqual(["Read", "services.py", "a1"]);
  store.closeChat(id);
});

test("events for a session nobody is watching are ignored", () => {
  const id = watching("s-mine");
  store.applyLiveEvent(ev({ session_id: "s-other", hook_event_type: "Stop", payload: { last_assistant_message: "elsewhere" } }));
  expect(store.getChat(id)!.messages).toHaveLength(0);
  store.closeChat(id);
});

test("an empty Stop does not add a silent bubble", () => {
  // Every turn ends with one; only some of them said anything.
  const id = watching("s-quiet");
  store.applyLiveEvent(ev({ session_id: "s-quiet", hook_event_type: "Stop", payload: {} }));
  expect(store.getChat(id)!.messages).toHaveLength(0);
  store.closeChat(id);
});
