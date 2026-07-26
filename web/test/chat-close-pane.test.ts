// Closing a chat gives its warm CLI back.
//
// A pane holds ~380MB for as long as it lives, and closing the tab is the
// clearest "done with this" there is. Left alone the pane survived until the
// idle sweeper reached it half an hour later, which was visible from outside —
// `tmux -L agentglass ls` kept listing sessions for chats that no longer
// existed, which is what prompted this.
import { test, expect, beforeAll, beforeEach } from "bun:test";

const cell = new Map<string, string>();
let store: typeof import("../src/lib/chatStore.ts");
let api: typeof import("../src/lib/api.ts")["api"];
let closed: string[];

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
  api = (await import("../src/lib/api.ts")).api;
  store = await import("../src/lib/chatStore.ts");
});

beforeEach(() => {
  closed = [];
  api.chatPaneClose = ((session: string) => {
    closed.push(session);
    return Promise.resolve({ killed: true });
  }) as typeof api.chatPaneClose;
  for (const c of store.listChats()) store.closeChat(c.id);
  closed = [];
});

test("closing a pane chat releases its pane", () => {
  const c = store.newChat("/repo");
  store.update(c.id, (x) => { x.engine = "tmux"; x.sessionId = "6f1c9b52-0000-4000-8000-0123456789ab"; });
  store.closeChat(c.id);
  expect(closed).toEqual(["6f1c9b52-0000-4000-8000-0123456789ab"]);
});

test("a chat on the old engine asks the server for nothing", () => {
  // `claude -p` leaves no process between turns, so there is nothing to release
  // and a request would be pure noise on every close.
  const c = store.newChat("/repo");
  store.update(c.id, (x) => { x.engine = "process"; x.sessionId = "6f1c9b52-0000-4000-8000-0123456789ab"; });
  store.closeChat(c.id);
  expect(closed).toEqual([]);
});

test("a pane chat that never ran has no pane to release", () => {
  // No session means the pane was never launched. Asking to kill it would be a
  // request for a name the server has never heard of.
  const c = store.newChat("/repo");
  store.update(c.id, (x) => { x.engine = "tmux"; });
  store.closeChat(c.id);
  expect(closed).toEqual([]);
});

test("the chat closes even when the server cannot be reached", async () => {
  // The tab must never hang on a cleanup call. A pane nobody reclaimed is
  // exactly what the idle sweeper already exists for.
  api.chatPaneClose = (() => Promise.reject(new Error("down"))) as typeof api.chatPaneClose;
  const c = store.newChat("/repo");
  store.update(c.id, (x) => { x.engine = "tmux"; x.sessionId = "6f1c9b52-0000-4000-8000-0123456789ab"; });
  store.closeChat(c.id);
  expect(store.getChat(c.id)).toBeUndefined();
  // And the rejection is swallowed rather than surfacing as an unhandled one.
  await Promise.resolve();
});

test("closing still stops a turn that was streaming", () => {
  // Unchanged behaviour, pinned because the close path grew a second job and
  // this is the one that was already load-bearing.
  const c = store.newChat("/repo");
  let aborted = false;
  const ac = new AbortController();
  ac.signal.addEventListener("abort", () => { aborted = true; });
  store.update(c.id, (x) => { x.abort = ac; x.sending = true; });
  store.closeChat(c.id);
  expect(aborted).toBe(true);
});
