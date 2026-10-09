/*
 * Two stacked cards, one pull request that names both. The chip of each card
 * has to lead with the pull request cut for it, and the one that only names it
 * stays listed, marked and behind.
 */
import { describe, expect, it } from "bun:test";
import { cardPrInk, cardPrTint, isRelated, pickCardPr, relatedNote, restCounts, sortedCardPrs, type CardPr } from "../src/lib/cardPrPick.ts";

const pr = (number: number, over: Partial<CardPr> = {}): CardPr => ({
  number, title: `Pull request ${number}`, state: "OPEN", url: `https://github.example/acme/widgets/pull/${number}`, ...over,
});
const own = (n: number, o: Partial<CardPr> = {}) => pr(n, { link: "own", ...o });
const rel = (n: number, o: Partial<CardPr> = {}) => pr(n, { link: "mention", belongsTo: "ORBIT-1042", ...o });

describe("the chip leads with the card's own pull request", () => {
  it("two stacked cards: the newer pull request is the chip of its own card only", () => {
    const base = own(101);
    const top = own(102);
    // Card below: its search returns both, the top one only mentions it.
    const below = pickCardPr([base, { ...top, link: "mention", belongsTo: "ORBIT-2002" }]);
    if (below.kind !== "many") throw new Error("many");
    expect(below.primary.number).toBe(101);
    expect(below.rest.map((p) => p.number)).toEqual([102]);
    // Card on top: it owns 102; 101 is not in its search, or is a mention.
    const above = pickCardPr([top, { ...base, link: "mention", belongsTo: "ORBIT-2001" }]);
    if (above.kind !== "many") throw new Error("many");
    expect(above.primary.number).toBe(102);
  });

  it("own beats mention whatever the state or the number", () => {
    expect(sortedCardPrs([rel(500), own(3, { state: "CLOSED" })]).map((p) => p.number)).toEqual([3, 500]);
    expect(sortedCardPrs([rel(500), own(3, { state: "MERGED" }), own(4, { draft: true })]).map((p) => p.number)).toEqual([4, 3, 500]);
  });

  it("within a kind the old order stands: state, yours, newest", () => {
    expect(sortedCardPrs([own(1, { state: "MERGED" }), own(2), own(3, { mine: true }), own(4)]).map((p) => p.number)).toEqual([3, 4, 2, 1]);
    expect(sortedCardPrs([rel(1, { state: "MERGED" }), rel(2)]).map((p) => p.number)).toEqual([2, 1]);
  });

  it("a card with only a mention shows it, as a related chip", () => {
    const r = pickCardPr([rel(77)]);
    expect(r).toEqual({ kind: "one", pr: rel(77) });
    expect(isRelated(rel(77))).toBe(true);
  });

  it("a card with nothing shows nothing", () => {
    expect(pickCardPr([])).toEqual({ kind: "none" });
  });

  it("a pull request without a kind (an older server, a stated link) is the card's own", () => {
    expect(isRelated(pr(1))).toBe(false);
    expect(sortedCardPrs([rel(9), pr(1, { state: "CLOSED" })])[0]!.number).toBe(1);
  });

  it("one pull request that names three cards is a mention for two of them and sorts last for each", () => {
    for (const mine of [1, 2, 3]) {
      const list = [own(40 + mine), rel(900)];
      expect(sortedCardPrs(list).map((p) => p.number)).toEqual([40 + mine, 900]);
    }
  });
});

describe("the count behind the chip", () => {
  it("tells own from related", () => {
    expect(restCounts([own(1), rel(2), rel(3)])).toEqual({ own: 1, related: 2 });
    expect(restCounts([])).toEqual({ own: 0, related: 0 });
  });
});

describe("how a related pull request is drawn", () => {
  it("has its own tint, whatever its state, and says whose it is", () => {
    for (const s of ["OPEN", "MERGED", "CLOSED"]) {
      expect(cardPrTint(rel(5, { state: s }))).toBe("var(--info)");
      expect(cardPrInk(rel(5, { state: s }))).toBe("var(--info-ink)");
    }
    expect(cardPrTint(own(5))).not.toBe("var(--info)");
    expect(relatedNote(rel(5, { belongsTo: "ORBIT-2002" }))).toBe("mentions this card; belongs to ORBIT-2002");
    expect(relatedNote(rel(5, { belongsTo: undefined }))).toBe("mentions this card");
  });
});
