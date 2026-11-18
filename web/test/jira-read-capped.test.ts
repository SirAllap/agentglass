/*
 * "and more behind it" and the "+" on the count follow the read the cards came from. Measured on a Team view (a search
 * across the site, narrowed here by Hide done and Current sprint): the footer said "1000 of 1000" with nothing about the
 * cap, and "50 of 50" for the first page of a search, because only the board's own read said whether it was cut short.
 */
import { describe, expect, test } from "bun:test";
import { readIsCapped } from "../src/components/jira/list/model.ts";
import { countLine } from "../src/components/jira/list/headerModel.ts";

describe("readIsCapped", () => {
  test("a search the site cut at its cap is capped even when the board's read was whole", () => {
    expect(readIsCapped(false, { q: "assignee is not EMPTY", truncated: true }, "assignee is not EMPTY")).toBe(true);
  });
  test("the board's own cap still counts", () => {
    expect(readIsCapped(true, null, "")).toBe(true);
  });
  test("a capped answer for another search is not this read's", () => {
    expect(readIsCapped(false, { q: "project = ORBIT", truncated: true }, "assignee is not EMPTY")).toBe(false);
  });
  test("a whole answer is not capped", () => {
    expect(readIsCapped(false, { q: "a", truncated: false }, "a")).toBe(false);
    expect(readIsCapped(false, undefined, "a")).toBe(false);
  });
  test("the count line carries the plus", () => {
    expect(countLine(41, 1000, readIsCapped(false, { q: "a", truncated: true }, "a")).head).toBe("41 of 1000+");
  });
});

import { countBasis, walkWanted } from "../src/components/jira/list/model.ts";

describe("a filter on and a first page cut short", () => {
  test("the rest is fetched: truncated page, filter on, same search", () => {
    expect(walkWanted(false, true, { q: "a", truncated: true }, "a")).toBe(true);
  });
  test("not without a filter, not for a whole page, not for another search", () => {
    expect(walkWanted(false, false, { q: "a", truncated: true }, "a")).toBe(false);
    expect(walkWanted(false, true, { q: "a", truncated: false }, "a")).toBe(false);
    expect(walkWanted(false, true, { q: "b", truncated: true }, "a")).toBe(false);
  });
  test("Enter still walks everything", () => {
    expect(walkWanted(true, false, null, "a")).toBe(true);
  });
  test("the count is the site's, never N of N+ while filters are on", () => {
    const whole = countBasis(true, true, { q: "a", truncated: false }, "a", 288);
    expect(countLine(288, whole.total, whole.truncated).head).toBe("288 of 288");
    const cut = countBasis(true, true, { q: "a", truncated: true, total: 1342 }, "a", 1000);
    expect(countLine(288, cut.total, cut.truncated).head).toBe("288 of 1342");
  });
  test("no filter: the board's own reading stands", () => {
    expect(countBasis(false, true, null, "", 297)).toEqual({ total: 297, truncated: true });
  });
});

import { boardIsCut } from "../src/components/jira/list/model.ts";

describe("a board whose only cut part is the backlog", () => {
  test("297 loaded, Current sprint on: not cut, so no plus and no 'more behind it'", () => {
    const cut = boardIsCut(true, true, true);
    expect(cut).toBe(false);
    expect(countLine(297, 297, cut).head).toBe("297 of 297");
  });
  test("without Current sprint the backlog is part of the view: still cut", () => {
    expect(boardIsCut(true, true, false)).toBe(true);
  });
  test("a cut sprint read is cut whatever the filter", () => {
    expect(boardIsCut(true, false, true)).toBe(true);
  });
  test("a whole read is not cut", () => {
    expect(boardIsCut(false, false, true)).toBe(false);
  });
});
