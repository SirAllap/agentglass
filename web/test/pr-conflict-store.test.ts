/*
 * A card and the page opened from it disagreed: the card sat under "ready to
 * land" with no badge while the page said "Resolve 24 files". GitHub answers
 * `mergeable: UNKNOWN` for a branch it has not looked at lately, and the card
 * badged only CONFLICTING. The store carries git's own answer — from the page,
 * or from the card's own ask — and lays it over UNKNOWN.
 */
import { describe, expect, it, beforeEach } from "bun:test";

const calls: number[] = [];
let answer: (n: number) => Promise<{ ok: boolean; conflicts: string[]; clean: boolean; stale?: boolean }> =
  async () => ({ ok: true, conflicts: ["a.ts", "b.ts"], clean: false });

const mod = await import("../src/lib/api.ts");
(mod.api as unknown as { prConflictFiles: unknown }).prConflictFiles = (_r: string, n: number) => { calls.push(n); return answer(n); };

const { askConflict, checkingConflict, conflictsFrom, forgetConflicts, reopenConflicts, learn, withConflict, onConflict } =
  await import("../src/lib/prConflictStore.ts");
const { fileInLane, stakeFrom } = await import("../src/lib/prLanes.ts");
import type { PrSummary } from "../../shared/types.ts";
import { readFileSync } from "node:fs";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();
const disk = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => disk.get(k) ?? null,
  setItem: (k: string, v: string) => { disk.set(k, v); },
  removeItem: (k: string) => { disk.delete(k); },
});

const settle = () => new Promise((r) => setTimeout(r, 30));
const row = (o: Partial<PrSummary> = {}): PrSummary => ({
  number: 7, title: "t", author: "someone", state: "OPEN", isDraft: false,
  headRefName: "orbit-1042", baseRefName: "main", url: "", updatedAt: "", reviewDecision: null,
  additions: 1, deletions: 1, changedFiles: 1, labels: [], assignees: [], milestone: null,
  mergeable: "UNKNOWN", headSha: "aaa",
  checks: { total: 14, success: 14, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] },
  ...o,
} as unknown as PrSummary);

describe("a conflict GitHub has not computed yet", () => {
  beforeEach(() => { calls.length = 0; forgetConflicts(); });

  it("moves a green card out of ready-to-land once the page has listed files", () => {
    const stake = stakeFrom([{ number: 7 }], [])(row());
    expect(fileInLane(row(), stake).lane).not.toBe("blocked");
    learn("/repo", 7, conflictsFrom({ ok: true, conflicts: ["a.ts"] }), "aaa");
    const card = withConflict("/repo", row());
    expect(card.mergeable).toBe("CONFLICTING");
    expect(fileInLane(card, stake).lane).toBe("blocked");
  });

  it("tells the board when the page learns, so it redraws at once", () => {
    let told = 0;
    const off = onConflict(() => { told++; });
    learn("/repo", 7, true, "aaa");
    off();
    expect(told).toBe(1);
  });

  it("forgets the answer when the branch is pushed", () => {
    learn("/repo", 7, true, "aaa");
    expect(withConflict("/repo", row({ headSha: "bbb" })).mergeable).toBe("UNKNOWN");
  });

  it("does not turn a clean preview into MERGEABLE, nor a stale one into an answer", () => {
    learn("/repo", 7, conflictsFrom({ ok: true, conflicts: [] }), "aaa");
    expect(withConflict("/repo", row()).mergeable).toBe("UNKNOWN");
    expect(conflictsFrom({ ok: true, conflicts: ["a.ts"], stale: true })).toBeNull();
    expect(conflictsFrom({ ok: false, conflicts: [] })).toBeNull();
  });

  it("never overrides a row GitHub has answered", () => {
    learn("/repo", 7, true, "aaa");
    expect(withConflict("/repo", row({ mergeable: "MERGEABLE" })).mergeable).toBe("MERGEABLE");
  });

  it("asks once per card, however often it is drawn, and fills the badge", async () => {
    expect(checkingConflict("/repo", row())).toBe(true);
    askConflict("/repo", row()); askConflict("/repo", row()); askConflict("/repo", row());
    await settle();
    expect(calls).toEqual([7]);
    expect(withConflict("/repo", row()).mergeable).toBe("CONFLICTING");
    expect(checkingConflict("/repo", row())).toBe(false);
  });

  it("does not ask about a row GitHub already answered", async () => {
    askConflict("/repo", row({ mergeable: "MERGEABLE" }));
    await settle();
    expect(calls).toEqual([]);
  });

  it("keeps one in the air and six a minute", async () => {
    let live = 0, peak = 0;
    answer = async () => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return { ok: true, conflicts: [], clean: true };
    };
    for (let n = 1; n <= 30; n++) askConflict("/repo", row({ number: n }));
    await new Promise((r) => setTimeout(r, 150));
    expect(peak).toBe(1);
    expect(calls.length).toBe(6);
    answer = async () => ({ ok: true, conflicts: ["a.ts", "b.ts"], clean: false });
  });

  it("a failed ask is not retried on every draw, and keeps nothing it did not learn", async () => {
    answer = async () => { throw new Error("offline"); };
    askConflict("/repo", row()); await settle();
    askConflict("/repo", row()); askConflict("/repo", row()); await settle();
    expect(calls).toEqual([7]);
    expect(withConflict("/repo", row()).mergeable).toBe("UNKNOWN");
    answer = async () => ({ ok: true, conflicts: ["a.ts", "b.ts"], clean: false });
  });

  it("16 cards, 3 on screen: 3 calls; reopening the panel: 0", async () => {
    // The card asks only once an IntersectionObserver says it is in view
    // (asserted against source below); the store never hears of the other 13.
    const cards = Array.from({ length: 16 }, (_, i) => row({ number: i + 1, headSha: `sha${i + 1}` }));
    const visible = cards.slice(0, 3);
    for (const c of visible) askConflict("/repo", c);
    await settle();
    expect(calls.length).toBe(3);
    reopenConflicts();
    calls.length = 0;
    for (const c of cards) if (visible.includes(c)) askConflict("/repo", c);
    await settle();
    expect(calls.length).toBe(0);
    expect(withConflict("/repo", visible[0]).mergeable).toBe("CONFLICTING");
  });

  it("asks again only when the head commit moves", async () => {
    askConflict("/repo", row()); await settle();
    askConflict("/repo", row()); await settle();
    expect(calls).toEqual([7]);
    askConflict("/repo", row({ headSha: "bbb" })); await settle();
    expect(calls).toEqual([7, 7]);
  });

  it("a could-not-tell is asked once more after a minute, never in a loop", async () => {
    answer = async () => { throw new Error("offline"); };
    const real = Date.now;
    let t = real();
    Date.now = () => t;
    try {
      askConflict("/repo", row()); await settle();
      t += 61_000;
      askConflict("/repo", row()); await settle();
      t += 61_000;
      askConflict("/repo", row()); await settle();
      askConflict("/repo", row()); await settle();
      expect(calls).toEqual([7, 7]);
      expect(checkingConflict("/repo", row())).toBe(false);
    } finally { Date.now = real; }
    answer = async () => ({ ok: true, conflicts: ["a.ts", "b.ts"], clean: false });
  });

  it("a card asks only while it is in the viewport", () => {
    const src = readFileSync(new URL("../src/components/TriageBoard.tsx", import.meta.url), "utf8");
    expect(src).toContain("new IntersectionObserver(");
    expect(src).toContain("if (root && onScreen && !fin) askConflict(root, p);");
  });
});
