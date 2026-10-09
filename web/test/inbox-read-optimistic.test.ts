/*
 * The inbox's "Read" tick, drawn on the press.
 *
 * Marking a thread read used to wait for GitHub's answer and then reread the
 * whole inbox before the row stopped being bold — the same shape the pull
 * request panel's reactions had before `prOptimistic.ts`. This is that same
 * layer applied to one field: `unread`, set rather than toggled, so drawing it
 * twice over the same thread is harmless. No network: every `send` here is a
 * promise the test resolves by hand.
 */
import { describe, expect, it } from "bun:test";
import type { InboxItem } from "../../shared/types.ts";
import { Optimistic, type Sent } from "../src/lib/prOptimistic.ts";
import { markReadPatch } from "../src/components/prs/Inbox.tsx";

function deferred() {
  let resolve!: (r: Sent) => void;
  const promise = new Promise<Sent>((a) => { resolve = a; });
  return { promise, resolve };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function host() {
  const fails: string[] = [];
  let changes = 0;
  return { fails, get changes() { return changes; }, h: { onChange: () => { changes++; }, onFail: (t: string) => { fails.push(t); } } };
}

/** A thread the shape GitHub's inbox answers with. */
const note = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: "1", unread: true, reason: "review_requested", type: "PullRequest",
  repo: "acme/orbit", title: "The strip did not follow the computer", at: Date.parse("2026-09-01T10:00:00Z"),
  number: 42, ...over,
});

describe("markReadPatch", () => {
  it("sets the matching thread read and leaves the rest alone", () => {
    const list = [note({ id: "1" }), note({ id: "2" })];
    const patched = markReadPatch(["1"])(list);
    expect(patched.find((n) => n.id === "1")?.unread).toBe(false);
    expect(patched.find((n) => n.id === "2")?.unread).toBe(true);
    // Untouched rows keep their identity — nothing downstream re-renders them.
    expect(patched[1]).toBe(list[1]);
  });

  it("is a set, not a toggle: applying it twice stays read", () => {
    const once = markReadPatch(["1"])([note({ id: "1" })]);
    const twice = markReadPatch(["1"])(once);
    expect(twice[0]?.unread).toBe(false);
  });

  it("an id with nothing to change returns the same list", () => {
    const list = [note({ id: "1", unread: false })];
    expect(markReadPatch(["1"])(list)).toBe(list);
  });
});

describe("the Read tick as an Optimistic layer", () => {
  it("draws unread false before GitHub answers", () => {
    const o = new Optimistic<InboxItem[]>(host().h);
    const w = deferred();
    void o.run({ patch: markReadPatch(["1"]), send: () => w.promise, failText: "Could not mark it read", lane: "1" });
    expect(o.view([note({ id: "1" })])[0]?.unread).toBe(false);
  });

  it("a refusal takes the tick back and says so once", async () => {
    const x = host();
    const o = new Optimistic<InboxItem[]>(x.h);
    const w = deferred();
    const done = o.run({ patch: markReadPatch(["1"]), send: () => w.promise, failText: "Could not mark it read", lane: "1" });
    w.resolve({ ok: false, error: "rate limited" });
    expect(await done).toBe(false);
    expect(o.view([note({ id: "1" })])[0]?.unread).toBe(true);
    expect(x.fails).toEqual(["Could not mark it read: rate limited"]);
  });

  it("a poll already in flight when the write went out does not flip the row back", async () => {
    const o = new Optimistic<InboxItem[]>(host().h);
    const ticket = o.readStarted(); // the 60s poll, started before the press
    const w = deferred();
    void o.run({ patch: markReadPatch(["1"]), send: () => w.promise, failText: "no", lane: "1" });
    w.resolve({ ok: true });
    await tick();
    // That read answers with the thread as it was — still unread — and must
    // not undo the tick that landed after it went out.
    o.readLanded(ticket);
    expect(o.view([note({ id: "1" })])[0]?.unread).toBe(false);
  });

  it("a read that starts after the write settles is GitHub's own word", async () => {
    const o = new Optimistic<InboxItem[]>(host().h);
    const w = deferred();
    void o.run({ patch: markReadPatch(["1"]), send: () => w.promise, failText: "no", lane: "1" });
    w.resolve({ ok: true });
    await tick();
    const ticket = o.readStarted(); // starts after the write above already settled
    o.readLanded(ticket);
    // The layer is gone; a fresh server answer (already read) is what shows.
    expect(o.view([note({ id: "1", unread: false })])[0]?.unread).toBe(false);
    expect(o.size).toBe(0);
  });
});
