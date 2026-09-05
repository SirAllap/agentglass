/*
 * Changing a card on the press, and the two things that made a confirmation
 * strip look necessary.
 *
 * The strip is gone — it stood in front of every field write on the board, which
 * on a morning of triage is two presses and a read for a decision already made
 * ("it is very annoying and slows me down… no confirmation buttons"). What it was
 * covering for is here instead, and both halves have teeth:
 *
 *   the stamp   every write carries the `date_updated` it expects, and the first
 *               write MOVES it. Sending the second with the stamp the row was read
 *               at gets it refused with "somebody changed this card while you had
 *               it open" — where the somebody is you, half a second ago. Measured
 *               here before, on a picker that sent three writes with one stamp.
 *   the order   which only works if writes to one card are serialised.
 *
 * And nothing blocks: two different cards do not wait for each other, and the
 * in-flight set is per control, so status can be saving while the assignee menu is
 * still being used.
 */
import { describe, expect, it } from "bun:test";
import { CardWrites, type WriteResult } from "../src/lib/cardWrites.ts";
import type { ProviderTask } from "../../shared/providers.ts";

const card = (id: string, updated: number, over: Partial<ProviderTask> = {}): ProviderTask => ({
  id, uuid: id, title: `card ${id}`, status: "to do", statusKind: "open", statusColor: "",
  assignees: [], tags: [], updated, mine: false, url: "", ...over,
} as unknown as ProviderTask);

/** A host that records everything, so a test can assert on what the panel would
 *  have been told rather than on internals. */
function host() {
  const tasks: ProviderTask[] = [];
  const notes: { ok: boolean; text: string }[] = [];
  const rolled: string[] = [];
  let changes = 0;
  return {
    tasks, notes, rolled,
    get changes() { return changes; },
    onTask: (t: ProviderTask) => { tasks.push(t); },
    onNote: (n: { ok: boolean; text: string }) => { notes.push(n); },
    onRollback: (w: { key: string }) => { rolled.push(w.key); },
    onChange: () => { changes++; },
  };
}

describe("the stamp is handed forward", () => {
  it("the second write goes out with the stamp the first came back with", async () => {
    const h = host();
    const q = new CardWrites(h);
    const sent: (number | undefined)[] = [];
    const go = (next: number) => async (stamp?: number): Promise<WriteResult> => {
      sent.push(stamp);
      return { ok: true, task: card("c1", next) };
    };
    await q.run({ id: "c1", key: "status", readAt: 100, done: "moved", go: go(200) });
    await q.run({ id: "c1", key: "who:7", readAt: 100, done: "on it", go: go(300) });
    // Not [100, 100] — that pair is the bug.
    expect(sent).toEqual([100, 200]);
  });

  it("writes to one card go in the order they were pressed", async () => {
    const h = host();
    const q = new CardWrites(h);
    const order: string[] = [];
    const slow = (label: string, ms: number) => async (): Promise<WriteResult> => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(label);
      return { ok: true, task: card("c1", 1) };
    };
    const first = q.run({ id: "c1", key: "status", readAt: 1, done: "", go: slow("status", 30) });
    const second = q.run({ id: "c1", key: "who:7", readAt: 1, done: "", go: slow("who", 1) });
    await Promise.all([first, second]);
    expect(order).toEqual(["status", "who"]);
  });

  it("but two cards do not wait for each other", async () => {
    const h = host();
    const q = new CardWrites(h);
    const order: string[] = [];
    const slow = (label: string, ms: number) => async (): Promise<WriteResult> => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(label);
      return { ok: true, task: card(label, 1) };
    };
    await Promise.all([
      q.run({ id: "slow", key: "status", readAt: 1, done: "", go: slow("slow", 30) }),
      q.run({ id: "quick", key: "status", readAt: 1, done: "", go: slow("quick", 1) }),
    ]);
    expect(order).toEqual(["quick", "slow"]);
  });

  // An answer with no card in it leaves us knowing nothing about the stamp. Keeping
  // the old one would be worse than dropping it: a WRONG stamp refuses every later
  // write, and it does it in somebody else's name.
  it("forgets the stamp when a write answers without a card", async () => {
    const h = host();
    const q = new CardWrites(h);
    const sent: (number | undefined)[] = [];
    await q.run({ id: "c1", key: "status", readAt: 100, done: "", go: async (s) => { sent.push(s); return { ok: true, task: card("c1", 200) }; } });
    await q.run({ id: "c1", key: "a", readAt: 100, done: "", go: async (s) => { sent.push(s); return { ok: true }; } });
    await q.run({ id: "c1", key: "b", readAt: 100, done: "", go: async (s) => { sent.push(s); return { ok: true }; } });
    expect(sent).toEqual([100, 200, 100]);
  });
});

describe("what is in flight, and where the spinner goes", () => {
  it("is per control, so the rest of the card stays live", async () => {
    const h = host();
    const q = new CardWrites(h);
    let release = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const run = q.run({
      id: "c1", key: "status", readAt: 1, done: "",
      go: async () => { await held; return { ok: true, task: card("c1", 2) }; },
    });
    expect(q.busy("c1", "status")).toBe(true);
    expect(q.busy("c1", "who:7")).toBe(false);
    expect(q.busyCard("c1")).toBe(true);
    expect(q.busyCard("c2")).toBe(false);
    release();
    await run;
    expect(q.busy("c1", "status")).toBe(false);
    expect(q.pending).toBe(0);
  });

  it("says so as it starts and as it stops, so the spinner can be drawn", async () => {
    const h = host();
    const q = new CardWrites(h);
    await q.run({ id: "c1", key: "status", readAt: 1, done: "", go: async () => ({ ok: true, task: card("c1", 2) }) });
    expect(h.changes).toBeGreaterThanOrEqual(2);
  });
});

describe("a write that does not land", () => {
  it("puts the value back and says what happened", async () => {
    const h = host();
    const q = new CardWrites(h);
    await q.run({ id: "c1", key: "status", readAt: 1, done: "moved", go: async () => ({ ok: false, error: "Status not found on that list" }) });
    expect(h.rolled).toEqual(["status"]);
    expect(h.notes).toEqual([{ ok: false, text: "Status not found on that list" }]);
    expect(h.tasks).toHaveLength(0);
  });

  it("names the conflict when the refusal has no sentence of its own", async () => {
    const h = host();
    const q = new CardWrites(h);
    await q.run({ id: "c1", key: "status", readAt: 1, done: "", go: async () => ({ ok: false, conflict: true }) });
    expect(h.notes[0]!.text).toContain("changed that card while you had it open");
  });

  it("a throw is reported, not swallowed", async () => {
    const h = host();
    const q = new CardWrites(h);
    await q.run({ id: "c1", key: "status", readAt: 1, done: "", go: async () => { throw new Error("offline"); } });
    expect(h.notes[0]).toEqual({ ok: false, text: "offline" });
    expect(h.rolled).toEqual(["status"]);
  });

  // The chain must survive it, or one failed write silently drops every change you
  // make to that card afterwards.
  it("does not take the writes behind it down with it", async () => {
    const h = host();
    const q = new CardWrites(h);
    await q.run({ id: "c1", key: "status", readAt: 1, done: "", go: async () => { throw new Error("offline"); } });
    await q.run({ id: "c1", key: "who:7", readAt: 1, done: "on it", go: async () => ({ ok: true, task: card("c1", 5) }) });
    expect(h.notes.map((n) => n.ok)).toEqual([false, true]);
    expect(h.tasks).toHaveLength(1);
  });

  it("and re-reads the stamp after one, rather than trusting what it had", async () => {
    const h = host();
    const q = new CardWrites(h);
    const sent: (number | undefined)[] = [];
    await q.run({ id: "c1", key: "a", readAt: 100, done: "", go: async (s) => { sent.push(s); return { ok: true, task: card("c1", 200) }; } });
    await q.run({ id: "c1", key: "b", readAt: 100, done: "", go: async (s) => { sent.push(s); return { ok: false, error: "no" }; } });
    await q.run({ id: "c1", key: "c", readAt: 100, done: "", go: async (s) => { sent.push(s); return { ok: true, task: card("c1", 300) }; } });
    expect(sent).toEqual([100, 200, 100]);
  });
});

describe("a fresh read of the board", () => {
  it("drops the stamps, because the load is the authority", async () => {
    const h = host();
    const q = new CardWrites(h);
    const sent: (number | undefined)[] = [];
    await q.run({ id: "c1", key: "a", readAt: 100, done: "", go: async (s) => { sent.push(s); return { ok: true, task: card("c1", 200) }; } });
    q.reset();
    await q.run({ id: "c1", key: "b", readAt: 400, done: "", go: async (s) => { sent.push(s); return { ok: true, task: card("c1", 500) }; } });
    expect(sent).toEqual([100, 400]);
  });
});
