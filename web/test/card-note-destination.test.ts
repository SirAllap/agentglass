/*
 * A ClickUp notification has somewhere to go, and keeps it.
 *
 * The board can already answer "show me this card" — it looks on the loaded
 * board first, then asks which saved list holds it, and only fetches on its own
 * for a card that is in neither. What that costs is one thing: the id has to
 * survive from the notification to the button. If `recordNote` drops the
 * destination, the row goes back to being a dead end and the whole path is
 * unreachable without anything failing loudly.
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

const load = async () =>
  (await import(`../src/lib/sysNotify.ts?t=${Math.random()}`)) as typeof import("../src/lib/sysNotify.ts");

beforeEach(() => store.clear());

describe("what a card notification carries", () => {
  it("keeps the card as its destination", async () => {
    const s = await load();
    s.recordNote({
      app: "ClickUp",
      summary: "T19 assigned to you",
      body: "GiftCard config model · CODE REVIEW",
      goto: { kind: "card", id: "86e2gm3uu", label: "T19" },
    });
    const n = s.notifyHistory()[0]!;
    expect(n.goto).toEqual({ kind: "card", id: "86e2gm3uu", label: "T19" });
  });

  it("carries the internal id, not only the human label", async () => {
    // Both are things the finder accepts, but only the internal one is certain
    // to resolve — a board without custom ids has no other handle on the card.
    const s = await load();
    s.recordNote({ app: "ClickUp", summary: "x", body: "y", goto: { kind: "card", id: "86e2gm3uu", label: "T19" } });
    const g = s.notifyHistory()[0]!.goto!;
    expect(g.kind === "card" && g.id).toBe("86e2gm3uu");
  });

  it("leaves a note with nowhere to go without a destination", async () => {
    // The row only becomes a button when there is somewhere to go; inventing
    // one here would put a dead button on every notification.
    const s = await load();
    s.recordNote({ app: "ClickUp", summary: "x", body: "y" });
    expect(s.notifyHistory()[0]!.goto).toBeUndefined();
  });

  it("keeps the newest first, so the card you were just told about is on top", async () => {
    const s = await load();
    s.recordNote({ app: "ClickUp", summary: "older", body: "y", goto: { kind: "card", id: "aaa", label: "T4" } });
    s.recordNote({ app: "ClickUp", summary: "newer", body: "y", goto: { kind: "card", id: "bbb", label: "T19" } });
    const h = s.notifyHistory();
    expect(h[0]!.summary).toBe("newer");
    const g = h[0]!.goto!;
    expect(g.kind === "card" && g.label).toBe("T19");
  });
});
