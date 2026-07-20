import { test, expect, beforeEach, beforeAll } from "bun:test";

// Chats used to live only in the store's Map, which made them exactly as durable
// as the page. A crash lost them; so did switching projects, since that path
// reloads on purpose to rescope every view. These pin the writing-down: that a
// tab comes back with what you had typed and which session it was on, that a
// reply cut off mid-sentence does not come back still pretending to stream, and
// that the things which would blow the storage quota, pasted images and a tool
// that printed half a megabyte, are shed rather than taking the save with them.

const KEY = "agentglass.chats.v1";
const cell = new Map<string, string>();

let persist: typeof import("../src/lib/chatPersist.ts");
beforeAll(async () => {
  (globalThis as any).localStorage = {
    getItem: (k: string) => cell.get(k) ?? null,
    setItem: (k: string, v: string) => { cell.set(k, v); },
    removeItem: (k: string) => { cell.delete(k); },
  };
  persist = await import("../src/lib/chatPersist.ts");
});
beforeEach(() => cell.clear());

const stored = () => cell.get(KEY) ?? "";

/** A chat as the store holds it, including the fields that cannot be written
 *  down: the live AbortController, the attachments' object URLs. */
const chat = (over: Record<string, unknown> = {}) => ({
  id: "c1-abc", cwd: "/repo", model: "claude-opus-4-8", resolvedModel: "claude-opus-4-8[1m]", mode: "default",
  title: "fix the parser", messages: [], sessionId: "sess-1", sending: false,
  draft: "half typed", attachments: [], queued: [], createdAt: 1000,
  abort: null, unread: false, attention: "none", ...over,
}) as any;

test("a tab comes back with the draft and the session it was on", () => {
  persist.saveChats([chat()], "c1-abc");
  const { chats, activeId } = persist.loadChats();

  expect(chats).toHaveLength(1);
  expect(chats[0].draft).toBe("half typed");
  expect(chats[0].sessionId).toBe("sess-1");
  expect(chats[0].title).toBe("fix the parser");
  // The window the CLI resolved, not just the one the dropdown asked for: the
  // context meter measures against it.
  expect(chats[0].resolvedModel).toBe("claude-opus-4-8[1m]");
  // Which tab was up, so a reload lands where you were rather than at the end
  // of the strip.
  expect(activeId).toBe("c1-abc");
});

test("nothing in flight is restored as if it still were", () => {
  persist.saveChats([chat({ sending: true })], "c1-abc");
  const [c] = persist.loadChats().chats;

  // There is no subprocess on the far side of a reload, and no controller that
  // could cancel one.
  expect(c.sending).toBe(false);
  expect(c.abort).toBeNull();
  // The thumbnails' object URLs died with the document that minted them.
  expect(c.attachments).toEqual([]);
});

test("a reply the crash cut off does not come back mid-thought", () => {
  persist.saveChats([chat({
    sending: true,
    messages: [
      { role: "user", text: "hi", tools: [], ts: 1 },
      { role: "assistant", text: "", tools: [], ts: 2, streaming: true },
    ],
  })], "c1-abc");

  // An empty assistant turn is a placeholder waiting on text that will never
  // arrive, so it is dropped rather than restored as a permanent cursor.
  expect(persist.loadChats().chats[0].messages).toHaveLength(1);
});

test("a reply that got partway through is kept, minus the cursor", () => {
  persist.saveChats([chat({
    messages: [
      { role: "user", text: "hi", tools: [], ts: 1 },
      { role: "assistant", text: "partial ans", tools: [], ts: 2, streaming: true },
    ],
  })], "c1-abc");
  const msgs = persist.loadChats().chats[0].messages;

  expect(msgs).toHaveLength(2);
  expect(msgs[1].text).toBe("partial ans");
  expect(msgs[1].streaming).toBeFalsy();
});

test("pasted images are shed but the turn says they were there", () => {
  persist.saveChats([chat({
    messages: [{
      role: "user", text: "look at this", tools: [], ts: 1,
      images: [{ mediaType: "image/png", data: "A".repeat(5_000_000) }],
    }],
  })], "c1-abc");
  const [m] = persist.loadChats().chats[0].messages;

  // Base64 image data is megabytes, which is the entire quota. The conversation
  // is worth more than the pixels, and the turn admits what it lost.
  expect(m.images).toBeUndefined();
  expect(m.imagesDropped).toBe(1);
  expect(stored().length).toBeLessThan(10_000);
});

test("a tool that printed half a megabyte is clipped, not fatal", () => {
  persist.saveChats([chat({
    messages: [{
      role: "assistant", text: "ran it", ts: 1,
      tools: [{ id: "t1", name: "Bash", target: "cat big", output: "X".repeat(500_000), error: false, ts: 1 }],
    }],
  })], "c1-abc");
  const out = persist.loadChats().chats[0].messages[0].tools[0].output!;

  expect(out.length).toBeLessThan(3_000);
  expect(out.endsWith("[trimmed]")).toBe(true);
});

test("too much to store drops the oldest, never the one you are in", () => {
  const many = Array.from({ length: 40 }, (_, i) => chat({
    id: `c${i + 1}-x`, createdAt: 1000 + i, title: `chat ${i + 1}`,
    messages: Array.from({ length: 60 }, (_, j) => ({ role: "assistant", text: "Y".repeat(19_000), tools: [], ts: j })),
  }));
  persist.saveChats(many, "c40-x");
  const { chats } = persist.loadChats();

  expect(chats.length).toBeGreaterThan(0);
  expect(chats.length).toBeLessThan(40);
  // Losing the chat you opened last week beats losing the one on screen.
  expect(chats[chats.length - 1].title).toBe("chat 40");
  expect(stored().length).toBeLessThanOrEqual(2_100_000);
});

test("a payload we cannot read costs the tabs, not the panel", () => {
  cell.set(KEY, "{not json");
  expect(persist.loadChats()).toEqual({ chats: [], activeId: "" });
});

test("a version we do not know is ignored rather than half-read", () => {
  cell.set(KEY, JSON.stringify({ v: 99, activeId: "c1-abc", chats: [{ id: "c1-abc", cwd: "/repo" }] }));
  expect(persist.loadChats().chats).toEqual([]);
});

test("a first run with nothing stored is simply empty", () => {
  expect(persist.loadChats().chats).toEqual([]);
});
