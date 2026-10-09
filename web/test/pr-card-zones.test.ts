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
 * here: three zones and one footer, each a named grid area the wide layout
 * rearranges. A zone renamed in one file and not the other leaves the wide
 * lane stacked, and only a screen would say so.
 */
describe("the card's zones and the wide layout agree", () => {
  const board = readFileSync(new URL("../src/components/TriageBoard.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  const wide = css.slice(css.indexOf("@container agx-prc (min-width: 760px)"));
  const wideBlock = wide.slice(0, wide.indexOf("\n}\n"));
  const narrow = css.slice(css.indexOf(".agx-prc-main {")).split("}")[0]!;
  const areas = (block: string) => block.match(/grid-template-areas:\s*([^;]+);/)?.[1] ?? "";

  // [class the card draws, the area the layout places it in]
  for (const [zone, area] of [["id", "id"], ["title", "tt"], ["ac", "ac"], ["stand", "st"], ["event", "ev"]] as const) {
    test(`${zone}: drawn by the card, given its area, and placed by both layouts`, () => {
      expect(board).toContain(`agx-prc-${zone}`);
      expect(css).toMatch(new RegExp(`\\.agx-prc-${zone} \\{[^}]*grid-area: ${area};`));
      expect(areas(narrow), "the narrow layout names it").toMatch(new RegExp(`\\b${area}\\b`));
      expect(areas(wideBlock), "the wide layout names it").toMatch(new RegExp(`\\b${area}\\b`));
    });
  }
  test("the card is its own container, so the lane's width is what decides", () => {
    expect(board).toContain("agx-prc overflow-hidden");
    expect(css).toContain(".agx-prc { container-type: inline-size; container-name: agx-prc; }");
  });
  test("the card is ONE surface: no tracker bar over a nested panel", () => {
    expect(board.split("height: 42,").length - 1).toBe(0);
    expect(board).not.toContain("agx-prc-body");
  });
});
