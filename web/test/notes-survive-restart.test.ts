/*
 * Which notifications survive restarting the app, and which must not.
 *
 * Reported: "restarting wipes them, and the useful ones — the ones that take me
 * to the card or the pull request — are the ones I lose, unless I press clear".
 *
 * Keeping all of them was refused on purpose and the reason still stands: this
 * panel MIRRORS every desktop notification, so writing those bodies down would
 * put somebody's chat messages on disk. The line is drawn at the property that
 * separates the two — a note this app can act on has an in-app destination, and
 * a mirrored message from a chat client never does.
 *
 * Both halves are asserted, because only testing the half that was asked for is
 * how the other half gets lost in a later refactor.
 */
import { beforeEach, describe, expect, it } from "bun:test";

(globalThis as unknown as { location: unknown }).location = { hostname: "localhost", origin: "http://localhost:4000" };
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage;

/** A fresh module is this app being restarted: the store is re-read at import. */
const restart = async () =>
  (await import(`../src/lib/sysNotify.ts?t=${Math.random()}`)) as typeof import("../src/lib/sysNotify.ts");

beforeEach(() => store.clear());

describe("what comes back", () => {
  it("keeps a note that leads to a card", async () => {
    const a = await restart();
    a.recordNote({
      app: "ClickUp", summary: "T19 assigned to you", body: "GiftCard config model",
      goto: { kind: "card", id: "86e2gm3uu", label: "T19" },
    });
    const b = await restart();
    const n = b.notifyHistory()[0]!;
    expect(n.summary).toBe("T19 assigned to you");
    // The destination is the point — a row that comes back without it is a row
    // you can read and not act on.
    expect(n.goto).toEqual({ kind: "card", id: "86e2gm3uu", label: "T19" });
  });

  it("keeps a note that leads to a pull request", async () => {
    const a = await restart();
    a.recordNote({ app: "agentglass", summary: "orbit#12 — checks red", body: "two failing",
      goto: { kind: "pr", repo: "orbit", number: 12 } });
    expect((await restart()).notifyHistory()[0]?.goto).toEqual({ kind: "pr", repo: "orbit", number: 12 });
  });

  it("does NOT keep a mirrored message with nowhere to go", async () => {
    /*
     * The half nobody asked for and everybody would notice: this panel mirrors
     * the desktop, so persisting every body would write somebody's chat to
     * disk. No destination, no record.
     */
    const a = await restart();
    a.recordNote({ app: "Slack", summary: "Ana: are you around?", body: "about the thing we discussed" });
    const b = await restart();
    expect(b.notifyHistory()).toEqual([]);
    expect(store.get("agentglass.notes.actionable") ?? "").not.toContain("are you around");
  });

  it("keeps the actionable ones out of a list that also holds mirrored ones", async () => {
    const a = await restart();
    a.recordNote({ app: "Slack", summary: "Ana: are you around?", body: "private" });
    a.recordNote({ app: "ClickUp", summary: "T4 assigned to you", body: "x", goto: { kind: "card", id: "c1", label: "T4" } });
    const b = await restart();
    expect(b.notifyHistory().map((n) => n.summary)).toEqual(["T4 assigned to you"]);
  });
});

describe("clearing still clears", () => {
  it("empties it for good, which is the one way it is meant to go away", async () => {
    const a = await restart();
    a.recordNote({ app: "ClickUp", summary: "T19", body: "x", goto: { kind: "card", id: "c", label: "T19" } });
    a.clearNotes();
    expect((await restart()).notifyHistory()).toEqual([]);
  });

  it("dismissing one row drops only that row, and for good", async () => {
    const a = await restart();
    a.recordNote({ app: "ClickUp", summary: "keep", body: "x", goto: { kind: "card", id: "c1", label: "A" } });
    a.recordNote({ app: "ClickUp", summary: "drop", body: "x", goto: { kind: "card", id: "c2", label: "B" } });
    a.dismissNote(a.notifyHistory().find((n) => n.summary === "drop")!.id);
    expect((await restart()).notifyHistory().map((n) => n.summary)).toEqual(["keep"]);
  });
});

describe("the badge", () => {
  it("starts at zero, because opening the app is looking", async () => {
    // Restoring a count would make every launch shout about yesterday, which is
    // how a badge stops being read.
    const a = await restart();
    a.recordNote({ app: "ClickUp", summary: "T19", body: "x", goto: { kind: "card", id: "c", label: "T19" } });
    expect(a.notifyUnread()).toBe(1);
    const b = await restart();
    expect(b.notifyHistory()).toHaveLength(1);
    expect(b.notifyUnread()).toBe(0);
  });
});

describe("storage it did not write", () => {
  it("survives junk rather than starting empty every time", async () => {
    store.set("agentglass.notes.actionable", "{{{ not json");
    expect((await restart()).notifyHistory()).toEqual([]);
  });

  it("drops rows that lost their destination", async () => {
    store.set("agentglass.notes.actionable", JSON.stringify([
      { id: "1", app: "x", summary: "no destination", body: "", urgency: 1, at: 1 },
      { id: "2", app: "x", summary: "good", body: "", urgency: 1, at: 2, goto: { kind: "card", id: "c", label: "T" } },
    ]));
    expect((await restart()).notifyHistory().map((n) => n.summary)).toEqual(["good"]);
  });
});
