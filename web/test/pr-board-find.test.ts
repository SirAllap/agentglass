/*
 * Finding on the pull-request board.
 *
 * Two searches used to live on this screen and they answered differently: the
 * app's find bar painted the words it could see and said 1/1, while the board's
 * own box lit the cards that answer and said 1 of 16. The difference is not
 * cosmetic — a card whose only connection to "adadoe" is a requested reviewer
 * has nothing on screen to paint, and it is exactly the card somebody typing a
 * name is looking for.
 *
 * This pins the rule both of them now use.
 */
import { describe, expect, test } from "bun:test";
import { haystack, matchIndex, prHits, prMatches, stepMatch } from "../src/lib/prBoardFind.ts";

const card = {
  number: 1042,
  title: "Inaccurate break times in the health board",
  author: "riverstone",
  headRefName: "orbit-1042-break-times",
  baseRefName: "master",
  labels: [{ name: "regression" }],
  assignees: ["marlowe"],
  reviewers: [{ login: "adadoe" }],
};

describe("what the card's work item answers to", () => {
  const linked = { ...card, card: { id: "8ab12cd34", customId: "ORBIT-1042", status: "code review", title: "Hang-up eval", people: [{ name: "Ada Lin" }] } };
  test("its id, as the chip draws it", () => {
    expect(prMatches(linked, "ORBIT-1042")).toBe(true);
    expect(prMatches(linked, "orbit-1042")).toBe(true);
  });
  test("the tracker's own id when there is no human one, because that is what the chip says then", () => {
    expect(prMatches({ ...card, card: { id: "8ab12cd34", status: "x" } }, "8ab12cd34")).toBe(true);
    expect(prMatches(linked, "8ab12cd34")).toBe(false);
  });
  test("its status", () => {
    expect(prMatches(linked, "code review")).toBe(true);
  });
  test("the people on it by name, which the faces only show as initials", () => {
    expect(prMatches(linked, "ada lin")).toBe(true);
  });
  test("but not its title, which the board does not draw", () => {
    expect(prMatches(linked, "hang-up")).toBe(false);
  });
  test("a pull request without a card answers to none of it", () => {
    expect(prMatches(card, "code review")).toBe(false);
    expect(prMatches(card, "ORBIT-9999")).toBe(false);
  });
});

describe("what a card answers to", () => {
  test("the things it shows", () => {
    expect(prMatches(card, "break")).toBe(true);
    expect(prMatches(card, "riverstone")).toBe(true);
    expect(prMatches(card, "regression")).toBe(true);
    // Both spellings of the number, because both are typed.
    expect(prMatches(card, "#1042")).toBe(true);
    expect(prMatches(card, "1042")).toBe(true);
  });

  /* The half a text search cannot reach, and the reason this rule exists. */
  test("and the people on it, who are only half drawn", () => {
    expect(prMatches(card, "adadoe")).toBe(true);
    expect(prMatches(card, "marlowe")).toBe(true);
    expect(prMatches(card, "orbit-1042-break-times")).toBe(true);
  });

  test("case and stray spaces do not matter", () => {
    expect(prMatches(card, "  ADAdoe ")).toBe(true);
  });

  test("no needle is not a filter", () => {
    expect(prMatches(card, "")).toBe(true);
    expect(prMatches(card, "   ")).toBe(true);
    // But it is not a count either: an empty box lights nothing.
    expect(prHits([card], "")).toBe(0);
  });

  test("something nobody on the card knows about", () => {
    expect(prMatches(card, "kubernetes")).toBe(false);
    expect(haystack(card)).not.toContain("kubernetes");
  });
});

describe("stepping between matches", () => {
  const flags = [false, true, false, true, true];

  test("forwards, backwards and wrapping", () => {
    expect(stepMatch(flags, 1, 1)).toBe(3);
    expect(stepMatch(flags, 4, 1)).toBe(1);
    expect(stepMatch(flags, 3, -1)).toBe(1);
    expect(stepMatch(flags, 1, -1)).toBe(4);
  });

  test("from nowhere, the first match — not the second", () => {
    expect(stepMatch(flags, -1, 1)).toBe(1);
    expect(stepMatch(flags, -1, -1)).toBe(4);
  });

  test("nothing matching moves nothing", () => {
    expect(stepMatch([false, false], 0, 1)).toBe(-1);
    expect(stepMatch([], -1, 1)).toBe(-1);
  });

  test("the counter is 1-based, and 0 when the cursor is off a match", () => {
    expect(matchIndex(flags, 1)).toBe(1);
    expect(matchIndex(flags, 3)).toBe(2);
    expect(matchIndex(flags, 4)).toBe(3);
    expect(matchIndex(flags, 0)).toBe(0);
    expect(matchIndex(flags, 99)).toBe(0);
  });
});

describe("the board and the bar agree", () => {
  const cards = [card, { ...card, number: 7, title: "Something else", reviewers: [], assignees: [], headRefName: "x" }];

  test("the count is cards, not words on screen", () => {
    // "break" appears twice in the first card's text (title and branch) and the
    // answer is one CARD. That is the number the board prints.
    expect(prHits(cards, "break")).toBe(1);
    expect(prHits(cards, "master")).toBe(2);
  });
});
