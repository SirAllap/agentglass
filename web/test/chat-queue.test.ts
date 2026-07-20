import { test, expect, beforeAll } from "bun:test";

// A turn is one `claude -p` subprocess reading a single message off stdin, so a
// message typed mid-reply has to wait for the next one. These pin the waiting:
// that it is ordered, that it survives the turn it was typed during, and that
// the two ways out of it — stop, and taking it back — actually empty it.

let store: typeof import("../src/lib/chatStore.ts");
let api: typeof import("../src/lib/api.ts")["api"];
beforeAll(async () => {
  (globalThis as any).location ??= new URL("http://localhost:5173/");
  (globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  api = (await import("../src/lib/api.ts")).api;
  store = await import("../src/lib/chatStore.ts");
});

/** Turns sent to the server, in order, plus a handle to finish each one. */
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

test("a message typed mid-turn is held, then sent when the turn ends", async () => {
  const { sent, end } = capture();
  const c = store.newChat("/tmp/repo");
  void store.send(c.id, "first", active);
  await tick();
  expect(sent).toEqual(["first"]);

  store.update(c.id, (x) => { x.draft = "second"; });
  store.enqueue(c.id, "second");
  // Held, not sent — and out of the composer, so the box is free to type in.
  expect(sent).toEqual(["first"]);
  expect(store.getChat(c.id)!.queued.map((q) => q.text)).toEqual(["second"]);
  expect(store.getChat(c.id)!.draft).toBe("");

  end();
  await tick();
  expect(sent).toEqual(["first", "second"]);
  expect(store.getChat(c.id)!.queued).toEqual([]);
  store.closeChat(c.id);
});

test("several queued turns go in the order they were typed", async () => {
  const { sent, end } = capture();
  const c = store.newChat("/tmp/repo");
  void store.send(c.id, "one", active);
  await tick();
  store.enqueue(c.id, "two");
  store.enqueue(c.id, "three");
  expect(store.getChat(c.id)!.queued.map((q) => q.text)).toEqual(["two", "three"]);

  end(); await tick();
  end(); await tick();
  end(); await tick();
  expect(sent).toEqual(["one", "two", "three"]);
  store.closeChat(c.id);
});

test("draining a queued turn leaves what is being typed alone", async () => {
  const { sent, end } = capture();
  const c = store.newChat("/tmp/repo");
  void store.send(c.id, "one", active);
  await tick();
  store.enqueue(c.id, "two");
  // Typed after queueing, and not yet handed over.
  store.update(c.id, (x) => { x.draft = "still writing this"; });

  end();
  await tick();
  expect(sent).toEqual(["one", "two"]);
  expect(store.getChat(c.id)!.draft).toBe("still writing this");
  store.closeChat(c.id);
});

test("stop clears the queue rather than starting the next one", async () => {
  const { sent } = capture();
  const c = store.newChat("/tmp/repo");
  void store.send(c.id, "one", active);
  await tick();
  store.enqueue(c.id, "two");

  store.stop(c.id);
  await tick();
  expect(store.getChat(c.id)!.queued).toEqual([]);
  expect(sent).toEqual(["one"]);
  store.closeChat(c.id);
});

test("a queued turn can be dropped, or taken back into the composer", async () => {
  capture();
  const c = store.newChat("/tmp/repo");
  void store.send(c.id, "one", active);
  await tick();
  store.enqueue(c.id, "keep");
  store.enqueue(c.id, "drop");
  const [keep, drop] = store.getChat(c.id)!.queued;

  store.unqueue(c.id, drop.id);
  expect(store.getChat(c.id)!.queued.map((q) => q.text)).toEqual(["keep"]);

  store.unqueue(c.id, keep.id, true);
  expect(store.getChat(c.id)!.queued).toEqual([]);
  expect(store.getChat(c.id)!.draft).toBe("keep");
  store.closeChat(c.id);
});

test("a turn that fails holds the queue instead of firing it at a broken session", async () => {
  const sent: string[] = [];
  api.chatStream = ((payload: { message: string }) => {
    sent.push(payload.message);
    return Promise.reject(new Error("connection refused"));
  }) as typeof api.chatStream;

  const c = store.newChat("/tmp/repo");
  const done = store.send(c.id, "one", active);
  store.enqueue(c.id, "two");
  await done;
  await tick();
  expect(sent).toEqual(["one"]);
  expect(store.getChat(c.id)!.queued.map((q) => q.text)).toEqual(["two"]);
  store.closeChat(c.id);
});
