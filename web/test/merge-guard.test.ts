// The question before a merge that skips a review, and the proof that both merge
// paths in the panel go through it. A guard nobody calls is the failure that
// tests over the pure model cannot see, so the wiring is asserted against the
// source, sliced to each function's own body.
import { describe, expect, test } from "bun:test";
import { confirmMergeGuard } from "../src/lib/mergeGuard.ts";
import type { PrReview } from "../../shared/types.ts";

const rev = (author: string, isBot = false): PrReview =>
  ({ author, isBot, state: "APPROVED", body: "", submittedAt: "2026-09-30T08:00:00Z" });

const spy = (answer: boolean) => {
  const seen: { title: string; body?: string; confirmLabel?: string; cancelFocus?: boolean }[] = [];
  return { seen, ask: async (s: (typeof seen)[number]) => { seen.push(s); return answer; } };
};

describe("confirmMergeGuard", () => {
  test("lists who is pending and that only a bot approved, with Cancel first", async () => {
    const s = spy(true);
    const ok = await confirmMergeGuard({ reviews: [rev("review-bot", true)], reviewers: [{ login: "carol" }], author: "bob" }, s.ask);
    expect(ok).toBe(true);
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]!.body).toContain("• carol hasn't reviewed yet");
    expect(s.seen[0]!.body).toContain("• only a bot has approved");
    expect(s.seen[0]!.confirmLabel).toBe("Merge anyway");
    expect(s.seen[0]!.cancelFocus).toBe(true);
  });
  test("cancel stops the merge", async () => {
    expect(await confirmMergeGuard({ reviews: [], reviewers: [{ login: "carol" }], author: "bob" }, spy(false).ask)).toBe(false);
  });
  test("no dialog when everyone answered and a person approved", async () => {
    const s = spy(false);
    expect(await confirmMergeGuard({ reviews: [rev("alice"), rev("review-bot", true)], reviewers: [], author: "bob" }, s.ask)).toBe(true);
    expect(s.seen).toHaveLength(0);
  });
  test("it asks again every time", async () => {
    const s = spy(true);
    const pr = { reviews: [], reviewers: [{ login: "carol" }], author: "bob" };
    await confirmMergeGuard(pr, s.ask); await confirmMergeGuard(pr, s.ask);
    expect(s.seen).toHaveLength(2);
  });
});

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url).pathname).text();
const body = (open: string) => {
  const i = src.indexOf(open);
  expect(i).toBeGreaterThan(-1);
  let d = 0, k = src.indexOf("{", src.indexOf("=>", i));
  for (let j = k; j < src.length; j++) { if (src[j] === "{") d++; else if (src[j] === "}" && --d === 0) return src.slice(k, j + 1); }
  throw new Error("unclosed");
};
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");

describe("the panel's merge paths go through the guard", () => {
  test("Merge pull request asks before the merge form", () => {
    const b = code(body("const runMerge = async ("));
    expect(b).toContain("confirmMergeGuard(detail, ask)");
    expect(b.indexOf("confirmMergeGuard(")).toBeLessThan(b.indexOf("askMerge("));
  });
  test("Merge when green asks before it arms", () => {
    const b = code(body("const doAutoMerge = async ("));
    expect(b).toContain("confirmMergeGuard(detail, ask)");
    expect(b.indexOf("confirmMergeGuard(")).toBeLessThan(b.indexOf("api.prMerge("));
  });
});
