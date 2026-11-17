/*
 * An approved, all-green pull request whose base requires a job ("audit") that
 * a path filter skipped: the rollup holds 14 checks and none is "audit", so the
 * list reads green. The board asks for the required contexts once per base and
 * the check names once per head, in one request, and says so on the row.
 */
import { describe, expect, it } from "bun:test";
import { MERGE_STATE_TTL_MS, mergeGateOf, requiredContextsOf, scheduleRequiredCheck, stampRequired, __requiredCaches } from "../src/prs.ts";
import { fileInLane } from "../../shared/prLanes.ts";
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

/** The base answers: required contexts, strict or not; the PR answers: its check names and GitHub's merge state. */
const answerWith = (names: string[], required: string[], strict: boolean, mergeState: string) => async (body: string) => {
  const out: Record<string, any> = {};
  for (const m of body.matchAll(/\bb(\d+): ref\(/g)) out[`b${m[1]}`] = { branchProtectionRule: { requiredStatusCheckContexts: required, requiresStrictStatusChecks: strict }, refUpdateRule: null, rules: { nodes: [] } };
  for (const m of body.matchAll(/\bp(\d+): pullRequest/g)) out[`p${m[1]}`] = { mergeStateStatus: mergeState, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: names.map((name) => ({ name })) } } } }] } };
  return out;
};
const reset = () => { __requiredCaches.ctx.clear(); __requiredCaches.names.clear(); __requiredCaches.states.clear(); };
const MINE = { mine: true, asked: false };

describe("an unopened card lands where the detail would put it (acme/orbit #1042)", () => {
  it("approved, green, 7 behind, CLEAN, up-to-date NOT required: Green, ready", async () => {
    reset();
    const rows = [row(1042)];
    await scheduleRequiredCheck(repo, rows, answerWith(["build", "audit"], ["build", "audit"], false, "BEHIND"));
    const [p] = stampRequired(repo, rows);
    expect(p.behindBlocks).toBeUndefined();
    expect(fileInLane(p, MINE).lane).toBe("land");
  });

  it("behind with up-to-date required: Blocked", async () => {
    reset();
    const rows = [row(1042)];
    await scheduleRequiredCheck(repo, rows, answerWith(["build", "audit"], ["build", "audit"], true, "BEHIND"));
    const [p] = stampRequired(repo, rows);
    expect(p.behindBlocks).toBe(true);
    expect(fileInLane(p, MINE).lane).toBe("blocked");
  });

  it("a failing required check: Blocked", async () => {
    reset();
    const red = row(1042, { checks: { total: 14, success: 13, failure: 1, skipped: 0, pending: 0, allDone: true, verdict: "red", failing: [{ name: "unit", workflow: "CI", state: "failure", done: true }] } as never });
    await scheduleRequiredCheck(repo, [red], answerWith(["build", "audit"], ["build", "audit"], false, "CLEAN"));
    expect(fileInLane(stampRequired(repo, [red])[0], MINE).lane).toBe("blocked");
  });
});

describe("a card is re-decided whenever its own facts move", () => {
  it("a check still running is no wall; when it finishes the card is Green, ready", async () => {
    reset();
    const running = row(21437, { checks: { total: 76, success: 75, failure: 0, skipped: 0, pending: 1, allDone: false, verdict: "pending", failing: [] } as never });
    expect(fileInLane(stampRequired(repo, [running])[0], MINE).lane).not.toBe("blocked");
    /* Read at 75 checks: the late required job had not registered yet. */
    const at75 = row(21437, { checks: { total: 75, success: 75, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] } as never });
    await scheduleRequiredCheck(repo, [at75], answerWith(["build"], ["build", "audit"], false, "CLEAN"));
    expect(fileInLane(stampRequired(repo, [at75])[0], MINE).lane).toBe("blocked");
    /* The job registers and reports: 76 checks. The old read must not stand for this head. */
    const at76 = row(21437, { checks: { total: 76, success: 76, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] } as never });
    expect(stampRequired(repo, [at76])[0].requiredMissing).toBeUndefined(); // no read for this count yet: claims nothing
    await scheduleRequiredCheck(repo, [at76], answerWith(["build", "audit"], ["build", "audit"], false, "CLEAN"));
    expect(fileInLane(stampRequired(repo, [at76])[0], MINE).lane).toBe("land");
  });
});

describe("review follow-ups", () => {
  it("a CLEAN read does not stand once the base may have moved: re-read after the TTL, and BEHIND then blocks", async () => {
    reset();
    const rows = [row(1042)];
    let calls = 0;
    const clean = answerWith(["build", "audit"], ["build", "audit"], true, "CLEAN");
    await scheduleRequiredCheck(repo, rows, async (b) => { calls++; return clean(b); });
    expect(stampRequired(repo, rows)[0].behindBlocks).toBeUndefined();
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + MERGE_STATE_TTL_MS + 1;
      expect(stampRequired(repo, rows)[0].behindBlocks).toBeUndefined(); // an old read claims nothing
      await scheduleRequiredCheck(repo, rows, async (b) => { calls++; return answerWith(["build", "audit"], ["build", "audit"], true, "BEHIND")(b); });
      expect(calls).toBe(2); // asked again, no new head
      expect(stampRequired(repo, rows)[0].behindBlocks).toBe(true);
    } finally { Date.now = realNow; }
  });

  it("entries of a pull request that is no longer a candidate are dropped on the next refresh", async () => {
    reset();
    const a = row(1), b = row(2);
    await scheduleRequiredCheck(repo, [a, b], answerWith(["build"], ["build"], false, "CLEAN"));
    expect(__requiredCaches.names.size).toBe(2);
    await scheduleRequiredCheck(repo, [{ ...b, state: "MERGED" } as PrSummary, row(3)], answerWith(["build"], ["build"], false, "CLEAN"));
    const keys = [...__requiredCaches.names.keys()];
    expect(keys.some((k) => k.includes("\u00002\u0000"))).toBe(false);
    expect(keys.some((k) => k.includes("\u00003\u0000"))).toBe(true);
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
