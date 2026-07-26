// Typing into an empty panel opens a chat.
//
// The composer used to be disabled until you had pressed "+ New", which put a
// working-looking input in front of you that silently swallowed everything.
// Worse, the two bits of copy disagreed: the list said "press + new" and the
// box said "Message a new session…".
//
// The store is what this pins. Whether the keystroke reaches it is the panel's
// job, but the rule underneath — a seeded chat starts with that text already in
// its draft, and an empty seed opens nothing — is here.
import { test, expect, beforeAll, beforeEach } from "bun:test";

const cell = new Map<string, string>();
let store: typeof import("../src/lib/chatStore.ts");

beforeAll(async () => {
  (globalThis as any).location ??= new URL("http://localhost:5173/");
  // Assigned rather than `??=`: other files install a no-op localStorage and
  // `bun test` shares one process, so the first loader would otherwise decide
  // whether anything written here is readable. See chat-engine-pick.test.ts.
  (globalThis as any).localStorage = {
    getItem: (k: string) => cell.get(k) ?? null,
    setItem: (k: string, v: string) => { cell.set(k, v); },
    removeItem: (k: string) => { cell.delete(k); },
  };
  store = await import("../src/lib/chatStore.ts");
});

beforeEach(() => { for (const c of store.listChats()) store.closeChat(c.id); });

test("a chat opened from the first keystroke carries that keystroke", () => {
  // The character that opened the chat must not be the one character lost.
  const c = store.newChat("/repo");
  store.update(c.id, (x) => { x.draft = "h"; });
  expect(store.getChat(c.id)?.draft).toBe("h");
});

test("the draft survives the chat becoming the active one", () => {
  // Seeding happens before the chat is selected, so this pins that the two
  // orderings do not fight: the text is on the chat, not on the selection.
  const c = store.newChat("/repo");
  store.update(c.id, (x) => { x.draft = "show me the open issues"; });
  const found = store.listChats().find((x) => x.id === c.id);
  expect(found?.draft).toBe("show me the open issues");
});

test("a new chat starts empty, so nothing is inherited from the last one", () => {
  // If a seeded draft leaked into the next chat, pressing + new after typing
  // would open a tab with someone else's half-sentence in it.
  const a = store.newChat("/repo");
  store.update(a.id, (x) => { x.draft = "first"; });
  const b = store.newChat("/repo");
  expect(store.getChat(b.id)?.draft).toBe("");
  expect(store.getChat(a.id)?.draft).toBe("first");
});

test("a chat opened this way is a normal chat in every other respect", () => {
  // Same cwd handling, same list membership — it must not become a second
  // class of chat that some other part of the panel has to know about.
  const c = store.newChat("/repo");
  expect(c.cwd).toBe("/repo");
  expect(store.listChats().some((x) => x.id === c.id)).toBe(true);
});
