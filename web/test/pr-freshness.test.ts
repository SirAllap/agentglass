/*
 * A pull request on screen said "Ready to merge · All checks have passed · 1
 * thread" for the commit BEFORE a push, while the new head had ~25 checks
 * running, merge state BLOCKED and no open thread. Each fact was true of an older
 * commit. Fixtures use invented repos and shas (acme/orbit #478).
 */
import { describe, expect, it } from "bun:test";
import { staleness, trustHead, nextLook, PUSH_SETTLE_MS, POLL_RUNNING_MS, POLL_CAP_MS } from "../../shared/prFreshness.ts";
import { githubWillMerge, mergeVerdict } from "../../shared/mergeReason.ts";
import { mergeBlockers } from "../../shared/mergeBlockers.ts";
import { detailWithChecks } from "../src/lib/prRefresh.ts";
import { prConflicted } from "../src/lib/updateBranch.ts";
import type { PrCheckRollup, PrDetail } from "../../shared/types.ts";

const OLD = "1".repeat(40), NEW = "2".repeat(40);
const roll = (o: Partial<PrCheckRollup>): PrCheckRollup => ({ total: 0, success: 0, failure: 0, skipped: 0, pending: 0, allDone: false, verdict: null, failing: [], ...o });
const green = roll({ total: 66, success: 66, allDone: true, verdict: "green" });
const running = roll({ total: 25, success: 3, pending: 22 });
const base = { number: 478, state: "OPEN", checksAll: [], threads: [], readAt: 1000 };
const d = (o: Partial<PrDetail>): PrDetail => ({ ...base, headSha: NEW, checksSha: NEW, mergeState: "CLEAN", mergeable: "MERGEABLE", checks: green, ...o } as unknown as PrDetail);

describe("the worst case: old head's green on the new head", () => {
  // Head read as NEW, checks and CLEAN cached from OLD, one thread still listed.
  const worst = d({ checksSha: OLD, mergeState: "CLEAN", checks: green, threads: [{ isResolved: false }] as never, openThreads: { open: 1, more: false } });

  it("is not a current reading", () => expect(staleness(worst)).toBe("checks-older"));

  it("says nothing about merging, with the short sha", () => {
    const shown = trustHead(worst);
    expect(shown.checking?.sha).toBe(NEW.slice(0, 7));
    expect(githubWillMerge(shown.mergeState)).toBe(false);
    expect(mergeVerdict(shown.mergeState, shown.checks).line).not.toBe("Ready to merge");
    expect(shown.checks.total).toBe(0);
    expect(shown.threads.filter((t) => !t.isResolved).length).toBe(0); // no "1 thread"
    expect(shown.openThreads).toBeUndefined();
    const why = mergeBlockers({ ...shown, openThreads: 1 } as never).map((b) => b.title).join("|");
    expect(why).toContain(`Checking the new head… ${NEW.slice(0, 7)}`);
  });

  it("the real new-head reading (running, BLOCKED, 0 threads) is current and not ready either", () => {
    const real = d({ mergeState: "BLOCKED", checks: running });
    expect(staleness(real)).toBe("ok");
    expect(trustHead(real)).toBe(real);
    expect(mergeVerdict(real.mergeState, real.checks).line).not.toBe("Ready to merge");
  });
});

describe("a push this machine made", () => {
  const push = { sha: NEW, at: 5000 };
  it("a reading from before the push is not current, even on the same commit", () => {
    expect(staleness(d({ readAt: 4000 }), push, 6000)).toBe("before-push");
    expect(trustHead(d({ readAt: 4000 }), push, 6000).checking?.sha).toBe(NEW.slice(0, 7));
  });
  it("GitHub still on the old head just after the push is lagging, then trusted again", () => {
    const lag = d({ headSha: OLD, checksSha: OLD, readAt: 5500 });
    expect(staleness(lag, push, 6000)).toBe("lagging-push");
    expect(trustHead(lag, push, 6000).checking?.sha).toBe(NEW.slice(0, 7));
    expect(staleness(lag, push, 5000 + PUSH_SETTLE_MS + 1)).toBe("ok");
  });
  it("a reading of the pushed commit after the push is current", () => expect(staleness(d({ readAt: 5500 }), push, 6000)).toBe("ok"));
});

describe("stale conflict banner after a push (refs not refetched)", () => {
  it("a CONFLICTING verdict and file list of the old head do not survive a reading that is not current", () => {
    const stale = trustHead(d({ checksSha: OLD, mergeable: "CONFLICTING", mergeState: "DIRTY" }));
    expect(stale.mergeable).toBe("UNKNOWN");
    expect(prConflicted(stale.mergeable, { files: ["a.ts"], stale: false, headSha: OLD }, false, NEW)).toBe(false);
  });
});

describe("checks summary lagging after CI ends", () => {
  it("a rollup read of the head replaces the old counts and names its commit", () => {
    const running25 = d({ checks: running });
    const next = detailWithChecks(running25, "acme/orbit", { repo: "acme/orbit", number: 478, checks: green, all: [], sha: NEW });
    expect(next?.checks.pending).toBe(0);
    expect(next?.checksSha).toBe(NEW);
  });
  it("a rollup of another commit is not written over this head's checks", () => {
    expect(detailWithChecks(d({ checks: running }), "acme/orbit", { repo: "acme/orbit", number: 478, checks: green, all: [], sha: OLD })).toBeNull();
  });
});

describe("bounded refresh of the open PR", () => {
  const o = { visible: true, since: 0, now: 60_000 };
  it("looks while checks run, never when hidden, stops when settled or after the cap", () => {
    expect(nextLook(d({ checks: running }), o)).toBe(POLL_RUNNING_MS);
    expect(nextLook(d({ checks: running }), { ...o, visible: false })).toBeNull();
    expect(nextLook(d({}), o)).toBeNull();
    expect(nextLook(d({ checks: running }), { ...o, now: POLL_CAP_MS + 1 })).toBeNull();
    expect(nextLook(d({ checks: running, state: "MERGED" }), o)).toBeNull();
  });
  it("keeps looking while the reading is not current even if the counts look settled", () => {
    expect(nextLook(d({ checksSha: OLD }), o)).toBe(POLL_RUNNING_MS);
  });
});
