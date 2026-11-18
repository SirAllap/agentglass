/*
 * The board's multi-select and bulk "Tell me when…": the decisions the approved mockup states, tested pure.
 */
import { describe, expect, it } from "bun:test";
import type { PrWatch } from "../../shared/types.ts";
import {
  allPicked, applyItems, bellTag, canApply, cardRulesOf, cardState, footLine, keepOnBoard, laneToggle, leftNote, pickClick, startChosen, toastLine, undoItems, undoSkippedLine,
  type CardRule,
} from "../src/lib/prBulkPick.ts";

const lane = [1042, 1043, 1044, 1045, 1046];

describe("picking", () => {
  it("a plain press toggles one card and makes it the anchor", () => {
    const a = pickClick(new Set(), null, 1043, "flight", lane, false);
    expect([...a.picked]).toEqual([1043]);
    expect(a.anchor).toEqual({ n: 1043, lane: "flight" });
    expect([...pickClick(a.picked, a.anchor, 1043, "flight", lane, false).picked]).toEqual([]);
  });
  it("shift picks the run between the anchor and the card, in lane order, either way round", () => {
    const a = pickClick(new Set(), null, 1045, "flight", lane, false);
    const b = pickClick(a.picked, a.anchor, 1043, "flight", lane, true);
    expect([...b.picked].sort()).toEqual([1043, 1044, 1045]);
    expect(b.anchor.n).toBe(1045);
  });
  it("shift into another lane is a plain toggle: a range never crosses lanes", () => {
    const a = pickClick(new Set(), null, 1043, "flight", lane, false);
    const b = pickClick(a.picked, a.anchor, 2001, "land", [2000, 2001], true);
    expect([...b.picked].sort()).toEqual([1043, 2001]);
    expect(b.anchor).toEqual({ n: 2001, lane: "land" });
  });
  it("Select all picks the lane, and the second press clears just that lane", () => {
    const other = new Set([9]);
    const on = laneToggle(other, lane);
    expect(allPicked(on, lane)).toBe(true);
    expect([...laneToggle(on, lane)]).toEqual([9]);
    expect(allPicked(new Set(), [])).toBe(false);
  });
  it("a picked PR that leaves the board drops out and is named once", () => {
    const r = keepOnBoard(new Set([1, 2, 3]), new Set([1, 3]));
    expect([...r.picked]).toEqual([1, 3]);
    expect(r.left).toEqual([2]);
    expect(leftNote(1051, "MERGED")).toBe("#1051 merged, left");
    expect(leftNote(1051, undefined)).toBe("#1051 left the board");
    const same = new Set([1]);
    expect(keepOnBoard(same, new Set([1])).picked).toBe(same);
  });
});

const w = (type: PrWatch["rule"]["type"], active = true): PrWatch =>
  ({ id: type, repo: "acme/orbit", number: 7, rule: type === "check" ? { type, match: "evals", on: "fail" } : { type }, active } as PrWatch);

describe("the bulk popover", () => {
  const have: CardRule[][] = [[], ["ci-fail"], ["ci-pass", "comment"]];
  it("reads only active card rules, in card order", () => {
    expect(cardRulesOf([w("comment"), w("ci-pass"), w("check"), w("ci-fail", false)])).toEqual(["ci-pass", "comment"]);
  });
  it("opens with what every one has; a card only some have is mixed until pressed", () => {
    expect([...startChosen([["ci-pass"], ["ci-pass", "comment"]])]).toEqual(["ci-pass"]);
    const chosen = startChosen(have);
    expect(chosen.size).toBe(0);
    expect(cardState("ci-fail", chosen, new Set(), have)).toBe("mixed");
    expect(cardState("ci-fail", chosen, new Set(["ci-fail"]), have)).toBe("false");
    expect(cardState("ci-pass", new Set(["ci-pass"]), new Set(), have)).toBe("true");
    expect(cardState("ci-fail", chosen, new Set(), [[], []])).toBe("false");
  });
  it("Apply writes exactly the chosen cards on every PR, replacing their choice", () => {
    const items = applyItems([{ number: 1, title: "a" }, { number: 2, title: "b" }], new Set<CardRule>(["comment", "ci-pass"]));
    expect(items).toEqual([
      { number: 1, title: "a", rules: [{ type: "ci-pass" }, { type: "comment" }] },
      { number: 2, title: "b", rules: [{ type: "ci-pass" }, { type: "comment" }] },
    ]);
    expect(applyItems([{ number: 1, title: "a" }], new Set())[0]!.rules).toEqual([]);
  });
  it("Apply is off with nothing on and nothing to take off; the footer says which", () => {
    expect(canApply(new Set(), 0)).toBe(false);
    expect(canApply(new Set(), 2)).toBe(true);
    expect(footLine(new Set(), 3, 0)).toBe("Pick at least one");
    expect(footLine(new Set(), 3, 2)).toBe("Nothing on: removes the watch from 2");
    expect(footLine(new Set<CardRule>(["ci-pass", "comment"]), 3, 0)).toBe("Everything is green + Someone comments, on 3");
  });
  it("the toast and the card's bell tag", () => {
    expect(toastLine(3, new Set<CardRule>(["ci-pass"]))).toBe("Watching 3 pull requests: tell me when everything is green");
    expect(toastLine(1, new Set())).toBe("Stopped watching 1 pull request");
    expect(bellTag([])).toBeNull();
    expect(bellTag(["ci-pass"])).toBe("Green");
    expect(bellTag(["ci-pass", "comment"])).toBe("Green +1");
  });
});

describe("undo", () => {
  it("sends each PR's old rules with what Apply set as the expectation", () => {
    const set = applyItems([{ number: 1, title: "a" }, { number: 2, title: "b" }], new Set<CardRule>(["ci-pass"]));
    const u = undoItems([{ number: 1, title: "a", rules: [] }, { number: 2, title: "b", rules: [{ type: "comment" }] }], set);
    expect(u).toEqual([
      { number: 1, title: "a", rules: [], expect: [{ type: "ci-pass" }] },
      { number: 2, title: "b", rules: [{ type: "comment" }], expect: [{ type: "ci-pass" }] },
    ]);
    expect(undoSkippedLine([7, 9])).toBe("Undone, except #7, #9 (changed since)");
  });
});
