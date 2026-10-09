/*
 * Where an Update branch request stands. The defect: the panel marked the
 * branch "just updated" when the request was ACCEPTED (GitHub answers 202,
 * queued, and can then not do it), blocking a retry for minutes on a branch
 * whose head had not moved.
 */
import { describe, expect, test } from "bun:test";
import {
  updateStanding, awaitingChecksOf, updateHeld, updateHeldTitle, stalledNote,
  REQUEST_WINDOW_MS, MOVED_WINDOW_MS, STALLED_SHOWN_MS,
} from "../../shared/justUpdated.ts";
import { mergeBlockers, computingDetail } from "../../shared/mergeBlockers.ts";

const NOW = Date.parse("2026-10-09T13:04:00Z");
const OLD = "2026-10-09T11:05:00Z";
const base = { now: NOW, headSha: "aaa1111", headCommittedAt: OLD, checksTotal: 4 };
const own = (agoMs: number, headBefore = "aaa1111") => ({ at: NOW - agoMs, headBefore });

describe("updateStanding", () => {
  test("nothing asked, old head, checks done: idle, button free", () => {
    const s = updateStanding(base);
    expect(s).toBe("idle");
    expect(updateHeld(s)).toBe(false);
    expect(awaitingChecksOf(s)).toBe(false);
  });

  test("mergeability UNKNOWN is not an input: still idle, so Update branch stays enabled", () => {
    // The caller has no way to pass it in; the table is the same as above.
    expect(updateStanding({ ...base, own: null })).toBe("idle");
  });

  test("accepted a moment ago, head unchanged: requested, held, NOT 'updated'", () => {
    const s = updateStanding({ ...base, own: own(10_000) });
    expect(s).toBe("requested");
    expect(updateHeld(s)).toBe(true);
    expect(awaitingChecksOf(s)).toBe(false);
    expect(updateHeldTitle(s)).toContain("requested");
    expect(updateHeldTitle(s)).not.toContain("was just updated");
  });

  test("accepted, head unchanged past the window: stalled, button back", () => {
    const s = updateStanding({ ...base, own: own(REQUEST_WINDOW_MS + 1) });
    expect(s).toBe("stalled");
    expect(updateHeld(s)).toBe(false);
    expect(awaitingChecksOf(s)).toBe(false);
  });

  test("stalled does not linger forever", () => {
    expect(updateStanding({ ...base, own: own(STALLED_SHOWN_MS + 1) })).toBe("idle");
  });

  test("head changed after the request: moved, held, awaiting checks", () => {
    const s = updateStanding({ ...base, headSha: "bbb2222", checksTotal: 0, own: own(20_000) });
    expect(s).toBe("moved");
    expect(updateHeld(s)).toBe(true);
    expect(awaitingChecksOf(s)).toBe(true);
    expect(updateHeldTitle(s)).toContain("just updated");
  });

  test("moved, but the window is over: idle", () => {
    expect(updateStanding({ ...base, headSha: "bbb2222", own: own(MOVED_WINDOW_MS + 1) })).toBe("idle");
  });

  test("a move that lands after the request window still counts as moved", () => {
    expect(updateStanding({ ...base, headSha: "bbb2222", own: own(REQUEST_WINDOW_MS + 5_000) })).toBe("moved");
  });

  test("head sha unknown: nothing is confirmed, so it is requested then stalled, never moved", () => {
    expect(updateStanding({ ...base, headSha: undefined, own: own(5_000) })).toBe("requested");
    expect(updateStanding({ ...base, headSha: undefined, own: own(REQUEST_WINDOW_MS + 1) })).toBe("stalled");
  });

  test("somebody else's fresh head with no checks yet: fresh-head", () => {
    const s = updateStanding({ ...base, headCommittedAt: new Date(NOW - 60_000).toISOString(), checksTotal: 0 });
    expect(s).toBe("fresh-head");
    expect(awaitingChecksOf(s)).toBe(true);
    expect(updateHeld(s)).toBe(true);
  });

  test("fresh head but checks already exist (queued after a real push): idle, the rollup speaks", () => {
    expect(updateStanding({ ...base, headCommittedAt: new Date(NOW - 60_000).toISOString(), checksTotal: 3 })).toBe("idle");
  });

  test("old head, no checks at all (a repo without CI): idle, not waiting forever", () => {
    expect(updateStanding({ ...base, checksTotal: 0 })).toBe("idle");
  });

  test("unparseable or future commit date is not 'fresh'", () => {
    expect(updateStanding({ ...base, checksTotal: 0, headCommittedAt: "not a date" })).toBe("idle");
    expect(updateStanding({ ...base, checksTotal: 0, headCommittedAt: new Date(NOW + 60_000).toISOString() })).toBe("idle");
  });

  test("the stalled sentence names UNKNOWN only when GitHub is in it", () => {
    expect(stalledNote("UNKNOWN")).toContain("computing mergeability");
    expect(stalledNote("BEHIND")).not.toContain("computing");
    expect(stalledNote("BEHIND", "Extra.")).toContain("Extra.");
  });
});

describe("UNKNOWN mergeability next to a branch that is behind", () => {
  const input = { state: "OPEN", mergeState: "UNKNOWN", baseRefName: "main", checks: { total: 4, success: 4, failure: 0, pending: 0, skipped: 0 } } as never;
  test("the blocker row says updating usually makes GitHub recompute", () => {
    const row = mergeBlockers({ ...(input as object), behind: 3 } as never).find((b) => b.kind === "computing");
    expect(row).toBeDefined();
    expect(row!.detail).toContain("updating it usually makes GitHub recompute");
  });
  test("not behind: the old sentence, no advice to update", () => {
    const row = mergeBlockers({ ...(input as object), behind: 0 } as never).find((b) => b.kind === "computing");
    expect(row!.detail).not.toContain("updating");
    expect(computingDetail(null)).toBe(computingDetail(0));
  });
});

describe("the panel", () => {
  const src = Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
  test("records the request on GitHub's answer, never on the press", async () => {
    const text = await src;
    const at = text.indexOf("onUpdateBranch={(syncLocal: boolean) => {");
    expect(at).toBeGreaterThan(0);
    const block = text.slice(at, text.indexOf("\n                          }}", at));
    const press = block.slice(0, block.indexOf("return act("));
    expect(press).not.toContain("setAsked(");
    expect(block).toContain("if (r.ok) setAsked(");
  });
});

describe("the branch moved but the pull request did not follow", () => {
  // Measured: the branch ref was at the merge commit, the PR still named the
  // old head with mergeability unknown, and a second press was refused.
  const lag = { ...base, headSha: "aaa1111", refSha: "eee5555" };
  test("ref differs from the PR head: held, with GitHub's sentence, not offered again", () => {
    const s = updateStanding(lag);
    expect(s).toBe("pr-lagging");
    expect(updateHeld(s)).toBe(true);
    expect(awaitingChecksOf(s)).toBe(false);
    expect(updateHeldTitle(s)).toContain("has not caught up yet");
  });
  test("it beats a stalled or requested request: the ref is the better witness", () => {
    expect(updateStanding({ ...lag, own: own(REQUEST_WINDOW_MS + 1) })).toBe("pr-lagging");
    expect(updateStanding({ ...lag, own: own(1000) })).toBe("pr-lagging");
  });
  test("ref equals the head, or unknown: not lagging", () => {
    expect(updateStanding({ ...base, refSha: "aaa1111" })).toBe("idle");
    expect(updateStanding({ ...base, refSha: null })).toBe("idle");
    expect(updateStanding({ ...base, refSha: undefined })).toBe("idle");
  });
});
