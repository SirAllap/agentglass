/*
 * A search showed one card with no checks, "+0 −0 · 0f", a grey empty bar, and
 * three different counts ("1 of 200", "408 matches", "1 pull requests").
 *
 * Measured cause: the panel built search results from a sweep of the scope
 * (page after page, no query), and the sweep kept the first pass of each page —
 * rows whose checks and diff size GitHub had not been asked for yet. Pinned
 * here: the answer GitHub gives to the search is what is drawn, the heading
 * counts the drawn cards, a row still being read is a skeleton not a sentence,
 * and a search that is still out leaves the cards in hand where they are.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { LANE_MIN_PX, RESULT_COLUMNS, resultColumn, SEARCH_HINT, knownLogins, matchedAs, normalizeFree, personIn, resultsHeading, searchPool, stillReading, toServerQuery } from "../src/lib/prSearch.ts";
import { DETAIL_BATCH, DETAIL_REACH, nextDetailBatch } from "../src/lib/useRowDetails.ts";

describe("the heading over a search", () => {
  it("is the number of cards drawn, in plain words", () => {
    expect(resultsHeading(1)).toBe("1 result");
    expect(resultsHeading(0)).toBe("0 results");
    expect(resultsHeading(12)).toBe("12 results");
  });
});

describe("what a search is made of", () => {
  const answer = [{ n: 668 }, { n: 640 }];
  const inHand = [{ n: 1 }];
  it("is GitHub's answer once it has been asked, whatever the sweep holds", () => {
    expect(searchPool({ answered: true, answer, inHand })).toBe(answer);
  });
  it("is the open rows in hand until then", () => {
    expect(searchPool({ answered: false, answer, inHand })).toBe(inHand);
  });
});

describe("a row the second pass has not reached", () => {
  it("is reading, and only that exact state", () => {
    expect(stillReading({ checksLoaded: false })).toBe(true);
    expect(stillReading({ checksLoaded: true })).toBe(false);
    expect(stillReading({ checksLoaded: undefined })).toBe(false);
  });
});

describe("the panel's wiring", () => {
  const panel = readFileSync(new URL("../src/components/PrPanel.tsx", import.meta.url), "utf8");
  const board = readFileSync(new URL("../src/components/TriageBoard.tsx", import.meta.url), "utf8");
  const code = (t: string) => t.split("\n").filter((l) => !/^\s*(\/?\*|\/\/)/.test(l)).join("\n");
  it("never says 'open … press Enter' over a search", () => {
    expect(code(panel)).not.toContain("open pull requests matching");
  });
  it("counts the drawn cards in the filter bar while searching", () => {
    expect(code(panel)).toContain("total={searching ? visiblePrs.length");
  });
  it("draws a reading row as a skeleton, never as 'not finished'", () => {
    expect(code(board)).toContain("stillReading(p)");
    expect(code(board)).not.toContain("not finished");
  });
});

describe("the cards of a search fill themselves in", () => {
  const rows = (n: number, loaded: boolean) => Array.from({ length: n }, (_, i) => ({ number: i + 1, checksLoaded: loaded ? true : false as boolean | undefined }));
  it("asks only for rows still being read, never twice", () => {
    const list = [...rows(3, true), { number: 90, checksLoaded: false }, { number: 91, checksLoaded: false }];
    expect(nextDetailBatch(list, new Set())).toEqual([90, 91]);
    expect(nextDetailBatch(list, new Set([90]))).toEqual([91]);
    expect(nextDetailBatch(list, new Set([90, 91]))).toEqual([]);
  });
  it("is one bounded batch within reach of the top, never the whole list", () => {
    const list = rows(300, false);
    const b = nextDetailBatch(list, new Set());
    expect(b.length).toBe(DETAIL_BATCH);
    expect(b[0]).toBe(1);
    expect(nextDetailBatch(list, new Set(Array.from({ length: DETAIL_REACH }, (_, i) => i + 1)))).toEqual([]);
  });
  it("leaves a row whose checks were never in question alone", () => {
    expect(nextDetailBatch([{ number: 1, checksLoaded: undefined }], new Set())).toEqual([]);
  });
});

describe("one pull request, however it is typed", () => {
  it("#19811, 19811, PR 19811 and pr#19811 are all 19811", () => {
    for (const q of ["#19811", "19811", "PR 19811", "pr#19811", "pull #19811"]) expect(toServerQuery(q)).toBe("19811");
  });
  it("leaves words and qualifiers alone", () => {
    expect(normalizeFree("fix the bridge")).toBe("fix the bridge");
    expect(toServerQuery("author:ana PR #7 bridge")).toBe("author:ana 7 bridge");
  });
});

describe("a person", () => {
  const rows = [{ author: "Ana-Dev", assignees: ["bo"], reviewers: [{ login: "cy" }] }];
  const logins = knownLogins(rows);
  it("a bare known login, with or without @, asks for everything that person is in", () => {
    expect(toServerQuery("ana-dev", logins)).toBe("involves:ana-dev");
    expect(toServerQuery("@cy", logins)).toBe("involves:cy");
  });
  it("an unknown word stays a word, and a typed role stays that role", () => {
    expect(toServerQuery("bridge", logins)).toBe("bridge");
    expect(toServerQuery("reviewer:cy", logins)).toBe("reviewer:cy");
    expect(personIn("reviewer:cy")).toBe("cy");
    expect(personIn("ana-dev bridge", logins)).toBe("ana-dev");
    expect(personIn("bridge", logins)).toBeNull();
  });
  it("says why a card matched, from what the row carries", () => {
    expect(matchedAs({ author: "ana", reviewers: [{ login: "ana" }], talk: [{ who: "Ana" }] }, "ana")).toBe("ana: author, reviewer, commented");
    expect(matchedAs({ author: "bo" }, "ana")).toBeNull();
    expect(matchedAs({ author: "ana" }, null)).toBeNull();
  });
  it("the hint names what the box understands", () => {
    for (const w of ["#123", "author:", "assignee:", "reviewer:", "title"]) expect(SEARCH_HINT).toContain(w);
  });
});

describe("a search has rules of its own", () => {
  const panel = readFileSync(new URL("../src/components/PrPanel.tsx", import.meta.url), "utf8");
  const code = (x: string) => x.split("\n").filter((l) => !/^\s*(\/?\*|\/\/)/.test(l)).join("\n");
  it("the board's saved rules are never what a search runs through", () => {
    const c = code(panel);
    expect(c).toContain("const activeRules = searchingNow ? searchRules : rules;");
    expect(c).toContain("[pool, answered, filters, activeRules");
    expect(c).toContain("<FilterBuilder bare fields={ruleFields} value={activeRules}");
    expect(c).toContain("rules: activeRules, setRules: setActiveRules");
  });
  it("the counts are one number: nothing walks the scope for an 'of 200'", () => {
    expect(code(panel)).not.toContain("SWEEP_PAGES");
    expect(code(panel)).not.toContain("swept=");
  });
  it("typing sends nothing: GitHub is asked on Enter only", () => {
    const c = code(panel);
    // The one effect that reads the list is keyed on what was SENT, never on what is typed.
    const load = c.slice(c.indexOf("const loadList = useCallback("));
    const deps = /\}, \[([^\]]*)\]\);/.exec(load)![1];
    expect(deps).toContain("serverQuery");
    expect(deps.split(",").map((x) => x.trim())).not.toContain("query");
    // The server query is set from exactly two places: Enter (runSearch) and an errand's jump.
    const sets = c.split("\n").filter((l) => l.includes("setServerQuery(") && !l.includes("setServerQuery(\"\")"));
    expect(sets.length).toBe(2);
    expect(c).toContain("const runSearch = useCallback(() => {");
    expect(c).toContain("setServerQuery(wanted);");
    // No timer anywhere turns what is typed into a search.
    expect(c).not.toMatch(/setTimeout\([^)]*setServerQuery/);
  });
});

describe("a result is the board's card, at the board's width", () => {
  it("a column is a lane's share of the panel, never below a lane's floor", () => {
    expect(resultColumn(3)).toBe(`minmax(max(${LANE_MIN_PX}px, calc((100% - 20px) / 3)), 1fr)`);
    expect(RESULT_COLUMNS).toBe(3);
    expect(resultColumn(1)).toContain("calc((100% - 0px) / 1)");
  });
  it("the board and its results are drawn from the same floor", () => {
    const board = readFileSync(new URL("../src/components/TriageBoard.tsx", import.meta.url), "utf8");
    expect(board).not.toContain("minmax(268px");
    expect(board).toContain("resultColumn(RESULT_COLUMNS)");
  });
});
