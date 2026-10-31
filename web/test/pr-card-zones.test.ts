import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { eventLine, splitTitle, stalledDays, standing } from "../src/lib/prCardZones.ts";
import type { PrCheckRollup } from "../../shared/types.ts";

const roll = (o: Partial<PrCheckRollup>): PrCheckRollup => ({
  total: 4, success: 4, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [], ...o,
});
const DAY = 86_400_000;

describe("the title's area prefix", () => {
  test("a short prefix before the first pipe is split off", () => {
    expect(splitTitle("Exports | Restore the bundle")).toEqual({ pre: "Exports", rest: "Restore the bundle" });
  });
  test("a pipe further in is part of the sentence, not a prefix", () => {
    const t = "Restore the bundle on accounts created while it was being wiped | retry";
    expect(splitTitle(t)).toEqual({ pre: "", rest: t });
  });
  test("a prefix with nothing after it is not a prefix", () => {
    expect(splitTitle("Exports | ")).toEqual({ pre: "", rest: "Exports | " });
  });
  test("only the first pipe cuts", () => {
    expect(splitTitle("Exports | a | b")).toEqual({ pre: "Exports", rest: "a | b" });
  });
});

describe("the standing zone", () => {
  test("green says the word and fills the bar", () => {
    expect(standing(roll({}))).toEqual({ word: "green", kind: "green", failing: null, done: 100 });
  });
  test("red says red, and how many, so colour is never the only signal", () => {
    const s = standing(roll({ success: 2, failure: 2, verdict: "red" }));
    expect([s.word, s.failing]).toEqual(["red", "2 checks failing"]);
    expect(standing(roll({ success: 3, failure: 1, verdict: "red" })).failing).toBe("1 check failing");
  });
  test("a suite still running is running, even with a failure in", () => {
    const s = standing(roll({ success: 1, failure: 1, pending: 2, allDone: false, verdict: null }));
    expect(s).toEqual({ word: "1 of 4 in", kind: "pending", failing: null, done: 50 });
  });
  test("nothing reported is an empty track, not a full one", () => {
    expect(standing(roll({ total: 0, success: 0, verdict: null }))).toEqual({ word: "no checks", kind: "none", failing: null, done: 0 });
  });
});

describe("the last-event zone", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const at = (days: number) => new Date(now - days * DAY).toISOString();
  test("a sentence on a card that is moving carries no quiet line", () => {
    expect(eventLine("Waiting on review", at(1), now)).toEqual({ text: "Waiting on review", empty: false, quiet: null });
  });
  test("a week of nothing is said in days", () => {
    expect(eventLine("Waiting on review", at(9), now).quiet).toBe("9 days without activity");
    expect(stalledDays(at(6), now)).toBeNull();
    expect(stalledDays(at(7), now)).toBe(7);
  });
  test("no sentence is said plainly, never a blank row", () => {
    expect(eventLine("  ", at(1), now)).toEqual({ text: "No review activity yet", empty: true, quiet: null });
    expect(eventLine(undefined, at(30), now).quiet).toBeNull();
  });
  test("a date that will not parse is not quiet", () => {
    expect(stalledDays("", now)).toBeNull();
  });
});

/*
 * The card's skeleton is asserted against source, because there is no renderer
 * here: a verdict strip, a ring beside the title and the ticket row, three
 * cells, an event line and a one-row footer, in a box that is 336px and no
 * other width. A zone renamed in the component and not in the stylesheet
 * draws unstyled, and only a screen would say so.
 */
describe("the card's zones and its stylesheet agree", () => {
  const card = readFileSync(new URL("../src/components/PrCard.tsx", import.meta.url), "utf8");
  const board = readFileSync(new URL("../src/components/TriageBoard.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

  for (const zone of ["agx-cd-h", "agx-cd-main", "agx-cd-ring", "agx-cd-t", "agx-cd-tk", "agx-cd-cells", "agx-cd-cell", "agx-cd-evl", "agx-cd-f"]) {
    test(`${zone}: drawn by the card and styled`, () => {
      expect(card).toContain(zone);
      expect(css).toMatch(new RegExp(`\\.${zone}[ ,{[:]`));
    });
  }
  test("the card is exactly 336px: min = max, never shrinks, no container-query variant", () => {
    expect(css).toMatch(/\.agx-cd \{[^}]*flex: none;\s*width: 336px; min-width: 336px; max-width: 336px;/);
    expect(css).not.toMatch(/@container agx-prc|container-name: agx-prc/);
  });
  test("the card is ONE surface and the board hands it data, not markup", () => {
    expect(board).toContain("<PrCard ");
    expect(board).not.toContain("agx-prc-body");
    expect(board.split("height: 42,").length - 1).toBe(0);
  });
});
