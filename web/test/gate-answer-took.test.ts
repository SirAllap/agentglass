/*
 * A gate answer that did not take, and the caller that has to admit it.
 *
 * A press that loses the race — the timeout got there first, or somebody
 * answered from another device — comes back **200** with `ok: false`. It is not
 * an exception, so a `try/catch` around the call never sees it, and a caller
 * that treats "it resolved" as "it worked" reports the agent released about a
 * request that was already decided the other way.
 *
 * The companion is where that bit somebody, and the tests that pinned its
 * `decide` went with it — they read MobileApp.tsx as text, because `decide` was
 * a closure over queue state and could not be imported. The cockpit had the
 * identical fault a few feet from the machine: `Alerts.tsx` answered with
 * `api.gateDecide(g.id, decision).catch(() => {})` beside an optimistic
 * `forgetGate`, so the card left the screen whatever the server said and an
 * agent stayed blocked behind a press that looked like it worked.
 *
 * It is answered through `answerGate` now, which is where these tests point:
 * the type still has to admit the failure, and the store has to act on it — put
 * the card back where it was, and say so on the notch.
 */
import { describe, expect, test, beforeAll, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import type { PendingGate } from "../../shared/types.ts";

describe("what the client type admits", () => {
  const api = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
  const fn = api.slice(api.indexOf("gateDecide: (id: string"), api.indexOf("gitStatus:"));

  test("gateDecide can come back not-ok, and the type says so", () => {
    // The call used to be typed `any`, which is how every caller came to treat
    // "it resolved" as "it worked".
    expect(fn).toMatch(/ok: boolean; error\?: string/);
  });
});

// ---------------------------------------------------------------------------

const cell = new Map<string, string>();

let store: typeof import("../src/lib/gateStore.ts");
let sysNotify: typeof import("../src/lib/sysNotify.ts");
const realFetch = globalThis.fetch;

beforeAll(async () => {
  (globalThis as any).localStorage = {
    getItem: (k: string) => cell.get(k) ?? null,
    setItem: (k: string, v: string) => { cell.set(k, v); },
    removeItem: (k: string) => { cell.delete(k); },
  };
  // api.ts resolves the server address at import time, so it has to be there
  // before the store is loaded. No `window`, so importing starts no poll — the
  // ingest seam is driven directly.
  (globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };
  store = await import("../src/lib/gateStore.ts");
  sysNotify = await import("../src/lib/sysNotify.ts");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  store.__resetGateStore();
  sysNotify.clearNotes();
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

/** Answer with whatever `/gate/decide` is being made to say this time. */
function serverSays(body: unknown) {
  globalThis.fetch = ((url: string) => {
    expect(String(url)).toContain("/gate/decide");
    return Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
  }) as unknown as typeof fetch;
}

/** Three holds, standing (seeded, so nothing is announced as an arrival). */
function threeWaiting(): PendingGate[] {
  const gates = [gate("a"), gate("b", { tool_name: "Write" }), gate("c")];
  store.ingestGates(gates);
  return gates;
}

const notes = () => sysNotify.notifyHistory().filter((n) => n.app === "gate");

test("an answer the server accepted takes the card, and a stale poll cannot bring it back", async () => {
  const [, b] = threeWaiting();
  serverSays({ ok: true });

  expect(await store.answerGate(b!, "allow")).toBe(true);
  expect(store.listGates().map((g) => g.id)).toEqual(["a", "c"]);
  // The poll is ~2s behind the press and still lists what was just answered.
  store.ingestGates([gate("a"), gate("b"), gate("c")]);
  expect(store.listGates().map((g) => g.id)).toEqual(["a", "c"]);
  // Nothing to say: it worked, and a note per press is noise.
  expect(notes()).toHaveLength(0);
});

/*
 * The whole point of the file.
 *
 * `ok: false` with a 200 is the answer that arrived too late. The agent is
 * still stopped, so the card is still true — and the user has to be told in
 * the server's own words, because "already denied by the timeout" and "already
 * allowed by somebody else" need different things done about them.
 */
test("an answer that lost the race puts the card back where it was, and says why", async () => {
  const [, b] = threeWaiting();
  serverSays({ ok: false, error: "already denied by the timeout — this answer arrived too late" });

  expect(await store.answerGate(b!, "allow")).toBe(false);

  // Back in its own place, not appended: the list is ordered by what it costs
  // you to be away, and a card that jumps to the end reads as a different card.
  expect(store.listGates().map((g) => g.id)).toEqual(["a", "b", "c"]);
  const [note] = notes();
  expect(note?.summary).toBe("Approve Write did not take");
  expect(note?.body).toContain("already denied by the timeout");
  expect(note?.body).toContain("claude:abcdef01");
  // Urgency 2 is the interrupting kind. An agent is still blocked, which is
  // the state the press was meant to end.
  expect(note?.urgency).toBe(2);
});

test("and the poll can publish it again — the optimistic drop is undone, not just the list", async () => {
  const [, b] = threeWaiting();
  serverSays({ ok: false, error: "that request is not one this server is holding" });
  await store.answerGate(b!, "deny");

  // The suppression that keeps an answered card from flickering back would,
  // left in place, hide this one until the hold timed out.
  store.ingestGates([gate("a"), gate("b", { tool_name: "Write" }), gate("c")]);
  expect(store.listGates().map((g) => g.id)).toEqual(["a", "b", "c"]);
  expect(notes()[0]?.summary).toBe("Deny Write did not take");
});

test("a request that never reached the server is a failure too, not a silent success", async () => {
  const [, b] = threeWaiting();
  globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;

  expect(await store.answerGate(b!, "allow")).toBe(false);
  expect(store.listGates().map((g) => g.id)).toEqual(["a", "b", "c"]);
  expect(notes()[0]?.body).toContain("could not be reached");
});
