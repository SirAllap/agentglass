/*
 * The pull-request board's filter builder used to hold its rules in a bare
 * `useState`: nothing read them, nothing wrote them, so a restart threw away
 * whatever somebody had just built. This is the read side, `readFilterSet` —
 * pinned as a pure function so a stored value's shape is checked without a
 * renderer — and a source-level lock that the panel actually reads from and
 * writes to storage, per repository, rather than the two matching in this
 * file alone.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readFilterSet, type FilterSet } from "../src/components/tasks/filters.ts";

const good: FilterSet = {
  join: "and",
  rules: [
    { id: "r1", field: "status", op: "is", values: ["ready for qa"] },
    { id: "r2", field: "assignee", op: "unset", values: [] },
  ],
};

describe("readFilterSet keeps a well-formed set as is", () => {
  test("both rules survive", () => {
    expect(readFilterSet(good)).toEqual(good);
  });

  test("or joins round-trip too", () => {
    const or: FilterSet = { join: "or", rules: [{ id: "r1", field: "tags", op: "not", values: ["x"] }] };
    expect(readFilterSet(or)).toEqual(or);
  });
});

describe("a malformed rule is dropped, not the set around it", () => {
  const base = (bad: unknown) => ({ join: "and", rules: [good.rules[0], bad, good.rules[1]] });

  test("missing field", () => {
    expect(readFilterSet(base({ id: "x", op: "is", values: [] }))).toEqual(good);
  });

  test("missing op", () => {
    expect(readFilterSet(base({ id: "x", field: "status", values: [] }))).toEqual(good);
  });

  test("an op no build has ever written", () => {
    expect(readFilterSet(base({ id: "x", field: "status", op: "contains", values: [] }))).toEqual(good);
  });

  test("values that is not an array", () => {
    expect(readFilterSet(base({ id: "x", field: "status", op: "is", values: "ready" }))).toEqual(good);
  });

  test("values holding something other than strings", () => {
    expect(readFilterSet(base({ id: "x", field: "status", op: "is", values: [1, 2] }))).toEqual(good);
  });

  test("a rule that is not an object at all", () => {
    expect(readFilterSet(base("not a rule"))).toEqual(good);
  });

  test("several bad rules at once still keep both good ones", () => {
    const set = {
      join: "and",
      rules: [good.rules[0], { field: "status" }, good.rules[1], null, { id: "y", op: "is" }],
    };
    expect(readFilterSet(set)).toEqual(good);
  });
});

describe("garbage at the top returns the empty set", () => {
  test("not an object", () => {
    for (const raw of [undefined, null, "not json", 42, true]) {
      expect(readFilterSet(raw)).toEqual({ join: "and", rules: [] });
    }
  });

  test("an object with no recognisable join", () => {
    expect(readFilterSet({ join: "xor", rules: [] })).toEqual({ join: "and", rules: [] });
    expect(readFilterSet({ rules: [] })).toEqual({ join: "and", rules: [] });
  });

  test("rules that is not an array", () => {
    expect(readFilterSet({ join: "and", rules: "none" })).toEqual({ join: "and", rules: [] });
    expect(readFilterSet({ join: "and" })).toEqual({ join: "and", rules: [] });
  });

  test("never throws", () => {
    expect(() => readFilterSet({ join: {}, rules: [{}] })).not.toThrow();
    expect(() => readFilterSet([1, 2, 3])).not.toThrow();
  });
});

/*
 * The read side alone proves nothing about the panel: `readFilterSet` could
 * sit unused next to the same unpersisted `useState` and every test above
 * would still pass. So the wiring itself is pinned against the source —
 * comments stripped first, because a rule against a word can be defeated by
 * writing that word inside a comment instead of code.
 */
describe("the panel actually reads and writes the rules it builds", () => {
  const src = readFileSync(new URL("../src/components/PrPanel.tsx", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  test("the live filter is the store's, per repository (nameWithOwner), not a map of the panel's own", () => {
    expect(code).toContain("const repoSlug = repo?.nameWithOwner ?? null;");
    expect(code).toContain("usePrFilter(repoSlug)");
    expect(code).not.toContain("loadMap<unknown>(FILTERS_KEY)");
    expect(code).not.toContain("saveMap(FILTERS_KEY");
  });

  test("the old flat key is read once by the store, which imports it through lanesFromFlat", () => {
    const store = readFileSync(new URL("../src/lib/prBoardFilterStore.ts", import.meta.url), "utf8");
    expect(store).toContain('LEGACY_FILTERS_KEY = "agentglass.pr.filters"');
    expect(store).toContain("lanesFromFlat(flat.join, flat.rules)");
  });

  test("the deck and the empty board write through the history-keeping setter, not the bare one", () => {
    // `setLaneFilterRaw` skips the one step back that Undo returns to.
    expect(code).toContain("<PrFilterDeck filter={laneFilter} onChange={setLaneFilter}");
    expect(code).toContain("onChange={setLaneFilter} onOpen={setEditingRule}");
    expect(code).not.toContain("onChange={setLaneFilterRaw}");
  });

  test("a search ignores the board's rules", () => {
    expect(code).toContain("const activeLanes = searchingNow ? EMPTY_LANES : laneFilter;");
  });
});
