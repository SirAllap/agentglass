import { test, expect, beforeAll } from "bun:test";
import type { PendingGate } from "../../shared/types.ts";

// A gate hold is the one thing in agentglass with a stopped agent on the other
// end of it, and the only "come and look" signal used to be a `notify-send`
// that a desktop Do Not Disturb setting swallows without a word. The store now
// raises every new hold in-app instead, where no desktop setting can reach it.
//
// These pin the part that decides whether you are interrupted: that arriving to
// a backlog is not a burst of alarms, that a hold waiting through thirty polls
// is announced once, and that answering one cannot make it announce itself
// again on the way out.

const cell = new Map<string, string>();

let store: typeof import("../src/lib/gateStore.ts");
let sysNotify: typeof import("../src/lib/sysNotify.ts");

beforeAll(async () => {
  (globalThis as any).localStorage = {
    getItem: (k: string) => cell.get(k) ?? null,
    setItem: (k: string, v: string) => { cell.set(k, v); },
    removeItem: (k: string) => { cell.delete(k); },
  };
  // The store reaches api.ts, which resolves the server address at import time.
  (globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };
  // No `window` in this environment, so importing the store does not start its
  // poll: the tests drive ingestGates directly, which is the same seam.
  store = await import("../src/lib/gateStore.ts");
  sysNotify = await import("../src/lib/sysNotify.ts");
});

const gate = (id: string, over: Partial<PendingGate> = {}): PendingGate => ({
  id,
  source_app: "claude",
  session_id: "abcdef0123456789",
  tool_name: "Bash",
  summary: "rm -rf build",
  created: 1_700_000_000_000,
  ...over,
});

/** Notes raised on the notch for gates, newest first. */
const gateNotes = () => sysNotify.notifyHistory().filter((n) => n.app === "gate");

const arrivals: PendingGate[] = [];
let unsub: (() => void) | null = null;

test("arriving to gates that were already waiting does not raise a note", () => {
  unsub = store.subscribeNewGates((g) => arrivals.push(g));

  store.ingestGates([gate("a"), gate("b")]);

  // They are the standing state, and the panel shows them. A note means
  // "this just happened", so the first read is a baseline, not an event.
  expect(gateNotes()).toHaveLength(0);
  expect(arrivals).toHaveLength(0);
  expect(store.listGates().map((g) => g.id)).toEqual(["a", "b"]);
});

test("a hold that arrives afterwards is announced", () => {
  store.ingestGates([gate("a"), gate("b"), gate("c", { tool_name: "Write" })]);

  expect(arrivals.map((g) => g.id)).toEqual(["c"]);
  const notes = gateNotes();
  expect(notes).toHaveLength(1);
  expect(notes[0]!.summary).toBe("Approve Write?");
  // Urgency 2 is what the notch colours as the interrupting kind.
  expect(notes[0]!.urgency).toBe(2);
});

test("a hold still waiting is not announced again on every poll", () => {
  for (let i = 0; i < 30; i++) store.ingestGates([gate("a"), gate("b"), gate("c")]);

  expect(arrivals.map((g) => g.id)).toEqual(["c"]);
  expect(gateNotes()).toHaveLength(1);
});

test("the snapshot keeps its identity while the set is unchanged", () => {
  const before = store.listGates();
  store.ingestGates([gate("a"), gate("b"), gate("c")]);
  // Polling every two seconds must not re-render every consumer that reads it.
  expect(store.listGates()).toBe(before);
});

/*
 * The overlap that would undo the whole thing.
 *
 * Approving drops the card immediately, but the poll in flight was sent before
 * the decision and still lists it. If forgetting the card also forgot that it
 * had been announced, that reply would announce it a second time -- a toast for
 * a request you just answered, which teaches you to distrust the toasts.
 */
test("answering a gate does not let an in-flight poll re-announce it", () => {
  store.forgetGate("c");
  expect(store.listGates().map((g) => g.id)).toEqual(["a", "b"]);

  store.ingestGates([gate("a"), gate("b"), gate("c")]); // the stale reply
  expect(arrivals.map((g) => g.id)).toEqual(["c"]);
  expect(gateNotes()).toHaveLength(1);
});

test("a gate that resolves and is later reissued is announced again", () => {
  store.ingestGates([gate("a")]);            // b and c resolved
  store.ingestGates([gate("a"), gate("b")]); // b comes back as a new hold

  expect(arrivals.map((g) => g.id)).toEqual(["c", "b"]);
  expect(gateNotes()).toHaveLength(2);
  unsub?.();
});
