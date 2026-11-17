/*
 * The tile's PR facts come from what the PR board already loaded: the list row (review, base, changes) and the checks. With
 * the board not loaded the tile still has a number and a link, and CI reads as unknown.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { __resetListChecks, publishListChecks } from "../src/lib/prListChecks.ts";
import { tilePrFrom } from "../src/lib/jiraTileData.ts";
import type { CardPr } from "../src/lib/cardPrPick.ts";

// Facts the list published for a number must not leak into the next test.
beforeEach(() => __resetListChecks());

const own = (n: number, state = "OPEN"): CardPr => ({ number: n, title: "Export queue", state, url: `https://github.com/orbit/web/pull/${n}`, link: "own" });
const green = { total: 12, success: 12, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green" as const, failing: [] };

describe("a tile PR with nothing loaded", () => {
  test("keeps its number and link, CI unknown, no invented facts", () => {
    const t = tilePrFrom(own(901), null);
    expect(t).toMatchObject({ number: 901, state: "OPEN", url: "https://github.com/orbit/web/pull/901", base: null, additions: null, behind: null });
    expect(t.ci.state).toBe("unknown");
    expect(t.review.kind).toBe("unknown");
  });
});

describe("a tile PR the board never loaded", () => {
  test("carries the head branch and the base from the project read, so Fix with agent briefs a real branch", () => {
    const t = tilePrFrom({ ...own(902), branch: "orbit-1042-retry", base: "main" }, null);
    expect(t).toMatchObject({ branch: "orbit-1042-retry", base: "main" });
  });
});

describe("a tile PR the board already loaded", () => {
  test("reads review, base and changes from the list row, CI from the checks", () => {
    publishListChecks({ owner: "orbit", name: "web" }, [{
      number: 902, state: "OPEN", isDraft: false, baseRefName: "master", additions: 554, deletions: 141, reviewDecision: "REVIEW_REQUIRED",
      reviewers: [{ login: "ra" }], humanReview: { kind: "awaiting", who: ["ra"] }, checks: { ...green, failure: 2, success: 10, allDone: false, verdict: null, failing: [{ name: "e2e-export-queue" } as never, { name: "lint" } as never] }, checksLoaded: true,
    }] as never);
    const t = tilePrFrom(own(902), null);
    expect(t).toMatchObject({ base: "master", additions: 554, deletions: 141 });
    expect(t.review).toEqual({ kind: "awaiting", who: "ra" });
    expect(t.ci).toMatchObject({ state: "failing", passed: 10, total: 12 });
  });
  test("an approved row says approved; a bot-only approval is not a person's", () => {
    publishListChecks({ owner: "orbit", name: "web" }, [{
      number: 903, state: "OPEN", isDraft: false, baseRefName: "master", additions: 1, deletions: 1, reviewDecision: "APPROVED",
      humanReview: { kind: "approved", who: ["jl"] }, checks: green, checksLoaded: true,
    }, {
      number: 904, state: "OPEN", isDraft: false, baseRefName: "master", additions: 1, deletions: 1, reviewDecision: "APPROVED",
      humanReview: null, reviewers: [], checks: green, checksLoaded: true,
    }] as never);
    expect(tilePrFrom(own(903), null).review).toEqual({ kind: "approved", who: "jl" });
    expect(tilePrFrom(own(904), null).review.kind).toBe("none");
  });
  test("behind is whatever count the board already holds, never asked", () => {
    expect(tilePrFrom(own(905), 27).behind).toBe(27);
  });
});

describe("a skipped-heavy check set reads like the PR board", () => {
  test("43 pass, 24 skipped, 1 pending, 0 failed: 0 failing, 67/68 running", () => {
    publishListChecks({ owner: "orbit", name: "web" }, [{
      number: 910, state: "OPEN", isDraft: false, baseRefName: "master", additions: 1, deletions: 1, reviewDecision: "REVIEW_REQUIRED",
      checks: { total: 68, success: 43, failure: 0, skipped: 24, pending: 1, allDone: false, verdict: null, failing: [] }, checksLoaded: true,
    }] as never);
    const t = tilePrFrom(own(910), null);
    expect(t.ci).toMatchObject({ state: "running", passed: 67, total: 68, failed: 0 });
  });
  test("a nameless failure still counts failures only, not skipped or pending", () => {
    publishListChecks({ owner: "orbit", name: "web" }, [{
      number: 911, state: "OPEN", isDraft: false, baseRefName: "master", additions: 1, deletions: 1, reviewDecision: "REVIEW_REQUIRED",
      checks: { total: 68, success: 40, failure: 2, skipped: 24, pending: 2, allDone: false, verdict: null, failing: [] }, checksLoaded: true,
    }] as never);
    expect(tilePrFrom(own(911), null).ci).toMatchObject({ state: "failing", failed: 2, passed: 64, total: 68 });
  });
});
