import { expect, test } from "bun:test";
import { linkPicks } from "../src/model/linkPicks.ts";

const pr = (number: number, over: Record<string, unknown> = {}) => ({
  number, title: `Thing ${number}`, url: `https://github.com/acme/orbit/pull/${number}`,
  headRefName: `feat/ORBIT-${number}`, isDraft: false, state: "OPEN" as const, checks: { total: 0, success: 0, failure: 0, skipped: 0, pending: 0, allDone: false, verdict: null, failing: [] }, ...over,
});

test("open only, linked left out, newest first, one row per address", () => {
  const rows = linkPicks(
    [[pr(181), pr(184), pr(170, { state: "MERGED" })], [pr(189, { isDraft: true }), pr(181)]],
    ["https://github.com/acme/orbit/pull/184"],
  );
  expect(rows.map((r) => r.number)).toEqual([189, 181]);
  expect(rows[0]!.detail).toBe("feat/ORBIT-189 · draft");
});

test("checks read as failing, green, or a count", () => {
  const c = (o: object) => ({ failing: [] as string[], total: 3, success: 0, failure: 0, skipped: 0, pending: 0, allDone: false, verdict: null, ...o });
  const [a, b, d] = linkPicks([[
    pr(3, { checks: c({ failure: 1 }) }), pr(2, { checks: c({ success: 3, allDone: true, verdict: "green" }) }), pr(1, { checks: c({ success: 2, pending: 1 }) }),
  ]], []);
  expect([a!.tone, b!.tone, d!.detail]).toEqual(["bad", "good", "feat/ORBIT-1 · 2 of 3 checks"]);
});
