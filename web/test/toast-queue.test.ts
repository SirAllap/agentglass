import { test, expect } from "bun:test";
import { enqueue, dequeue, QUEUE_MAX, STALE_MS } from "../src/lib/toastQueue.ts";

// The lane plays one note at a time for a fixed few seconds, so it drains at a
// fixed rate and anything faster queues. Unbounded, that queue stopped being a
// feed and became a backlog: a notification raised under Do Not Disturb was
// still being toasted about two minutes later.
//
// These pin the policy that fixes it, and above all the exemption that keeps
// #138 working: a gate hold has a stopped agent behind it, so it must not wait
// out a burst of chatter and must never be dropped for arriving late.

type N = { id: string; at: number; urgent?: boolean };
const n = (id: string, at: number, urgent = false): N => ({ id, at, urgent });
const ids = (q: N[]) => q.map((x) => x.id);

const T = 1_000_000;

test("ordinary notes keep their arrival order", () => {
  const q: N[] = [];
  enqueue(q, n("a", T));
  enqueue(q, n("b", T + 1));
  enqueue(q, n("c", T + 2));
  expect(ids(q)).toEqual(["a", "b", "c"]);
});

test("an urgent note goes ahead of everything ordinary that is waiting", () => {
  const q: N[] = [];
  enqueue(q, n("slack1", T));
  enqueue(q, n("slack2", T + 1));
  enqueue(q, n("gate", T + 2, true));
  // An agent is stopped; the stickers can wait.
  expect(ids(q)).toEqual(["gate", "slack1", "slack2"]);
});

test("two urgent notes are still answered in the order they blocked", () => {
  const q: N[] = [];
  enqueue(q, n("gate1", T, true));
  enqueue(q, n("chatter", T + 1));
  enqueue(q, n("gate2", T + 2, true));
  expect(ids(q)).toEqual(["gate1", "gate2", "chatter"]);
});

test("a burst is capped, dropping the oldest ordinary notes", () => {
  const q: N[] = [];
  for (let i = 0; i < 10; i++) enqueue(q, n(`n${i}`, T + i));
  expect(q).toHaveLength(QUEUE_MAX);
  // The newest are the ones still worth saying; the old ones are what made the
  // lane fall behind in the first place.
  expect(ids(q)).toEqual(["n6", "n7", "n8", "n9"]);
});

test("the cap never discards an urgent note", () => {
  const q: N[] = [];
  enqueue(q, n("gate", T, true));
  for (let i = 0; i < 20; i++) enqueue(q, n(`n${i}`, T + 1 + i));
  expect(q).toHaveLength(QUEUE_MAX);
  expect(q[0]!.id).toBe("gate");
  expect(q.filter((x) => x.urgent)).toHaveLength(1);
});

test("a queue that is entirely urgent is allowed to exceed the cap", () => {
  const q: N[] = [];
  for (let i = 0; i < 8; i++) enqueue(q, n(`gate${i}`, T + i, true));
  // Dropping one would mean silently declining to mention something is blocked.
  expect(q).toHaveLength(8);
});

test("a note that went stale while queued is skipped, not shown late", () => {
  const q: N[] = [];
  enqueue(q, n("old", T));
  enqueue(q, n("fresh", T + STALE_MS));
  const got = dequeue(q, T + STALE_MS + 1);
  expect(got?.id).toBe("fresh");
});

test("an entirely stale queue yields nothing rather than narrating the past", () => {
  const q: N[] = [];
  enqueue(q, n("a", T));
  enqueue(q, n("b", T + 10));
  expect(dequeue(q, T + STALE_MS + 5_000)).toBeNull();
  expect(q).toHaveLength(0);
});

/*
 * The exemption that matters most.
 *
 * "Late" for a gate hold does not mean "no longer interesting", it means
 * someone has been blocked for a while. Dropping it would turn a delay into a
 * silence, which is the exact failure #135 was about.
 */
test("an urgent note is never dropped for being stale", () => {
  const q: N[] = [];
  enqueue(q, n("gate", T, true));
  const got = dequeue(q, T + 10 * STALE_MS);
  expect(got?.id).toBe("gate");
});

test("a note exactly at the staleness boundary is still shown", () => {
  const q: N[] = [];
  enqueue(q, n("edge", T));
  expect(dequeue(q, T + STALE_MS)?.id).toBe("edge");
});

test("an empty queue dequeues to null", () => {
  expect(dequeue([] as N[], T)).toBeNull();
});
