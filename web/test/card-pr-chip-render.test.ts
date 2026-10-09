/*
 * The board chip, drawn: a pull request cut for the card and one that only
 * names it must not look alike, and the popover names its people by face.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CardPrChip, CardPrDetailRow } from "../src/components/CardPrChip.tsx";
import { pickCardPr, type CardPr } from "../src/lib/cardPrPick.ts";

const pr = (n: number, o: Partial<CardPr> = {}): CardPr =>
  ({ number: n, title: `Pull request ${n}`, state: "OPEN", url: `https://github.com/acme/orbit/pull/${n}`, ...o });
const chip = (prs: CardPr[]) =>
  renderToStaticMarkup(React.createElement(CardPrChip, { pick: pickCardPr(prs), onOpen() {} }));

describe("CardPrChip", () => {
  test("a card's own pull request is solid and says nothing about mentioning", () => {
    const html = chip([pr(1, { link: "own" })]);
    expect(html).toContain("#1");
    expect(html).toContain("1px solid");
    expect(html).not.toContain("mentions this card");
  });

  test("a mention-only card gets the dashed edge, the info tint and the sentence", () => {
    const html = chip([pr(2, { link: "mention", belongsTo: "ORBIT-2002" })]);
    expect(html).toContain("1px dashed");
    expect(html).toContain("var(--info)");
    expect(html).toContain("mentions this card; belongs to ORBIT-2002");
  });

  test("the own one leads, and the mention behind it is counted apart from '+N'", () => {
    const html = chip([pr(9, { link: "mention" }), pr(3, { link: "own" })]);
    expect(html.indexOf("#3")).toBeGreaterThan(-1);
    expect(html).not.toContain("#9");
    expect(html).toContain("1 related, only names this card");
    expect(html).not.toContain("+1</span>");
  });
});

describe("CardPrDetailRow", () => {
  const row = (p: CardPr) => renderToStaticMarkup(React.createElement(CardPrDetailRow, { p, onOpen() {}, trailing: null }));
  test("a mention says whose it is; an own one stays as it was", () => {
    expect(row(pr(5, { link: "mention", belongsTo: "ORBIT-2002" }))).toContain("mentions this card; belongs to ORBIT-2002");
    expect(row(pr(5, { link: "own" }))).not.toContain("mentions this card");
  });
});
