// The PR board's lane filter: its text syntax, its evaluator and the limits
// the server holds. Fixtures are the shape of a real board with invented names.
import { describe, expect, test } from "bun:test";
import type { PrSummary } from "../../shared/types.ts";
import {
  VIEW_LIMITS, emptyLanes, lanesFromFlat, validateLaneFilter, validateViews,
  type FilterNode, type FilterRule, type LaneFilter,
} from "../../shared/prFilter.ts";
import { evalLanes } from "../src/lib/prFilterEval.ts";
import { lanesToText, parseRuleText, suggestCards } from "../src/lib/prFilterSyntax.ts";

import { applyWith } from "../src/components/tasks/filters.ts";
import { readPrField, readPrFieldAt } from "../src/lib/prFilter.ts";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const read = (p: PrSummary, k: string) => readPrFieldAt(p, k, NOW);

function pr(number: number, over: Partial<PrSummary> = {}): PrSummary {
  return {
    number, mergeable: "MERGEABLE", title: "a pull request", author: "ana", state: "OPEN", isDraft: false,
    headRefName: "feature", baseRefName: "main", url: "", updatedAt: daysAgo(1), reviewDecision: null,
    additions: 0, deletions: 0, changedFiles: 0, labels: [], assignees: [], milestone: null,
    checks: { total: 0, success: 0, failure: 0, skipped: 0, pending: 0, allDone: false, verdict: null, failing: [] },
    checksLoaded: true, ...over,
  };
}
const card = (customId: string) => ({ id: "c" + customId, customId, title: "t", status: "Ready", priority: null, people: [] }) as unknown as PrSummary["card"];
const red = { total: 2, success: 1, failure: 1, skipped: 0, pending: 0, allDone: true, verdict: "red" as const, failing: [] };

const rows: PrSummary[] = [
  pr(322, { title: "Fix dock overflow", author: "ana", card: card("ORBIT-1042"), labels: [{ name: "needs work", color: "" }] as PrSummary["labels"] }),
  pr(323, { title: "Add retries", author: "bot", headRefName: "orbit-1043-retries", mergeable: "CONFLICTING", updatedAt: daysAgo(20), checks: red }),
  pr(324, { title: "Docs: api", author: "ana", isDraft: true, updatedAt: daysAgo(3) }),
  pr(325, { title: "Tidy [WIP] parser", author: "cy", card: card("ORBIT-2077"), baseRefName: "release" }),
];

let n = 0;
const ctx = () => ({ newId: () => `x${++n}` });
function parse(text: string): LaneFilter {
  const r = parseRuleText(text, ctx());
  if ("error" in r) throw new Error(r.error);
  const f = emptyLanes();
  for (const a of r.add) (a.lane === "show" ? f.show : f.hide).children.push(a.node);
  return f;
}
const kept = (text: string) => evalLanes(rows, parse(text), read).kept.map((p) => p.number);
const rule = (field: string, op: FilterRule["op"], values: string[] = [], id = field + op): FilterRule => ({ id, field, op, values });

describe("parseRuleText", () => {
  test("every token keeps what it says", () => {
    expect(kept("dock")).toEqual([322]);
    expect(kept('"add retries"')).toEqual([323]);
    expect(kept("/\\[wip\\]/")).toEqual([325]);
    expect(kept("#323")).toEqual([323]);
    expect(kept("ORBIT-1042")).toEqual([322]);
    expect(kept("orbit-2077")).toEqual([325]);
    expect(kept("author:cy")).toEqual([325]);
    expect(kept("author:cy,bot")).toEqual([323, 325]);
    expect(kept('label:"needs work"')).toEqual([322]);
    expect(kept("base:release")).toEqual([325]);
    expect(kept("is:conflict")).toEqual([323]);
    expect(kept("is:draft")).toEqual([324]);
    expect(kept("ci:failing")).toEqual([323]);
    expect(kept("updated:>14d")).toEqual([323]);
    expect(kept("updated:<2d")).toEqual([322, 325]);
    expect(kept("has:card")).toEqual([322, 325]);
    expect(kept("1043-retries")).toEqual([323]); // a word also finds the branch
  });

  test("negation hides what matches", () => {
    expect(kept("-author:ana")).toEqual([323, 325]);
    expect(kept("-#322")).toEqual([323, 324, 325]);
    expect(kept("-ORBIT-1042")).toEqual([323, 324, 325]);
    expect(kept("-is:conflict")).toEqual([322, 324, 325]);
    expect(kept("-has:card")).toEqual([323, 324]);
    expect(kept("-dock")).toEqual([323, 324, 325]);
    expect(kept('-"add retries"')).toEqual([322, 324, 325]);
    expect(kept("!author:ana")).toEqual([323, 325]);
    expect(kept("!has:card")).toEqual([323, 324]);
  });

  test("tokens combine with and; a group is or", () => {
    expect(kept("author:ana -is:draft")).toEqual([322]);
    expect(kept("(author:bot | is:draft)")).toEqual([323, 324]);
    expect(kept("(#322 | (author:cy base:release)) -ORBIT-2077")).toEqual([322]);
    expect(kept("(author:ana -is:draft)")).toEqual([322]); // - inside a group is not
    expect(kept("-(author:bot | is:draft)")).toEqual([322, 325]);
  });

  test("regex: valid goes in, invalid is an error and adds nothing", () => {
    const bad = parseRuleText("/(unclosed/", ctx());
    expect(bad).toEqual({ error: expect.stringContaining("not a valid pattern") });
    expect("add" in bad).toBe(false);
    expect(parseRuleText("author:ana /a(/", ctx())).toHaveProperty("error");
  });

  test("errors name the problem", () => {
    for (const t of ["bogus:1", '"open', "(a | b", "a)", "a | b", "()", "ci:red", "updated:>x", "has:nothing", "(-word)", "!word", "/x/i", "-(a)(b"]) {
      expect(parseRuleText(t, ctx())).toHaveProperty("error");
    }
  });

  test("limits: depth 3 parses, depth 4 and a long value do not", () => {
    expect(parseRuleText("(a (b (c d)))", ctx())).toHaveProperty("add");
    expect(parseRuleText("(a (b (c (d e))))", ctx())).toEqual({ error: expect.stringContaining("at most 3") });
    expect(parseRuleText("x".repeat(201), ctx())).toHaveProperty("error");
  });
});

describe("lanesToText round trip", () => {
  const texts = [
    "dock", '"add retries" -author:bot', "/\\[wip\\]/ -/draft/", "#323 -#322", "ORBIT-1042 -ORBIT-2077",
    'label:"needs work" author:ana,cy', "is:conflict ci:failing updated:>14d -updated:<2d", "has:card -has:card !has:card !author:ana",
    "(author:bot | is:draft | (author:cy base:release))", "-(author:bot | is:draft)", "(author:ana -is:draft) -dock",
    '"a:b" "-x" "(y)" "#1" "ORBIT-9"',
  ];
  for (const t of texts) {
    test(t, () => {
      const f = parse(t);
      const back = lanesToText(f);
      // Same text again, and the same rows kept either way.
      expect(lanesToText(parse(back))).toBe(back);
      expect(evalLanes(rows, parse(back), read).kept).toEqual(evalLanes(rows, f, read).kept);
    });
  }

  test("an or-joined show lane reads as one group", () => {
    const f = lanesFromFlat("or", [{ field: "author", op: "is", values: ["bot"] }, { field: "is", op: "is", values: ["draft"] }]);
    expect(lanesToText(f)).toBe("(author:bot | is:draft)");
  });
});

describe("evalLanes", () => {
  test("nested groups", () => {
    const f = emptyLanes();
    f.show.children.push({
      id: "g1", kind: "group", join: "or", children: [
        rule("author", "is", ["bot"]),
        { id: "g2", kind: "group", join: "and", children: [rule("author", "is", ["ana"]), { id: "g3", kind: "group", join: "or", children: [rule("is", "is", ["draft"]), rule("number", "is", ["322"])] }] },
      ],
    });
    expect(evalLanes(rows, f, read).kept.map((p) => p.number)).toEqual([322, 323, 324]);
  });

  test("culprit is the first show child that fails, then the first hide that matches", () => {
    const f = emptyLanes();
    f.show.children.push(rule("author", "is", ["ana"], "s1"), rule("is", "is", ["ready"], "s2"));
    f.hide.children.push(rule("number", "is", ["322"], "h1"), rule("text", "contains", ["docs"], "h2"));
    const r = evalLanes(rows, f, read);
    expect(r.kept).toEqual([]);
    const c = (num: number) => r.culprit.get(rows.find((p) => p.number === num)!);
    expect(c(323)).toBe("s1"); // fails both show rules: the first is named
    expect(c(324)).toBe("s2");
    expect(c(325)).toBe("s1");
    expect(c(322)).toBe("h1");
    const g = emptyLanes();
    g.hide.children.push(rule("number", "is", ["324"], "h1"), rule("is", "is", ["draft"], "h2"));
    expect(evalLanes(rows, g, read).culprit.get(rows[2]!)).toBe("h1"); // matches both: the first
  });

  test("counts add up to the hidden total, and a group gets one count", () => {
    const f = parse("author:ana,cy -(is:conflict | is:draft) -ORBIT-2077");
    const r = evalLanes(rows, f, read);
    const total = [...r.hiddenBy.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(rows.length - r.kept.length);
    expect(r.hiddenBy.get(f.show.children[0]!.id)).toBe(1); // bot
    expect(r.hiddenBy.get(f.hide.children[0]!.id)).toBe(1); // the draft
    expect(r.hiddenBy.get(f.hide.children[1]!.id)).toBe(1);
  });

  test("an or lane credits its own id; an unfinished rule filters nothing", () => {
    const f = lanesFromFlat("or", [{ field: "author", op: "is", values: ["bot"] }, { field: "is", op: "is", values: ["draft"] }]);
    const r = evalLanes(rows, f, read);
    expect(r.hiddenBy.get(f.show.id)).toBe(2);
    expect(evalLanes(rows, parse("author:ana"), read).kept).toHaveLength(2);
    const half = emptyLanes();
    half.show.children.push(rule("author", "is", []));
    expect(evalLanes(rows, half, read).kept).toHaveLength(rows.length);
  });
});

describe("lanesFromFlat keeps the same PRs", () => {
  const sets: { field: string; op: string; values: string[] }[][] = [
    [{ field: "author", op: "is", values: ["ana", "cy"] }, { field: "is", op: "not", values: ["draft"] }],
    [{ field: "cardstatus", op: "set", values: [] }, { field: "author", op: "not", values: ["bot"] }],
    [{ field: "cardstatus", op: "unset", values: [] }],
    [{ field: "author", op: "is", values: ["bot"] }, { field: "is", op: "is", values: ["draft"] }, { field: "label", op: "unset", values: [] }],
    [{ field: "base", op: "not", values: ["release"] }, { field: "author", op: "is", values: [] }],
    [{ field: "author", op: "not", values: ["ana"] }, { field: "label", op: "set", values: [] }],
    [],
  ];
  for (const join of ["and", "or"] as const) {
    sets.forEach((rs, i) => test(`${join} set ${i}`, () => {
      const fixture = rows.map((p, k) => (k === 1 ? { ...p, card: { ...card("ORBIT-1043")!, status: "Done" } } as PrSummary : k === 0 ? { ...p, card: { ...p.card!, status: "Ready" } } as PrSummary : p));
      const old = applyWith(fixture, { join, rules: rs.map((r, k) => ({ id: String(k), field: r.field, op: r.op as "is", values: r.values })) }, readPrField);
      const got = evalLanes(fixture, lanesFromFlat(join, rs), read).kept;
      expect(got.map((p) => p.number)).toEqual(old.map((p) => p.number));
    }));
  }
});

describe("validators", () => {
  const nest = (d: number): FilterNode => (d === 0 ? rule("author", "is", ["a"], "leaf") : { id: "g" + d, kind: "group", join: "and", children: [nest(d - 1)] });
  const lane = (children: FilterNode[]): LaneFilter => ({ ...emptyLanes(), show: { ...emptyLanes().show, children } });
  const many = (k: number) => Array.from({ length: k }, (_, i) => rule("author", "is", ["a"], "m" + i));

  test("accepts what it should", () => {
    expect(typeof validateLaneFilter(lane([nest(3)]))).toBe("object");
    expect(typeof validateLaneFilter(lane(many(40)))).toBe("object");
    expect(typeof validateLaneFilter(emptyLanes())).toBe("object");
  });
  test("refuses depth 4, 41 rules, long patterns, bad shapes", () => {
    expect(typeof validateLaneFilter(lane([nest(4)]))).toBe("string");
    expect(typeof validateLaneFilter(lane(many(41)))).toBe("string");
    expect(validateLaneFilter(lane([rule("text", "contains", ["x".repeat(201)])]))).toContain("200");
    expect(validateLaneFilter(lane([rule("text", "matches", ["(a"])]))).toContain("not a valid pattern");
    expect(typeof validateLaneFilter(lane([rule("a", "bogus" as "is", ["x"])]))).toBe("string");
    expect(typeof validateLaneFilter(lane([rule("a", "is", ["x"], "d"), rule("b", "is", ["x"], "d")]))).toBe("string");
    expect(typeof validateLaneFilter(null)).toBe("string");
    expect(typeof validateLaneFilter({ show: emptyLanes().show })).toBe("string");
  });
  test("views: name 24, 12 views, order", () => {
    const v = (i: number, name = "Main") => ({ id: "v" + i, name, filter: emptyLanes(), order: i });
    expect(Array.isArray(validateViews(Array.from({ length: VIEW_LIMITS.views }, (_, i) => v(i))))).toBe(true);
    expect(typeof validateViews(Array.from({ length: 13 }, (_, i) => v(i)))).toBe("string");
    expect(typeof validateViews([v(1, "x".repeat(25))])).toBe("string");
    expect(Array.isArray(validateViews([v(1, "x".repeat(24))]))).toBe(true);
    expect(typeof validateViews([v(1, "  ")])).toBe("string");
    expect(typeof validateViews([v(1), v(1)])).toBe("string");
    expect(typeof validateViews("nope")).toBe("string");
  });
});

describe("suggestCards", () => {
  test("a partial key returns the matching card ids on the rows", () => {
    expect(suggestCards("orbit-10", rows)).toEqual(["ORBIT-1042"]);
    expect(suggestCards("ORBIT", rows)).toEqual(["ORBIT-1042", "ORBIT-2077"]);
    expect(suggestCards("", rows)).toEqual([]);
    expect(suggestCards("zzz", rows)).toEqual([]);
  });
});
