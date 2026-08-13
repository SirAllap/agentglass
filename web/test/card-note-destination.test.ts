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

/*
 * And the harder half: a notification ClickUp's own app posted.
 *
 * Those arrive mirrored off D-Bus with the task's title as the summary, a
 * sentence about what happened as the body, and nothing else — no id, no url —
 * because a monitor cannot invoke a notification's own action to ask. Held on
 * the source, the way the find bar's wiring is: the resolution is one HTTP call
 * inside a socket handler, and what would break silently is not the lookup (it
 * has its own suite on the server) but the four guards around WHEN it is asked.
 */
describe("resolving a mirrored ClickUp notification", () => {
  const src = Bun.file(new URL("../src/lib/sysNotify.ts", import.meta.url)).text();

  it("is only tried for a note that has nowhere to go", async () => {
    // Asked for every mirrored note, this would be an HTTP call per Slack
    // message — and could overwrite a destination the note already carried.
    const s = await src;
    const at = s.indexOf("historyChanged();\n    // …and the one that has to be asked");
    expect(at).toBeGreaterThan(0);
    expect(s.slice(at, at + 400)).toContain("if (!n.goto) void attachCard(n)");
  });

  it("skips notes from an app that is not ClickUp, and notes that carry a link", async () => {
    /* ClickUp's daemon posts with an EMPTY app name, which is why these rows
       show no cap next to the time — so "empty or ClickUp" is the test, and a
       note with a url is about that url. */
    const s = await src;
    const at = s.indexOf("async function attachCard");
    const body = s.slice(at, at + 700);
    expect(body).toContain('if (app && !app.includes("clickup")) return;');
    expect(body).toContain("if (n.url) return;");
  });

  it("asks once per title, because one card produces several notifications", async () => {
    const s = await src;
    expect(s).toContain("cardLookups");
    const at = s.indexOf("async function attachCard");
    expect(s.slice(at, at + 900)).toContain("cardLookups.set(title, card)");
  });

  it("patches the row by id, so a note dismissed meanwhile stays dismissed", async () => {
    /* The answer arrives after the row is on screen. Patching by position would
       decorate whatever had moved into that slot. */
    const s = await src;
    const at = s.indexOf("async function attachCard");
    const body = s.slice(at, at + 1400);
    expect(body).toContain("history.findIndex((h) => h.id === n.id)");
    expect(body).toContain("if (i < 0 || history[i]!.goto) return;");
  });
});
