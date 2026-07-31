import { test, expect, beforeAll, describe } from "bun:test";

// A chat is bound to one CLI for its life. These pin the three places that
// binding has to survive or be enforced: which agent a session on the radar
// belongs to, that a restored tab comes back pointed at the same CLI, and that
// the agent can only be changed while there is no thread to strand.

let store: typeof import("../src/lib/chatStore.ts");
let derive: typeof import("../src/lib/derive.ts");
beforeAll(async () => {
  (globalThis as any).location ??= new URL("http://localhost:5173/");
  (globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  store = await import("../src/lib/chatStore.ts");
  derive = await import("../src/lib/derive.ts");
});

describe("agentOf", () => {
  test("recognises both of Codex's exporter names", () => {
    // `codex exec` reports codex_exec, the TUI reports codex_cli_rs — matched on
    // the prefix so a third name does not need a code change.
    expect(derive.agentOf({ source_app: "codex_exec", model_name: "gpt-5.6-sol" })).toBe("codex");
    expect(derive.agentOf({ source_app: "codex_cli_rs", model_name: "gpt-5.6-luna" })).toBe("codex");
  });

  test("falls back to the model when the exporter name says nothing", () => {
    // Claude Code's hooks send the project directory's name, so `source_app` is
    // not a reliable positive signal for either side — only for Codex.
    expect(derive.agentOf({ source_app: "my-project", model_name: "gpt-5.5" })).toBe("codex");
    expect(derive.agentOf({ source_app: "my-project", model_name: "claude-opus-5" })).toBe("claude");
  });

  test("defaults to claude on anything unrecognised", () => {
    // The recoverable direction: `claude --resume` with a stranger's id reports
    // an unknown session, while `codex exec resume` would be asked to continue
    // a conversation it does not have.
    expect(derive.agentOf({ source_app: "", model_name: null })).toBe("claude");
    expect(derive.agentOf({})).toBe("claude");
    // Not every `gpt` substring is a model id — the match is anchored.
    expect(derive.agentOf({ source_app: "gpt-notes-app", model_name: "claude-sonnet-5" })).toBe("claude");
  });
});

describe("switchAgent", () => {
  test("takes the model and the mode with it", () => {
    // Both are the agent's own vocabulary. Carrying `claude-opus-5` across would
    // leave the dropdown showing a choice the server replaces with its default.
    const c = store.newChat("/tmp/repo");
    expect([c.agent, c.model, c.mode]).toEqual(["claude", store.DEFAULT_MODEL, store.DEFAULT_MODE]);
    store.switchAgent(c.id, "codex");
    const after = store.getChat(c.id)!;
    expect([after.agent, after.model, after.mode]).toEqual(["codex", store.DEFAULT_CODEX_MODEL, store.DEFAULT_CODEX_MODE]);
    store.closeChat(c.id);
  });

  test("refuses once the chat holds a thread", () => {
    // A resume id means something only to the CLI that minted it, so switching
    // here would strand the conversation rather than move it.
    const c = store.newChat("/tmp/repo");
    store.update(c.id, (x) => { x.sessionId = "019fb903-f445-7db2-b314-35995fc1f77f"; });
    store.switchAgent(c.id, "codex");
    expect(store.getChat(c.id)!.agent).toBe("claude");
    store.closeChat(c.id);
  });

  test("refuses once anything has been said", () => {
    const c = store.newChat("/tmp/repo");
    store.update(c.id, (x) => { x.messages.push({ role: "user", text: "go", tools: [], ts: 1 }); });
    store.switchAgent(c.id, "codex");
    expect(store.getChat(c.id)!.agent).toBe("claude");
    store.closeChat(c.id);
  });
});

describe("persistence", () => {
  test("a restored tab comes back pointed at the same CLI", async () => {
    const persist = await import("../src/lib/chatPersist.ts");
    const chat = (over: Record<string, unknown>) => ({
      id: "c1-abc", cwd: "/repo", agent: "codex", model: "gpt-5.6-sol", mode: "read-only",
      title: "t", messages: [], sessionId: "019fb903-f445-7db2-b314-35995fc1f77f", sending: false,
      draft: "", attachments: [], queued: [], createdAt: 1000, abort: null, unread: false,
      attention: "none", ...over,
    }) as any;
    const cell = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => cell.get(k) ?? null,
      setItem: (k: string, v: string) => { cell.set(k, v); },
      removeItem: (k: string) => { cell.delete(k); },
    };
    persist.saveChats([chat({})], "c1-abc");
    expect(persist.loadChats().chats[0].agent).toBe("codex");

    // Everything written before chats had a second agent was a Claude chat. A
    // missing field is an older payload saying what it knew, not corruption —
    // defaulting it is what lets those tabs survive instead of being thrown out
    // by a version bump.
    const { agent, ...legacy } = chat({});
    cell.set("agentglass.chats.v1", JSON.stringify({ v: 1, activeId: "c1-abc", chats: [legacy] }));
    expect(persist.loadChats().chats[0].agent).toBe("claude");
  });
});
