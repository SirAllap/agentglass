// Which engine a chat's next turn runs on.
//
// This exists because the first version froze the answer when the chat object
// was created, and the panel creates a chat for you before you have touched
// anything. So the chat already on screen when you changed the setting kept the
// old engine and said nothing — changing the preference looked like it did
// nothing at all.
import { test, expect, beforeAll, beforeEach } from "bun:test";

// Same harness the other store tests use: chatStore pulls in api.ts, which reads
// `location` at module load and is not there under bun test.
const cell = new Map<string, string>();
let engineFor: typeof import("../src/lib/chatStore.ts")["engineFor"];
let setChatEnginePref: typeof import("../src/lib/chatEnginePref.ts")["setChatEnginePref"];
let KEY: string;
beforeAll(async () => {
  (globalThis as any).location ??= new URL("http://localhost:5173/");
  // Assigned, not `??=`. Several other test files install a NO-OP localStorage
  // (`setItem: () => {}`), and under `bun test` all of them share one process —
  // so whichever loads first decides whether writes here go anywhere at all.
  // This test reads back what it writes, so it has to own the store.
  (globalThis as any).localStorage = {
    getItem: (k: string) => cell.get(k) ?? null,
    setItem: (k: string, v: string) => { cell.set(k, v); },
    removeItem: (k: string) => { cell.delete(k); },
  };
  ({ engineFor } = await import("../src/lib/chatStore.ts"));
  const pref = await import("../src/lib/chatEnginePref.ts");
  setChatEnginePref = pref.setChatEnginePref;
  KEY = pref.CHAT_ENGINE_KEY;
});

beforeEach(() => { localStorage.removeItem(KEY); });

test("a chat with no session follows the preference, whenever it was created", () => {
  // The reported bug, pinned: the chat existed first, the preference came after.
  const chat = { sessionId: "", engine: undefined };
  expect(engineFor(chat)).toBeUndefined();
  setChatEnginePref("tmux");
  expect(engineFor(chat)).toBe("tmux");
});

test("the preference can also move a not-yet-started chat back to the old engine", () => {
  setChatEnginePref("process");
  // Not merely "undefined becomes tmux": a chat born under one preference must
  // follow a later change in either direction while it still has nothing to lose.
  expect(engineFor({ sessionId: "", engine: "tmux" })).toBe("process");
});

test("a chat that has a session is frozen, and the preference cannot move it", () => {
  setChatEnginePref("tmux");
  // The session lives in a pane or it does not. Switching a running conversation
  // would strand either the warm CLI or the turn in flight.
  expect(engineFor({ sessionId: "abcd-1234", engine: "process" })).toBe("process");
  setChatEnginePref("process");
  expect(engineFor({ sessionId: "abcd-1234", engine: "tmux" })).toBe("tmux");
});

test("a started chat that predates the setting keeps deferring to the server", () => {
  setChatEnginePref("tmux");
  // Chats saved before the engine existed have no field. They are already
  // running somewhere, so they must not be reinterpreted by a new preference.
  expect(engineFor({ sessionId: "old-session-1", engine: undefined })).toBeUndefined();
});

test("no preference means the server decides, which is a real answer", () => {
  // Deliberately not defaulted to "process" here: the server has its own
  // configurable default and the browser must not silently override it.
  expect(engineFor({ sessionId: "", engine: undefined })).toBeUndefined();
});

// The pane engine is Claude's. The preference that selects it is global, and
// the send path has always ignored it for the other two CLIs — so before this,
// turning tmux on made every Codex and Antigravity chat claim a pane in the
// header that the turn was never going to open: an attach command to copy for
// a pane that did not exist, and a "⧉ tmux on send" chip that was just wrong.
test("an agent that cannot run in a pane ignores the preference entirely", () => {
  setChatEnginePref("tmux");
  for (const agent of ["codex", "antigravity"] as const) {
    // Both states a chat can be in: not yet started, and already holding a
    // thread. Neither may come back as "tmux".
    expect(engineFor({ agent, sessionId: "", engine: undefined }), agent).toBe("process");
    expect(engineFor({ agent, sessionId: "thread-1234", engine: "tmux" }), agent).toBe("process");
  }
  // Claude is unaffected — this narrows the answer for two agents, it does not
  // change what the preference means.
  expect(engineFor({ agent: "claude", sessionId: "", engine: undefined })).toBe("tmux");
});

test("a caller with no agent field still reads as Claude", () => {
  // Everything written down before chats had a second agent was a Claude chat,
  // and chatPersist restores those with `agent` filled in — but a bare
  // `{sessionId, engine}` from anywhere else must keep its old meaning rather
  // than silently becoming "process".
  setChatEnginePref("tmux");
  expect(engineFor({ sessionId: "", engine: undefined })).toBe("tmux");
});
