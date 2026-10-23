/*
 * An approved, all-green pull request whose base requires a job ("audit") that
 * a path filter skipped: the rollup holds 14 checks and none is "audit", so the
 * list reads green. The board asks for the required contexts once per base and
 * the check names once per head, in one request, and says so on the row.
 */
import { describe, expect, it } from "bun:test";
import { mergeGateOf, requiredContextsOf, scheduleRequiredCheck, stampRequired, __requiredCaches } from "../src/prs.ts";
import type { PrSummary } from "../../shared/types.ts";

const repo = { key: "acme/orbit", nameWithOwner: "acme/orbit" } as any;
const row = (n: number, o: Partial<PrSummary> = {}): PrSummary => ({
  number: n, title: "t", state: "OPEN", isDraft: false, reviewDecision: "APPROVED", baseRefName: "main",
  headSha: `sha${n}`, mergeable: "UNKNOWN",
  checks: { total: 14, success: 14, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] },
  ...o,
} as unknown as PrSummary);

const answer = (names: string[], required: string[]) => async (body: string) => {
  const out: Record<string, any> = {};
  for (const m of body.matchAll(/\bb(\d+): ref\(/g)) out[`b${m[1]}`] = { branchProtectionRule: null, refUpdateRule: { requiredStatusCheckContexts: required }, rules: { nodes: [] } };
  for (const m of body.matchAll(/\bp(\d+): pullRequest/g)) out[`p${m[1]}`] = { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: names.map((name) => ({ name })) } } } }] } };
  return out;
};

describe("required check that never reported", () => {
  it("is read once for the board and stamped on the approved, green card", async () => {
    __requiredCaches.ctx.clear(); __requiredCaches.names.clear();
    const rows = [row(1), row(2), row(3, { reviewDecision: null })];
    let calls = 0;
    const ask = answer(["build", "unit"], ["build", "audit"]);
    const n = await scheduleRequiredCheck(repo, rows, async (b) => { calls++; return ask(b); });
    expect(n).toBe(1);
    expect(calls).toBe(1);
    const stamped = stampRequired(repo, rows);
    expect(stamped[0].requiredMissing).toBe(true);
    expect(stamped[1].requiredMissing).toBe(true);
    expect(stamped[2].requiredMissing).toBeUndefined();
  });

  it("asks nothing again for the same heads, and a push asks for the new head only", async () => {
    let calls = 0;
    const ask = async (b: string) => { calls++; expect(b).not.toContain("ref("); expect(b).not.toContain("p1:"); return answer(["build", "audit"], [])(b); };
    await scheduleRequiredCheck(repo, [row(1), row(2)], ask);
    expect(calls).toBe(0);
    await scheduleRequiredCheck(repo, [row(1), row(2, { headSha: "pushed" })], ask);
    expect(calls).toBe(1);
    expect(stampRequired(repo, [row(2, { headSha: "pushed" })])[0].requiredMissing).toBeUndefined();
  });

  it("a card reporting every required context is not stamped", async () => {
    __requiredCaches.ctx.clear(); __requiredCaches.names.clear();
    await scheduleRequiredCheck(repo, [row(9)], answer(["build", "audit"], ["build", "audit"]));
    expect(stampRequired(repo, [row(9)])[0].requiredMissing).toBeUndefined();
  });

  it("a failed read changes nothing", async () => {
    __requiredCaches.ctx.clear(); __requiredCaches.names.clear();
    await scheduleRequiredCheck(repo, [row(5)], async () => null);
    expect(stampRequired(repo, [row(5)])[0].requiredMissing).toBeUndefined();
  });

  it("classic protection, ref rule and active rulesets are one list", () => {
    expect(requiredContextsOf({ requiredStatusCheckContexts: ["a"] }, { requiredStatusCheckContexts: ["b"] },
      [{ type: "REQUIRED_STATUS_CHECKS", parameters: { requiredStatusChecks: [{ context: "c" }] } }]).sort()).toEqual(["a", "b", "c"]);
    expect(mergeGateOf).toBeDefined();
  });
});

describe("UNKNOWN mergeable is asked again once per head commit", () => {
  it("a refresh that still reads UNKNOWN does not start the follow-up again", async () => {
    const { scheduleMergeableRecheck } = await import("../src/prs.ts");
    let asks = 0;
    const ask = async () => { asks++; return new Map<number, string>(); };
    const wait = async () => {};
    const r = row(77, { headSha: "head-a" });
    await scheduleMergeableRecheck(repo, [r], ask, wait);
    const first = asks; // three rounds, one request each, while GitHub keeps saying nothing
    expect(first).toBe(3);
    await scheduleMergeableRecheck(repo, [r], ask, wait);
    expect(asks).toBe(first);
    await scheduleMergeableRecheck(repo, [{ ...r, headSha: "head-b" }], ask, wait);
    expect(asks).toBe(first + 3);
  });
});
