/*
 * How far behind each branch is, on a board that must not pay for it.
 *
 * The pull request's own page has carried "Update branch & pull · 222 behind"
 * for a while; the board, which is where you decide what to open, said nothing.
 * It cannot come with the list — `mergeStateStatus` reports BEHIND only where
 * the repository requires branches to be up to date, and a branch 194 commits
 * behind still reports CLEAN without that — so it is one comparison per pull
 * request, asked for only when a card is drawn.
 */
import { describe, expect, it, beforeEach } from "bun:test";

const calls: number[] = [];
let answer: (n: number) => Promise<{ ok: boolean; behind?: number }> = async (n) => ({ ok: true, behind: n });

const mod = await import("../src/lib/api.ts");
(mod.api as unknown as { prBehind: unknown }).prBehind = (_root: string, number: number) => {
  calls.push(number);
  return answer(number);
};

const { behindOf, askingBehind, onBehind, forgetBehind, refreshBehind } = await import("../src/lib/prBehindStore.ts");

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("asking how far behind", () => {
  beforeEach(() => { calls.length = 0; forgetBehind(); });

  it("says nothing until it knows, rather than zero", () => {
    // A card that reads "0 behind" while the answer is in flight is worse than
    // a card that has not said anything.
    expect(behindOf("/repo", 7)).toBeNull();
  });

  it("asks once per pull request, however many times it is drawn", async () => {
    behindOf("/repo", 7); behindOf("/repo", 7); behindOf("/repo", 7);
    await settle();
    expect(calls).toEqual([7]);
    expect(behindOf("/repo", 7)).toBe(7);
  });

  it("tells whoever is drawing when an answer lands", async () => {
    let told = 0;
    const off = onBehind(() => { told++; });
    behindOf("/repo", 3);
    await settle();
    off();
    expect(told).toBeGreaterThan(0);
  });

  it("keeps three in the air at once, not twelve", async () => {
    /* The server runs `gh` on one thread, and a board is a glance. Twelve
       comparisons fired at once would hold up everything else on it. */
    let live = 0, peak = 0;
    answer = async (n) => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 15));
      live--;
      return { ok: true, behind: n };
    };
    for (let n = 1; n <= 12; n++) behindOf("/repo", n);
    await new Promise((r) => setTimeout(r, 250));
    expect(peak).toBeLessThanOrEqual(3);
    expect(calls.length).toBe(12);
    answer = async (n) => ({ ok: true, behind: n });
  });

  it("remembers a failure as 'no answer' rather than asking for ever", async () => {
    answer = async () => ({ ok: false });
    behindOf("/repo", 9);
    await settle();
    behindOf("/repo", 9);
    await settle();
    expect(calls.filter((n) => n === 9).length).toBe(1);
    answer = async (n) => ({ ok: true, behind: n });
  });

  it("says it is still asking, which is not the same as up to date", async () => {
    /* Both draw no chip, and only one of them deserves the space kept for it —
       twelve chips arriving one by one is the board rearranging itself in slow
       motion. */
    behindOf("/repo", 4);
    expect(askingBehind("/repo", 4)).toBe(true);
    await settle();
    expect(askingBehind("/repo", 4)).toBe(false);
  });

  it("does not ask without a checkout to ask about", () => {
    expect(behindOf("", 7)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("a count you are looking at", () => {
  beforeEach(() => { calls.length = 0; forgetBehind(); });

  it("can be asked for again without waiting out the cache", async () => {
    /*
     * Five minutes is right for a board of twelve — each one is a comparison
     * over the network — and far too long for the pull request in front of you.
     * Measured while he was looking at one: the server said 0 behind, GitHub
     * agreed, and the page still said 936.
     */
    behindOf("/repo", 5);
    await settle();
    expect(calls).toEqual([5]);
    refreshBehind("/repo", 5);
    await settle();
    expect(calls).toEqual([5, 5]);
  });

  it("has no separator a key can hide behind", () => {
    // A raw NUL in the key made the file invisible to grep and tripped the
    // source-hygiene check. Two colons say the same thing out loud.
    behindOf("/repo/a", 1);
    behindOf("/repo", 1);
    expect(calls.length).toBe(2);
  });
});
