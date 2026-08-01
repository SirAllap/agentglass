import { test, expect, beforeAll } from "bun:test";

// Seeding a chat from another panel (the PR review prompt, the failing check)
// only works if the panel is told to show it. It owns selection and cannot be
// assigned to, so the store carries a request instead. These pin the two things
// the panel relies on: that a request reaches subscribers, and that asking
// twice for the same chat is two requests rather than one ignored repeat.

let store: typeof import("../src/lib/chatStore.ts");
beforeAll(async () => {
  (globalThis as any).location ??= new URL("http://localhost:5173/");
  (globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  store = await import("../src/lib/chatStore.ts");
});

test("a focus request reaches subscribers and names the chat", () => {
  const c = store.newChat("/tmp/repo");
  let woke = 0;
  const off = store.subscribe(() => { woke++; });
  try {
    store.requestChatFocus(c.id);
    expect(woke).toBeGreaterThan(0);
    expect(store.chatFocusRequest().id).toBe(c.id);
  } finally { off(); }
});

test("asking twice for the same chat is two distinct requests", () => {
  const c = store.newChat("/tmp/repo");
  store.requestChatFocus(c.id);
  const first = store.chatFocusRequest();
  store.requestChatFocus(c.id);
  const second = store.chatFocusRequest();
  // Same target, different identity: the panel re-runs on the second click even
  // though the id did not change, which is what brings the tab back after you
  // wandered off it.
  expect(second.id).toBe(first.id);
  expect(second).not.toBe(first);
  expect(second.n).toBe(first.n + 1);
});

test("the request is stable between unrelated store changes", () => {
  const c = store.newChat("/tmp/repo");
  store.requestChatFocus(c.id);
  const before = store.chatFocusRequest();
  // A render caused by any other emit must not look like a fresh focus request,
  // or every streamed token would drag the panel back to this tab.
  store.update(c.id, (x) => { x.draft = "typing"; });
  expect(store.chatFocusRequest()).toBe(before);
});

// The notch's quota gauge reads which chat is active straight off this store
// (getActiveChatId), so setActiveChatId has to do two things: record the id,
// and tell subscribers it changed. The second is the one a getter alone would
// miss -- without it, a subscriber outside the panel goes on showing whatever
// chat used to be active until some unrelated chat event happens to emit.
test("setActiveChatId is readable and tells subscribers", () => {
  const c = store.newChat("/tmp/repo");
  let woke = 0;
  const off = store.subscribe(() => { woke++; });
  try {
    store.setActiveChatId(c.id);
    expect(store.getActiveChatId()).toBe(c.id);
    expect(woke).toBeGreaterThan(0);
  } finally { off(); }
});
