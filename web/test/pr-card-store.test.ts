/*
 * The card a pull request came from, read once for everybody who draws it.
 *
 * Two surfaces want it — the sidebar, which shows where the card stands, and
 * the reviewer menu, which moves it — and the lookup is a call through the
 * server to ClickUp. Per component that is one request per pull request per
 * surface, repeated on every poll of the panel; here it is one.
 */
import { describe, expect, it, beforeEach } from "bun:test";

const calls: string[] = [];
let answer: (q: string) => Promise<{ ok: boolean; task?: unknown; error?: string }> =
  async (q) => ({ ok: true, task: { id: q, title: "A card", status: "code review" } });

const mod = await import("../src/lib/api.ts");
(mod.api as unknown as { clickupFind: unknown }).clickupFind = (q: string) => {
  calls.push(q);
  return answer(q);
};

const { cardOf, askingCard, onCard, forgetCard, forgetCards } = await import("../src/lib/prCardStore.ts");

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("reading the card behind a pull request", () => {
  beforeEach(() => { calls.length = 0; forgetCards(); });

  it("says nothing until it knows, rather than an empty card", () => {
    // A section that says "No one assigned" while the answer is in flight is
    // worse than one that says it is still reading.
    expect(cardOf("ORBIT-1042")).toBeNull();
    expect(askingCard("ORBIT-1042")).toBe(true);
  });

  it("asks once, however many things are drawing it", async () => {
    cardOf("ORBIT-1042"); cardOf("ORBIT-1042"); cardOf("ORBIT-1042");
    await settle();
    expect(calls).toEqual(["ORBIT-1042"]);
    expect(cardOf("ORBIT-1042")?.task).toMatchObject({ status: "code review" });
    expect(askingCard("ORBIT-1042")).toBe(false);
  });

  it("tells whoever is drawing when the answer lands", async () => {
    let told = 0;
    const off = onCard(() => { told++; });
    cardOf("ORBIT-1042");
    await settle();
    off();
    expect(told).toBeGreaterThan(0);
  });

  it("remembers 'no card' as an answer rather than asking for ever", async () => {
    answer = async () => ({ ok: false, error: "ClickUp could not find it" });
    cardOf("ORBIT-9999");
    await settle();
    cardOf("ORBIT-9999");
    await settle();
    expect(calls.filter((q) => q === "ORBIT-9999").length).toBe(1);
    expect(cardOf("ORBIT-9999")?.error).toBe("ClickUp could not find it");
    answer = async (q) => ({ ok: true, task: { id: q, title: "A card", status: "code review" } });
  });

  it("asks again once the picker has moved the card", async () => {
    /* The status held here is exactly what the write just changed. Without
       this the sidebar would go on showing the old one for the rest of the
       minute, next to a menu that had just moved it. */
    cardOf("ORBIT-1042");
    await settle();
    expect(calls.length).toBe(1);
    forgetCard("ORBIT-1042");
    cardOf("ORBIT-1042");
    await settle();
    expect(calls).toEqual(["ORBIT-1042", "ORBIT-1042"]);
  });

  it("does not ask without a card to ask about", () => {
    expect(cardOf("")).toBeNull();
    expect(askingCard("")).toBe(false);
    expect(calls).toEqual([]);
  });
});
