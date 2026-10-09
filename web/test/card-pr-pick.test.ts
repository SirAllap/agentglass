/*
 * The row chip has room for one pull request. Which one, when a card has
 * several, is the decision this file pins: open beats draft beats merged
 * beats closed, and `clickup/prs` gives no `updatedAt` to break ties with, so
 * within a state the newer number leads.
 */
import { describe, expect, it } from "bun:test";
import { pickCardPr, sortedCardPrs, cardPrTint, type CardPr } from "../src/lib/cardPrPick.ts";

const pr = (over: Partial<CardPr> = {}): CardPr => ({
  number: 100, title: "Round the checkout total once, at the end", state: "OPEN", url: "https://github.example/acme/widgets/pull/100",
  ...over,
});

describe("pickCardPr", () => {
  it("draws nothing for a card with no pull requests", () => {
    expect(pickCardPr([])).toEqual({ kind: "none" });
    expect(pickCardPr(null)).toEqual({ kind: "none" });
    expect(pickCardPr(undefined)).toEqual({ kind: "none" });
  });

  it("is the one pull request, when there is only one", () => {
    const p = pr({ number: 42 });
    expect(pickCardPr([p])).toEqual({ kind: "one", pr: p });
  });

  it("prefers an open pull request over a merged one, regardless of number", () => {
    const merged = pr({ number: 90, state: "MERGED" });
    const open = pr({ number: 12, state: "OPEN" });
    const r = pickCardPr([merged, open]);
    if (r.kind !== "many") throw new Error("expected many");
    expect(r.primary).toBe(open);
    expect(r.rest).toEqual([merged]);
  });

  it("puts a draft ahead of merged and closed, but behind an open one", () => {
    const closed = pr({ number: 5, state: "CLOSED" });
    const merged = pr({ number: 6, state: "MERGED" });
    const draft = pr({ number: 7, state: "OPEN", draft: true });
    const open = pr({ number: 8, state: "OPEN" });
    expect(sortedCardPrs([closed, merged, draft, open])).toEqual([open, draft, merged, closed]);
  });

  it("breaks a tie within the same state by number, newest first", () => {
    const older = pr({ number: 10, state: "OPEN" });
    const newer = pr({ number: 20, state: "OPEN" });
    const r = pickCardPr([older, newer]);
    if (r.kind !== "many") throw new Error("expected many");
    expect(r.primary).toBe(newer);
    expect(r.rest).toEqual([older]);
  });

  it("carries every other pull request in `rest`, sorted the same way", () => {
    const a = pr({ number: 1, state: "CLOSED" });
    const b = pr({ number: 2, state: "MERGED" });
    const c = pr({ number: 3, state: "OPEN" });
    const r = pickCardPr([a, b, c]);
    if (r.kind !== "many") throw new Error("expected many");
    expect(r.primary).toBe(c);
    expect(r.rest).toEqual([b, a]);
  });
});

describe("cardPrTint", () => {
  it("reuses the house colours: open green, draft grey, merged purple, closed red", () => {
    expect(cardPrTint(pr({ state: "OPEN" }))).toBe("var(--success)");
    expect(cardPrTint(pr({ state: "OPEN", draft: true }))).toBe("var(--text3)");
    expect(cardPrTint(pr({ state: "MERGED" }))).toBe("#a371f7");
    expect(cardPrTint(pr({ state: "CLOSED" }))).toBe("var(--error)");
  });

  it("matches the colours TasksPanel's own pull-request list already draws", async () => {
    const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
    expect(src).toContain('{ color: "#a371f7", background: "#a371f721" }');
    expect(src).toContain('{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 13%, transparent)" }');
  });
});
