import { describe, expect, test } from "bun:test";
import type { CardPr } from "../../shared/providers.ts";
import { cardPrsQuery, needsFoundNote, prLine } from "../src/model/cardPrs.ts";

const pr = (over: Partial<CardPr> = {}): CardPr =>
  ({ number: 101, title: "Add retry", state: "OPEN", url: "https://github.com/acme/orbit/pull/101", ...over });

describe("what to ask", () => {
  const card = { id: "86abc", customId: "ORBIT-1042", list: "orbit", custom: [{ name: "GitHub Url", value: "https://github.com/acme/orbit/pull/7" }] };
  test("the card, its GitHub field and the checkout named like its list", () => {
    const q = new URLSearchParams(cardPrsQuery(card as never, [{ root: "/w/orbit", name: "orbit" }]));
    expect(q.get("card")).toBe("ORBIT-1042");
    expect(q.get("field")).toBe("https://github.com/acme/orbit/pull/7");
    expect(q.get("root")).toBe("/w/orbit");
  });
  test("a card with neither asks with its id alone", () => {
    expect(cardPrsQuery({ id: "86abc", list: "Sprint" } as never, [{ root: "/w/orbit", name: "orbit" }])).toBe("card=86abc");
  });
});

describe("whose it is", () => {
  test("yours, somebody's, or unknown", () => {
    expect(prLine(pr({ mine: true, author: "ada", stated: true }))).toBe("Open · yours");
    expect(prLine(pr({ author: "bob-r" }))).toBe("Open · @bob-r");
    expect(prLine(pr({ draft: true }))).toBe("Draft · found by search");
    expect(prLine(pr({ stated: true, state: "MERGED" }))).toBe("Merged");
    // The card's field names a pull request the server could not read the state of.
    expect(prLine(pr({ title: "", state: "", stated: true, mine: true }))).toBe("yours");
    expect(prLine(pr({ title: "", state: "", stated: true }))).toBe("");
  });
  test("the long warning is for a guess nobody has named", () => {
    expect(needsFoundNote([pr({ author: "bob-r" }), pr({ mine: true })])).toBe(false);
    expect(needsFoundNote([pr()])).toBe(true);
    expect(needsFoundNote([pr({ stated: true })])).toBe(false);
  });
});

import { initialsOf } from "../src/model/initials.ts";
describe("initials when there is no picture", () => {
  test("first and last word, one word gives two letters, nothing gives a mark", () => {
    expect(initialsOf("Ada Lovelace")).toBe("AL");
    expect(initialsOf("Ada Byron Lovelace")).toBe("AL");
    expect(initialsOf("bob")).toBe("BO");
    expect(initialsOf("  ")).toBe("?");
  });
});
