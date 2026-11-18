import { describe, expect, test } from "bun:test";
import { cardView } from "../src/lib/prCardView.ts";
import { cardMenu, type CardMenu, type MenuItem } from "../src/lib/prCardMenu.ts";
import { cardReviewers } from "../src/lib/cardReviewers.ts";
import { fromLocalInput, toLocalInput } from "../src/components/MergeLock.tsx";
import type { PrCheckRollup } from "../../shared/types.ts";

const roll: PrCheckRollup = { total: 8, success: 8, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] };
// orbit/api #1042 "step 2b": approved, green, mergeable, and locked by the person.
const pr = (o: Record<string, unknown> = {}) => ({
  number: 1042, title: "step 2b", author: "mara-k", state: "OPEN" as const, isDraft: false,
  headRefName: "ORBIT-1042-step-2b", baseRefName: "main", mergeable: "MERGEABLE" as const,
  reviewDecision: "APPROVED" as const, checks: roll, humanReview: undefined, ...o,
});
const REASON = "Locked until Wed 25 Nov 09:00 — 0 of 1 item ticked";
const view = (mergeLock: string | null, p = pr()) =>
  cardView({ p, filed: { lane: "land", reason: "x" }, reviewers: cardReviewers(undefined), tracker: "card", hasTaskProvider: true, mergeLock });
const items = (m: CardMenu): MenuItem[] => [...m.rows.filter((r): r is MenuItem => r.kind === "item"), ...m.more, m.close];

describe("card under a merge lock", () => {
  test("Merge is off, carries the lock and says the lock's sentence", () => {
    const v = view(REASON);
    expect(v.primary).toMatchObject({ id: "merge", disabled: true, lock: true, held: true, title: REASON });
    expect(v.mergeLock).toBe(REASON);
    expect(v.reasons.merge).toBe(REASON);
  });
  test("no lock: Merge as before", () => {
    expect(view(null).primary).toMatchObject({ id: "merge", disabled: false, lock: false });
    expect(view(null).mergeLock).toBeNull();
  });
  test("a merged PR shows no lock", () => {
    expect(view(REASON, pr({ state: "MERGED" })).mergeLock).toBeNull();
  });
  test("the menu offers Lock merge, and Merge/Squash/Rebase carry the sentence", () => {
    const m = (lock?: { set: boolean; reason: string | null }) => cardMenu({
      p: pr(), view: view(lock?.reason ?? null), pinned: false, mode: "none", stacked: false, mergeLock: lock,
    });
    expect(items(m()).find((i) => i.id === "lock")).toMatchObject({ label: "Lock merge…" });
    const held = items(m({ set: true, reason: REASON }));
    expect(held.find((i) => i.id === "lock")).toMatchObject({ label: "Edit merge lock…", sub: REASON });
    for (const id of ["merge", "squash", "rebase"]) expect(held.find((i) => i.id === id)?.why).toBe(REASON);
  });
});

test("the date picker's local wall time round-trips", () => {
  const ms = new Date(2026, 10, 25, 9, 0).getTime();
  expect(toLocalInput(ms)).toBe("2026-11-25T09:00");
  expect(fromLocalInput("2026-11-25T09:00")).toBe(ms);
  expect(fromLocalInput("")).toBeNull();
});
