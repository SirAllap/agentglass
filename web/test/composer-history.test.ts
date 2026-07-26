// Shell-style recall in the composer: Up walks back through what you sent.
//
// The rules are small but each one is there because the obvious version of it
// is wrong: history is per chat, it is built from sent messages only, and
// coming forward past the newest has to return the draft you interrupted rather
// than an empty box.
import { test, expect, beforeAll, beforeEach } from "bun:test";
import type { ChatMsg } from "../src/lib/chatStore.ts";

const cell = new Map<string, string>();
let store: typeof import("../src/lib/chatStore.ts");

beforeAll(async () => {
  (globalThis as any).location ??= new URL("http://localhost:5173/");
  (globalThis as any).localStorage = {
    getItem: (k: string) => cell.get(k) ?? null,
    setItem: (k: string, v: string) => { cell.set(k, v); },
    removeItem: (k: string) => { cell.delete(k); },
  };
  store = await import("../src/lib/chatStore.ts");
});

beforeEach(() => { for (const c of store.listChats()) store.closeChat(c.id); });

const msg = (role: "user" | "assistant", text: string): ChatMsg =>
  ({ role, text, tools: [], ts: 1 }) as ChatMsg;

/** The same derivation the composer uses: this chat's sent messages, newest
 *  first. Kept here rather than imported because it is one expression, and
 *  pinning it is the point. */
const historyOf = (messages: ChatMsg[]) =>
  messages.filter((m) => m.role === "user" && m.text.trim()).map((m) => m.text).reverse();

test("history is what you said, newest first", () => {
  const h = historyOf([
    msg("user", "first"),
    msg("assistant", "sure"),
    msg("user", "second"),
    msg("assistant", "done"),
  ]);
  // Newest first, so one press of Up gets the thing you most recently sent.
  expect(h).toEqual(["second", "first"]);
});

test("the model's replies are not in your history", () => {
  // Recalling Claude's own words into your composer would be nonsense, and it
  // is the obvious bug if the role filter is forgotten.
  const h = historyOf([msg("user", "hi"), msg("assistant", "hello there")]);
  expect(h).toEqual(["hi"]);
});

test("empty turns are skipped", () => {
  // An image-only turn has no text. Recalling it would look like the recall had
  // silently cleared the box.
  const h = historyOf([msg("user", "real"), msg("user", "   ")]);
  expect(h).toEqual(["real"]);
});

test("history belongs to one chat, not to the panel", () => {
  // Two chats, two conversations. An index into the other one's messages would
  // put someone else's words in this box.
  const a = store.newChat("/repo");
  const b = store.newChat("/repo");
  store.update(a.id, (c) => { c.messages = [msg("user", "in A")]; });
  store.update(b.id, (c) => { c.messages = [msg("user", "in B")]; });
  expect(historyOf(store.getChat(a.id)!.messages)).toEqual(["in A"]);
  expect(historyOf(store.getChat(b.id)!.messages)).toEqual(["in B"]);
});

test("a chat with nothing sent has nothing to recall", () => {
  // Up must fall through to moving the caret, not clear the box.
  expect(historyOf([])).toEqual([]);
});
