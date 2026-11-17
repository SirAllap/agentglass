import { describe, expect, test } from "bun:test";
import type { PrSummary } from "../../shared/types.ts";
import { evalLanes } from "../src/lib/prFilterEval.ts";
import { emptyLanes } from "../../shared/prFilter.ts";
import { viewFieldReader } from "../../shared/prFilterFields.ts";
import { addRule } from "../src/lib/prFilterTree.ts";
import { toggleValue, valueCounts, valueOn } from "../src/components/PrRuleEditor.tsx";
import { buildFacets, builderFields, parseQuery } from "../src/lib/prFilter.ts";

// A pull request whose title key (ORBIT-512, Jira) and branch key (OLD-19812,
// the old tracker) differ: the card on it is the Jira one, in mixed case.
const pr = (n: number, status: string): PrSummary => ({
  number: n, title: `[ORBIT-512] thing ${n}`, headRefName: "OLD-19812-ORBIT-512-thing", labels: [], assignees: [], state: "OPEN",
  card: { id: "ORBIT-512", customId: "ORBIT-512", title: "thing", status, tracker: "jira", priority: null, people: [] },
} as unknown as PrSummary);
const rows = [pr(1, "Ready for QA"), pr(2, "ready for qa"), pr(3, "QA complete"), pr(4, "In QA")];
const read = (p: PrSummary, f: string) => viewFieldReader(p, f);

describe("a lane rule on card status", () => {
  const rule = { id: "r1", field: "cardstatus", op: "is" as const, values: ["pre qa", "blocked", "in qa", "ready for qa"] };
  test("hide matches every spelling, keeps QA complete", () => {
    const f = addRule(emptyLanes(), "hide", rule as never);
    const res = evalLanes(rows, f, read as never);
    expect(res.kept.map((p) => p.number)).toEqual([3]);
  });
});

describe("the rule editor's value list", () => {
  test("counts are keyed by the folded value the options use", () => {
    const counts = valueCounts(rows, read as never, "cardstatus");
    expect(counts.get("READY FOR QA")).toBe(2);
    expect(counts.get("QA COMPLETE")).toBe(1);
  });
  test("options carry every status on the rows, once each", () => {
    const f = builderFields(rows, parseQuery(""), null).find((x) => x.key === "cardstatus")!;
    expect(f.options.map((o) => o.value).sort()).toEqual(["IN QA", "QA COMPLETE", "READY FOR QA"]);
    const facet = buildFacets(rows, parseQuery(""), null).find((x) => x.key === "cardStatus")!;
    expect(facet.options.map((o) => [o.value, o.count]).sort()).toEqual([["IN QA", 1], ["QA COMPLETE", 1], ["READY FOR QA", 2]]);
  });
});

describe("the value list reads a saved spelling like the engine", () => {
  test("a rule saved as 'ready for qa' shows READY FOR QA ticked", () => {
    expect(valueOn("cardstatus", ["ready for qa"], "READY FOR QA")).toBe(true);
    expect(valueOn("cardstatus", ["ready for qa"], "IN QA")).toBe(false);
  });
  test("unticking drops the old spelling; ticking adds one value", () => {
    expect(toggleValue("cardstatus", ["ready for qa", "in qa"], "READY FOR QA")).toEqual(["in qa"]);
    expect(toggleValue("cardstatus", ["in qa"], "READY FOR QA")).toEqual(["in qa", "READY FOR QA"]);
  });
});
