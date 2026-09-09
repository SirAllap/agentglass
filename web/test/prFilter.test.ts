// The PR filter model, pinned. The invariants that matter: parseQuery never
// throws and never empties the list on garbage input; the string is the single
// source of truth, so parse<->serialize round-trips; facets are OR within /
// AND across; per-option counts ignore the facet's own selection; and checks
// that haven't loaded fail open instead of hiding rows.
import { describe, expect, test } from "bun:test";
import type { PrSummary } from "../../shared/types.ts";
import {
  parseQuery, serializeQuery, applyFilters, buildFacets, toggleFacet, activeCount, DEFAULT_SORT,
  readPrField, builderFields, queryToRules,
} from "../src/lib/prFilter.ts";
import { applyWith } from "../src/components/tasks/filters.ts";

let seq = 100;
function pr(over: Partial<PrSummary> = {}): PrSummary {
  seq += 1;
  return {
    number: over.number ?? seq,
    // Defaulted before the spread, so a case can still say CONFLICTING.
    mergeable: "MERGEABLE",
    title: "a pull request",
    author: "octocat",
    state: "OPEN",
    isDraft: false,
    headRefName: "feature",
    baseRefName: "main",
    url: "",
    updatedAt: "2026-07-20T00:00:00Z",
    reviewDecision: null,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    labels: [],
    assignees: [],
    milestone: null,
    checks: { total: 0, success: 0, failure: 0, skipped: 0, pending: 0, allDone: false, verdict: null, failing: [] },
    checksLoaded: true,
    ...over,
  };
}

describe("parseQuery is total", () => {
  test("empty / whitespace parses to a neutral state", () => {
    for (const s of ["", "   ", "\n\t"]) {
      const f = parseQuery(s);
      expect(f.text).toBe("");
      expect(activeCount(f)).toBe(0);
      expect(f.sort).toBe(DEFAULT_SORT);
    }
  });

  test("unknown keys, unclosed quotes and lone colons never throw", () => {
    for (const junk of ['foo:bar', 'label:"unclosed', ':::', 'author:', '-', 'a:b:c', '"']) {
      expect(() => parseQuery(junk)).not.toThrow();
      expect(() => applyFilters([pr()], parseQuery(junk))).not.toThrow();
    }
  });

  test("a no-constraint token (empty value, bare key) does NOT empty the list", () => {
    const rows = [pr(), pr(), pr()];
    for (const q of ["author:", "label:", "sort:", "sort:bogus", "review:", "   "]) {
      expect(applyFilters(rows, parseQuery(q))).toHaveLength(3);
    }
  });

  test("free text that matches nothing empties the list — that is search working, not a bug", () => {
    expect(applyFilters([pr({ title: "hello" })], parseQuery("zzz-nope"))).toHaveLength(0);
  });

  test("unknown key is kept as free text, not dropped", () => {
    expect(parseQuery("foo:bar").text).toBe("foo:bar");
  });

  test("a partial token (empty value) adds no constraint", () => {
    const f = parseQuery("author:");
    expect(f.authors).toEqual([]);
    expect(activeCount(f)).toBe(0);
  });
});

describe("grammar", () => {
  test("quoted values with spaces survive", () => {
    expect(parseQuery('label:"needs review"').labels).toEqual(["needs review"]);
  });

  test("keys are case-insensitive; enum values normalise to lowercase", () => {
    const f = parseQuery("Author:Octo REVIEW:Approved");
    expect(f.authors).toEqual(["Octo"]); // free-form value keeps case
    expect(f.reviews).toEqual(["approved"]);
  });

  test("an out-of-range enum value is ignored, not turned into list-emptying free text", () => {
    const f = parseQuery("review:banana");
    expect(f.reviews).toEqual([]);
    expect(f.text).toBe(""); // NOT "review:banana"
  });

  test("duplicate values dedupe", () => {
    expect(parseQuery("label:bug label:bug").labels).toEqual(["bug"]);
  });

  test("free text and tokens mix in any order", () => {
    const f = parseQuery("fix author:octo urgent");
    expect(f.authors).toEqual(["octo"]);
    expect(f.text).toBe("fix urgent");
  });
});

describe("parse <-> serialize round-trip", () => {
  const cases = [
    "",
    "author:octo",
    'label:"needs review" label:bug review:approved',
    "is:draft base:main author:a author:b",
    "checks:red sort:most-changed",
    "fix the thing author:octo",
  ];
  for (const c of cases) {
    test(`normalized(${JSON.stringify(c)}) is a fixed point`, () => {
      const once = parseQuery(c);
      const round = parseQuery(serializeQuery(once));
      expect(round).toEqual(once);
    });
  }

  test("serialize drops the default sort and keeps a non-default one", () => {
    expect(serializeQuery(parseQuery("sort:recently-updated"))).not.toContain("sort:");
    expect(serializeQuery(parseQuery("sort:oldest"))).toContain("sort:oldest");
  });

  test("serialize quotes only values that need it", () => {
    expect(serializeQuery(parseQuery("label:bug"))).toBe("label:bug");
    expect(serializeQuery(parseQuery('label:"two words"'))).toBe('label:"two words"');
  });
});

describe("filtering: OR within a facet, AND across facets", () => {
  const rows = [
    pr({ number: 1, author: "alice", labels: [{ name: "bug" }] }),
    pr({ number: 2, author: "bob", labels: [{ name: "bug" }] }),
    pr({ number: 3, author: "carol", labels: [{ name: "docs" }] }),
  ];

  test("two authors is a union (OR within the facet)", () => {
    const out = applyFilters(rows, parseQuery("author:alice author:bob"));
    expect(out.map((p) => p.number).sort()).toEqual([1, 2]);
  });

  test("author AND label intersect (AND across facets)", () => {
    const out = applyFilters(rows, parseQuery("author:alice label:bug"));
    expect(out.map((p) => p.number)).toEqual([1]);
    expect(applyFilters(rows, parseQuery("author:carol label:bug"))).toHaveLength(0);
  });

  test("is:draft / is:ready split on the draft flag", () => {
    const mixed = [pr({ number: 4, isDraft: true }), pr({ number: 5, isDraft: false })];
    expect(applyFilters(mixed, parseQuery("is:draft")).map((p) => p.number)).toEqual([4]);
    expect(applyFilters(mixed, parseQuery("is:ready")).map((p) => p.number)).toEqual([5]);
  });

  test("review:none matches a null review decision", () => {
    const rs = [pr({ number: 6, reviewDecision: null }), pr({ number: 7, reviewDecision: "APPROVED" })];
    expect(applyFilters(rs, parseQuery("review:none")).map((p) => p.number)).toEqual([6]);
    expect(applyFilters(rs, parseQuery("review:approved")).map((p) => p.number)).toEqual([7]);
  });
});

describe("checks facet", () => {
  const green = pr({ number: 1, checks: { total: 3, success: 3, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] } });
  const red = pr({ number: 2, checks: { total: 3, success: 2, failure: 1, skipped: 0, pending: 0, allDone: true, verdict: "red", failing: [] } });
  const pending = pr({ number: 3, checks: { total: 3, success: 1, failure: 0, skipped: 0, pending: 2, allDone: false, verdict: null, failing: [] } });

  test("green / red / pending select the right rows", () => {
    const rows = [green, red, pending];
    expect(applyFilters(rows, parseQuery("checks:green")).map((p) => p.number)).toEqual([1]);
    expect(applyFilters(rows, parseQuery("checks:red")).map((p) => p.number)).toEqual([2]);
    expect(applyFilters(rows, parseQuery("checks:pending")).map((p) => p.number)).toEqual([3]);
  });

  test("a row whose checks have not loaded fails OPEN — a checks filter keeps it", () => {
    const loading = pr({ number: 9, checksLoaded: false });
    const out = applyFilters([green, loading], parseQuery("checks:green"));
    expect(out.map((p) => p.number).sort()).toEqual([1, 9]); // 9 not hidden despite unknown checks
  });
});

describe("sort orders", () => {
  const rows = [
    pr({ number: 1, title: "zebra", updatedAt: "2026-01-01T00:00:00Z", additions: 1, deletions: 0 }),
    pr({ number: 3, title: "apple", updatedAt: "2026-03-01T00:00:00Z", additions: 50, deletions: 50 }),
    pr({ number: 2, title: "mango", updatedAt: "2026-02-01T00:00:00Z", additions: 5, deletions: 5 }),
  ];
  const nums = (q: string) => applyFilters(rows, parseQuery(q)).map((p) => p.number);

  test("recently-updated (default), newest, oldest", () => {
    expect(nums("")).toEqual([3, 2, 1]); // by updatedAt desc
    expect(nums("sort:newest")).toEqual([3, 2, 1]);
    expect(nums("sort:oldest")).toEqual([1, 2, 3]);
  });
  test("most-changed and title", () => {
    expect(nums("sort:most-changed")).toEqual([3, 2, 1]);
    expect(nums("sort:title")).toEqual([3, 2, 1]); // apple, mango, zebra
  });
  test("checks sort surfaces red first, then pending, then green", () => {
    const cr = [
      pr({ number: 10, checks: { total: 1, success: 1, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] } }),
      pr({ number: 11, checks: { total: 1, success: 0, failure: 1, skipped: 0, pending: 0, allDone: true, verdict: "red", failing: [] } }),
      pr({ number: 12, checks: { total: 1, success: 0, failure: 0, skipped: 0, pending: 1, allDone: false, verdict: null, failing: [] } }),
    ];
    expect(applyFilters(cr, parseQuery("sort:checks")).map((p) => p.number)).toEqual([11, 12, 10]);
  });
});

describe("buildFacets counts", () => {
  const rows = [
    pr({ number: 1, author: "alice", labels: [{ name: "bug" }] }),
    pr({ number: 2, author: "alice", labels: [{ name: "docs" }] }),
    pr({ number: 3, author: "bob", labels: [{ name: "bug" }] }),
  ];

  test("option counts reflect the current rows", () => {
    const facets = buildFacets(rows, parseQuery(""));
    const authors = facets.find((f) => f.key === "authors")!;
    expect(authors.options.find((o) => o.value === "alice")!.count).toBe(2);
    expect(authors.options.find((o) => o.value === "bob")!.count).toBe(1);
  });

  test("a facet's own selection does NOT shrink its sibling counts (GitHub-style)", () => {
    // With author:alice selected, the Author facet still counts bob's PR, so
    // the user can widen the selection. But the Label facet reflects alice only.
    const facets = buildFacets(rows, parseQuery("author:alice"));
    const authors = facets.find((f) => f.key === "authors")!;
    expect(authors.options.find((o) => o.value === "bob")!.count).toBe(1); // unshrunk
    const labels = facets.find((f) => f.key === "labels")!;
    expect(labels.options.find((o) => o.value === "bug")!.count).toBe(1); // alice's bug only
    expect(labels.options.find((o) => o.value === "docs")!.count).toBe(1);
  });

  test("a selected value with no matching rows stays visible so it can be unticked", () => {
    const facets = buildFacets(rows, parseQuery("author:ghost"));
    const authors = facets.find((f) => f.key === "authors")!;
    expect(authors.options.find((o) => o.value === "ghost")).toBeTruthy();
    expect(authors.options.find((o) => o.value === "ghost")!.count).toBe(0);
  });

  test("rows with unloaded checks are excluded from the checks counts", () => {
    const rs = [
      pr({ number: 4, checks: { total: 1, success: 1, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] } }),
      pr({ number: 5, checksLoaded: false }),
    ];
    const checks = buildFacets(rs, parseQuery("")).find((f) => f.key === "checks")!;
    expect(checks.options.find((o) => o.value === "green")!.count).toBe(1); // row 5 not counted
  });
});

describe("toggleFacet round-trips through the string", () => {
  test("toggling adds then removes a value", () => {
    let f = parseQuery("");
    f = toggleFacet(f, "labels", "bug");
    expect(serializeQuery(f)).toBe("label:bug");
    f = toggleFacet(parseQuery(serializeQuery(f)), "labels", "bug");
    expect(serializeQuery(f)).toBe("");
  });
});

/*
 * THE TRACKER CARD BEHIND A PULL REQUEST.
 *
 * "sería muy útil tener un filtro para quitar/filtrar esas PRs por un estado de
 * ClickUp" — with the example that decides the shape: only the ones in Ready
 * for QA, or everything EXCEPT those.
 *
 * The card's status and its people are already on every row of the list, so
 * this filters what the board is already drawing rather than asking anybody
 * for anything.
 */
describe("filtering by the card behind the pull request", () => {
  const carded = (status: string, people: string[] = []) => pr({
    card: {
      id: "c1", title: "a card", status, priority: null,
      people: people.map((name) => ({ name, initials: name.slice(0, 2) })),
    },
  });

  test("keeps only the ones whose card is in that status", () => {
    const rows = [carded("READY FOR QA"), carded("IN DEVELOPMENT"), carded("READY FOR QA")];
    expect(applyFilters(rows, parseQuery("cardstatus:\"READY FOR QA\"")).length).toBe(2);
  });

  test("a pull request with no card is NOT one of them", () => {
    /*
     * `[]`, not the fail-open `null` the checks facet uses, and asked before it
     * was built: "solo ver aquellas PRs que tienen cards en Ready For QA" means
     * the ones that have one. A row with no card answered "maybe" would put
     * every unlinked pull request in the result of a question about statuses.
     */
    const rows = [carded("READY FOR QA"), pr()];
    const kept = applyFilters(rows, parseQuery("cardstatus:\"READY FOR QA\""));
    expect(kept.length).toBe(1);
    expect(kept[0].card?.status).toBe("READY FOR QA");
  });

  test("the card's people are not the GitHub assignees", () => {
    /*
     * A name on a tracker board is not a username on a forge, and the two
     * disagree often enough that one shared filter would be a wrong answer
     * rather than a convenience.
     */
    const rows = [carded("IN QA", ["Alfonso Gaviño"]), pr({ assignees: ["Alfonso Gaviño"] })];
    expect(applyFilters(rows, parseQuery("cardassignee:\"Alfonso Gaviño\"")).length).toBe(1);
    expect(applyFilters(rows, parseQuery("assignee:\"Alfonso Gaviño\"")).length).toBe(1);
  });

  test("both card facets survive a round trip through the query string", () => {
    // The query string is the state, so a filter that cannot be written down
    // is a filter that vanishes on the next keystroke.
    const q = 'cardstatus:"READY FOR QA" cardassignee:"Alfonso Gaviño"';
    expect(serializeQuery(parseQuery(q))).toContain('cardstatus:"READY FOR QA"');
    expect(serializeQuery(parseQuery(q))).toContain('cardassignee:"Alfonso Gaviño"');
  });

  test("offers nothing to somebody with no tracker at all", () => {
    // Repo-wide: without ClickUp connected no row has a card, so the field has
    // no options and never appears. His constraint, and it costs nothing.
    const facets = buildFacets([pr(), pr()], parseQuery(""));
    const status = facets.find((f) => f.queryKey === "cardstatus");
    expect(status?.options.length ?? 0).toBe(0);
  });
});

/*
 * THE BOARD BORROWS THE TASKS BOARD'S QUERY BUILDER.
 *
 * The pills answer "which of these" and cannot answer "anything but these":
 * there is no way to say `is not` in a checkbox list, and no way to ask for the
 * ones with no milestone at all. Rather than grow a second grammar, the board
 * reads its rows through the same engine — so these tests hold the three pieces
 * of the translation, which is where a mismatch would hide.
 */
describe("the board through the rule engine", () => {
  test("every field the pills know, the rules know too", () => {
    // One table, read two ways. If a facet is ever added to one and not the
    // other, this is the line that says so.
    expect(readPrField(pr({ author: "ana" }), "author")).toEqual(["ana"]);
    expect(readPrField(pr({ labels: [{ name: "backend", color: "" }] }), "label")).toEqual(["backend"]);
    expect(readPrField(pr({ milestone: "v2" }), "milestone")).toEqual(["v2"]);
  });

  test("a field nobody has heard of narrows nothing instead of throwing", () => {
    // A saved view from a future version must not break the board.
    expect(readPrField(pr(), "invented-later")).toEqual([]);
  });

  test("`is not` keeps everything the pills would have dropped", () => {
    const rows = [pr({ author: "ana" }), pr({ author: "bo" }), pr({ author: "cy" })];
    const not = applyWith(rows, { join: "and", rules: [{ id: "r1", field: "author", op: "not", values: ["ana"] }] }, readPrField);
    expect(not.map((p) => p.author)).toEqual(["bo", "cy"]);
  });

  test("`is not set` finds the ones with nothing there", () => {
    // The question the pills cannot ask at all: which have no milestone.
    const rows = [pr({ milestone: "v2" }), pr(), pr({ milestone: "v3" })];
    const none = applyWith(rows, { join: "and", rules: [{ id: "r1", field: "milestone", op: "unset", values: [] }] }, readPrField);
    expect(none.length).toBe(1);
    expect(none[0].milestone ?? null).toBeNull();
  });

  test("the saved tabs open with their filters showing, not blank", () => {
    // "Mine", "Failing" and the rest are hand-written query strings, and
    // opening one has to FILL the builder rather than clear it.
    const rules = queryToRules('author:ana label:backend');
    expect(rules.map((r) => [r.field, r.op, r.values])).toEqual([
      ["author", "is", ["ana"]],
      ["label", "is", ["backend"]],
    ]);
  });

  test("a field with no values on any row is not offered", () => {
    // What keeps `Card status` invisible for everybody without a tracker.
    const fields = builderFields([pr(), pr()], parseQuery(""));
    expect(fields.some((f) => f.key === "cardstatus")).toBe(false);
    expect(fields.some((f) => f.key === "author")).toBe(true);
  });
});
