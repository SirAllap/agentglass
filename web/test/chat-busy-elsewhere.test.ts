import { test, expect, beforeAll, beforeEach } from "bun:test";

// A session has exactly one writer. This browser knows about its own turns and
// nothing about a turn started on the phone or in a terminal, so it asks the
// server (GET /chat/active) and holds anything typed while someone else is
// writing. Sending anyway interrupts their turn and loses both answers — the
// failure that ate three replies in one afternoon.

let store: typeof import("../src/lib/chatStore.ts");
let api: typeof import("../src/lib/api.ts")["api"];
beforeAll(async () => {
  (globalThis as any).location ??= new URL("http://localhost:5173/");
  (globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  api = (await import("../src/lib/api.ts")).api;
  store = await import("../src/lib/chatStore.ts");
});

function capture() {
  const sent: string[] = [];
  let finish = () => {};
  api.chatStream = ((payload: { message: string }) => {
    sent.push(payload.message);
    return new Promise<void>((res) => { finish = res as () => void; });
  }) as typeof api.chatStream;
  return { sent, end: () => finish() };
}

const active = () => true;
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => store.setActiveTurns([]));

test("a session someone else is writing is busy, and one we are writing is not", () => {
  store.setActiveTurns(["s-1"]);
  expect(store.busyElsewhere({ sessionId: "s-1", sending: false })).toBe(true);
  // Our own in-flight turn is `sending`; that is a different wait with a
  // different message, and treating it as someone else's would be wrong.
  expect(store.busyElsewhere({ sessionId: "s-1", sending: true })).toBe(false);
  expect(store.busyElsewhere({ sessionId: "s-2", sending: false })).toBe(false);
  // A chat that has never run has no session to collide with.
  expect(store.busyElsewhere({ sessionId: "", sending: false })).toBe(false);
});

test("sending into a session that is mid-turn elsewhere queues instead", async () => {
  const chat = store.newChat("/tmp/repo", undefined, undefined, { sessionId: "s-live" });
  const { sent } = capture();
  store.setActiveTurns(["s-live"]);

  await store.send(chat.id, "are you nearly done", active);
  await tick();

  expect(sent).toEqual([]);                                    // nothing was spawned
  expect(store.getChat(chat.id)?.queued.map((q) => q.text)).toEqual(["are you nearly done"]);
  expect(store.getChat(chat.id)?.sending).toBe(false);
});

test("the queue goes out by itself when the other writer finishes", async () => {
  const chat = store.newChat("/tmp/repo", undefined, undefined, { sessionId: "s-free" });
  const { sent } = capture();
  store.setActiveTurns(["s-free"]);
  await store.send(chat.id, "first", active);
  await store.send(chat.id, "second", active);
  await tick();
  expect(sent).toEqual([]);
  expect(store.getChat(chat.id)?.queued).toHaveLength(2);

  // The other writer stops.
  store.setActiveTurns([]);
  await tick();

  expect(sent).toEqual(["first"]);
  expect(store.getChat(chat.id)?.queued.map((q) => q.text)).toEqual(["second"]);
});

test("a session that stays busy keeps its queue", async () => {
  const chat = store.newChat("/tmp/repo", undefined, undefined, { sessionId: "s-still" });
  const { sent } = capture();
  store.setActiveTurns(["s-still"]);
  await store.send(chat.id, "held", active);
  await tick();

  // A poll that reports the same thing must not re-fire the drain.
  store.setActiveTurns(["s-still"]);
  await tick();
  expect(sent).toEqual([]);
  expect(store.getChat(chat.id)?.queued).toHaveLength(1);
});

test("another session going idle does not drain this one", async () => {
  const mine = store.newChat("/tmp/repo", undefined, undefined, { sessionId: "s-mine" });
  const { sent } = capture();
  store.setActiveTurns(["s-mine", "s-theirs"]);
  await store.send(mine.id, "wait for me", active);
  await tick();

  store.setActiveTurns(["s-mine"]);   // theirs ended, mine did not
  await tick();

  expect(sent).toEqual([]);
  expect(store.getChat(mine.id)?.queued).toHaveLength(1);
});
