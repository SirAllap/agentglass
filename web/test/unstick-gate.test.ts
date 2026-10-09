/*
 * When the Unstick action may exist. The measured case it is for: the branch ref
 * moved while the pull request kept the old head and mergeability stayed UNKNOWN
 * for over an hour. The action closes and reopens the pull request, which fires
 * automations elsewhere, so the table below is mostly negatives: a healthy pull
 * request, a short wait, one look, an untried Update branch, and every state in
 * which closing it would be wrong.
 */
import { describe, expect, test } from "bun:test";
import {
  unstickGate, unstickLive, unstickHard, unstickSignalNow, lookAt, trialCounts, factsOf,
  LAG_AFTER_MS, UNKNOWN_AFTER_MS, LOOK_GAP_MS, RUN_STALE_MS, TRIAL_SETTLE_MS, MIN_LOOKS,
  type UnstickFacts, type Run, type UpdateTrial, type GateInput,
} from "../../shared/unstick.ts";

const NOW = Date.parse("2026-10-09T13:04:00Z");
const MIN = 60_000;
const OLD = "c".repeat(40);
const NEW = "e".repeat(40);

const healthy: UnstickFacts = {
  state: "OPEN", isDraft: false, author: true, canWrite: true, crossRepo: false, checksRunning: false,
  autoMerge: false, inMergeQueue: false, changesRequested: false, baseLocked: false,
  headSha: OLD, refSha: OLD, mergeState: "CLEAN",
};
const lagging: UnstickFacts = { ...healthy, refSha: NEW, mergeState: "UNKNOWN" };
const unknownOnly: UnstickFacts = { ...healthy, mergeState: "UNKNOWN" };

const run = (agoMin: number, looks = 3): Run => ({ since: NOW - agoMin * MIN, looks, lastLookAt: NOW - 60_000 });
const refused: UpdateTrial = { kind: "refused", at: NOW - 5 * MIN };
const gate = (over: Partial<GateInput> & { facts: UnstickFacts }) =>
  unstickGate({ now: NOW, lag: null, unknown: null, trial: null, ...over });

describe("unstickGate: shown only when everything holds", () => {
  test("ref behind PR head for 14 min, 3 looks, Update refused: shown, lag", () => {
    const g = gate({ facts: lagging, lag: run(14), trial: refused });
    expect(g).toEqual({ show: true, signal: "lag", minutes: 14 });
  });
  test("UNKNOWN for 41 min, 3 looks, Update accepted 5 min ago and the head did not move: shown", () => {
    const g = gate({ facts: unknownOnly, unknown: run(41), trial: { kind: "requested", at: NOW - 5 * MIN, headBefore: OLD } });
    expect(g).toEqual({ show: true, signal: "unknown", minutes: 41 });
  });

  test("a normal pull request shows nothing", () => {
    expect(gate({ facts: healthy })).toEqual({ show: false, reason: "no-signal" });
  });
  test("ref differs for 4 min only: too early", () => {
    expect(gate({ facts: lagging, lag: run(4), trial: refused })).toEqual({ show: false, reason: "too-early" });
  });
  test("ref differs for exactly the threshold minus a second: still too early; at the threshold: shown", () => {
    const at = (ms: number): Run => ({ since: NOW - ms, looks: 2, lastLookAt: NOW - 60_000 });
    expect(gate({ facts: lagging, lag: at(LAG_AFTER_MS - 1000), trial: refused }).show).toBe(false);
    expect(gate({ facts: lagging, lag: at(LAG_AFTER_MS), trial: refused }).show).toBe(true);
  });
  test("UNKNOWN for 20 min is not enough (30 required); the lag threshold does not apply to it", () => {
    expect(gate({ facts: unknownOnly, unknown: run(20), trial: refused })).toEqual({ show: false, reason: "too-early" });
    expect(gate({ facts: unknownOnly, unknown: run(UNKNOWN_AFTER_MS / MIN), trial: refused }).show).toBe(true);
  });
  test("long enough but seen on one look only: not shown", () => {
    expect(gate({ facts: lagging, lag: run(40, 1), trial: refused })).toEqual({ show: false, reason: "one-look" });
    expect(MIN_LOOKS).toBe(2);
  });
  test("long enough, two looks, Update branch never tried: not shown", () => {
    expect(gate({ facts: lagging, lag: run(40), trial: null })).toEqual({ show: false, reason: "update-untried" });
  });
  test("Update accepted a moment ago (inside the settle window): not tried long enough", () => {
    expect(gate({ facts: unknownOnly, unknown: run(60), trial: { kind: "requested", at: NOW - 30_000, headBefore: OLD } }).show).toBe(false);
  });
  test("Update accepted and then the head moved: that trial says nothing about this head", () => {
    expect(gate({ facts: unknownOnly, unknown: run(60), trial: { kind: "requested", at: NOW - 10 * MIN, headBefore: "9".repeat(40) } }))
      .toEqual({ show: false, reason: "update-untried" });
  });
  test("a refusal from before this spell began does not count", () => {
    expect(gate({ facts: lagging, lag: run(14), trial: { kind: "refused", at: NOW - 3 * 60 * MIN } })).toEqual({ show: false, reason: "update-untried" });
  });
  test("the lag run does not stand in for an UNKNOWN one: lag facts but only an unknown run", () => {
    expect(gate({ facts: lagging, lag: null, unknown: run(60), trial: refused })).toEqual({ show: false, reason: "too-early" });
  });
});

describe("unstickGate: every state in which closing it is wrong, even when the signal is old", () => {
  const stuck = { lag: run(60), unknown: run(60), trial: refused };
  const cases: [string, Partial<UnstickFacts>, string][] = [
    ["draft", { isDraft: true }, "draft"],
    ["merged", { state: "MERGED" }, "merged"],
    ["closed", { state: "CLOSED" }, "not-open"],
    ["not the author", { author: false }, "not-author"],
    ["no write access", { canWrite: false }, "no-write"],
    ["a fork", { crossRepo: true }, "fork"],
    ["checks running", { checksRunning: true }, "checks-running"],
    ["auto-merge armed", { autoMerge: true }, "auto-merge"],
    ["in the merge queue", { inMergeQueue: true }, "merge-queue"],
    ["changes requested", { changesRequested: true }, "changes-requested"],
    ["base locked or unreadable", { baseLocked: true }, "base-locked"],
  ];
  for (const [name, over, reason] of cases) {
    test(`${name}: not shown, ${reason}`, () => {
      expect(gate({ facts: { ...lagging, ...over }, ...stuck })).toEqual({ show: false, reason: reason as never });
      expect(gate({ facts: { ...unknownOnly, ...over }, ...stuck })).toEqual({ show: false, reason: reason as never });
    });
  }
  test("the hard list wins over a missing clock: a draft reads 'draft', not 'too-early'", () => {
    expect(gate({ facts: { ...lagging, isDraft: true } })).toEqual({ show: false, reason: "draft" });
  });
});

describe("a branch ahead of its pull request is not enough without GitHub saying UNKNOWN", () => {
  // The button sits on the "GitHub has not decided" row, so the gate and the button agree: no UNKNOWN, no offer.
  for (const mergeState of ["BEHIND", "BLOCKED", "CLEAN", "DIRTY", "UNSTABLE", ""]) {
    test(`lag for an hour, two looks, Update refused, mergeState ${mergeState || "(none)"}: not shown`, () => {
      const f = { ...lagging, mergeState };
      expect(gate({ facts: f, lag: run(60), unknown: run(60), trial: refused })).toEqual({ show: false, reason: "no-signal" });
      expect(unstickLive(f)).toEqual({ ok: false, reason: "no-signal" });
      expect(unstickSignalNow(f)).toBeNull();
    });
  }
  test("the same facts with UNKNOWN are shown", () => {
    expect(gate({ facts: lagging, lag: run(60), trial: refused }).show).toBe(true);
  });
});

describe("lookAt: separate looks, and a flicker starts over", () => {
  test("first look starts a run with one look", () => {
    expect(lookAt(null, true, NOW)).toEqual({ since: NOW, looks: 1, lastLookAt: NOW });
  });
  test("a second read inside the gap is the same look", () => {
    const r = lookAt(null, true, NOW)!;
    expect(lookAt(r, true, NOW + LOOK_GAP_MS - 1)).toBe(r);
  });
  test("a read after the gap is a second look and keeps the start", () => {
    const r = lookAt(null, true, NOW)!;
    expect(lookAt(r, true, NOW + LOOK_GAP_MS)).toEqual({ since: NOW, looks: 2, lastLookAt: NOW + LOOK_GAP_MS });
  });
  test("the condition not holding ends the run", () => {
    expect(lookAt(lookAt(null, true, NOW), false, NOW + 1000)).toBeNull();
  });
  test("a run nobody looked at for too long starts over", () => {
    const r = { since: NOW, looks: 5, lastLookAt: NOW };
    expect(lookAt(r, true, NOW + RUN_STALE_MS + 1)).toEqual({ since: NOW + RUN_STALE_MS + 1, looks: 1, lastLookAt: NOW + RUN_STALE_MS + 1 });
  });
  test("a clock that went backwards starts over", () => {
    expect(lookAt({ since: NOW, looks: 3, lastLookAt: NOW }, true, NOW - 1000)?.looks).toBe(1);
  });
});

describe("unstickLive: the hard list and the signal, no clock (server and first step)", () => {
  test("lag with UNKNOWN is lag; UNKNOWN alone; neither", () => {
    expect(unstickLive(lagging)).toEqual({ ok: true, signal: "lag" });
    expect(unstickLive(unknownOnly)).toEqual({ ok: true, signal: "unknown" });
    expect(unstickLive(healthy)).toEqual({ ok: false, reason: "no-signal" });
  });
  test("an unread ref is not a lag", () => {
    expect(unstickSignalNow({ ...healthy, refSha: null })).toBeNull();
    expect(unstickSignalNow({ ...healthy, headSha: "", refSha: NEW })).toBeNull();
  });
  test("hard negatives come first", () => {
    expect(unstickLive({ ...lagging, isDraft: true })).toEqual({ ok: false, reason: "draft" });
    expect(unstickHard(healthy)).toBeNull();
  });
});

describe("trialCounts", () => {
  test("refused always counts", () => expect(trialCounts(refused, healthy, NOW)).toBe(true));
  test("none does not", () => expect(trialCounts(null, healthy, NOW)).toBe(false));
  test("requested counts after the settle window on the same head only", () => {
    const t: UpdateTrial = { kind: "requested", at: NOW - TRIAL_SETTLE_MS, headBefore: OLD };
    expect(trialCounts(t, healthy, NOW)).toBe(true);
    expect(trialCounts({ ...t, at: NOW - TRIAL_SETTLE_MS + 1 }, healthy, NOW)).toBe(false);
    expect(trialCounts({ ...t, headBefore: NEW }, healthy, NOW)).toBe(false);
  });
});

describe("factsOf: a detail read the cautious way", () => {
  const d = {
    state: "OPEN", isDraft: false, viewerDidAuthor: true, viewerCanUpdate: true, headRepoOwner: "acme",
    checks: { total: 4, pending: 0, allDone: true }, reviewDecision: "APPROVED", mergeState: "UNKNOWN", headSha: OLD,
    gate: { permission: "WRITE", locked: false, inQueue: false },
  };
  test("a plain own pull request", () => {
    expect(factsOf(d, NEW, "Acme")).toEqual({
      state: "OPEN", isDraft: false, author: true, canWrite: true, crossRepo: false, checksRunning: false,
      autoMerge: false, inMergeQueue: false, changesRequested: false, baseLocked: false, headSha: OLD, refSha: NEW, mergeState: "UNKNOWN",
    });
  });
  test("every unknown is read against it", () => {
    expect(factsOf({ ...d, viewerCanUpdate: undefined }, null, "acme").canWrite).toBe(false);
    expect(factsOf({ ...d, gate: undefined }, null, "acme").baseLocked).toBe(true);
    expect(factsOf({ ...d, gate: { permission: "READ", locked: false, inQueue: false } }, null, "acme").canWrite).toBe(false);
    expect(factsOf({ ...d, gate: { permission: "WRITE", locked: null, inQueue: false } }, null, "acme").baseLocked).toBe(false);
    expect(factsOf({ ...d, gate: { permission: "WRITE", locked: true, inQueue: false } }, null, "acme").baseLocked).toBe(true);
    expect(factsOf({ ...d, headRepoOwner: "someone-else" }, null, "acme").crossRepo).toBe(true);
    expect(factsOf({ ...d, isCrossRepository: true }, null, "acme").crossRepo).toBe(true);
    expect(factsOf({ ...d, checks: { total: 4, pending: 1, allDone: false } }, null, "acme").checksRunning).toBe(true);
    expect(factsOf({ ...d, checks: { total: 4, pending: 0, allDone: false } }, null, "acme").checksRunning).toBe(true);
    expect(factsOf({ ...d, autoMerge: { by: "x" } }, null, "acme").autoMerge).toBe(true);
    expect(factsOf({ ...d, reviewDecision: "CHANGES_REQUESTED" }, null, "acme").changesRequested).toBe(true);
    expect(factsOf({ ...d, gate: { permission: "WRITE", locked: false, inQueue: true } }, null, "acme").inMergeQueue).toBe(true);
  });
});
