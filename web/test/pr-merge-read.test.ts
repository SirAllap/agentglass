/*
 * Opening a pull request from its "CI passed" notification showed the fresh
 * chip beside a merge state read while a required check was still running:
 * BLOCKED with nothing to show for it, then "Ready to land" after a refresh.
 * Fixtures use invented repos and shas (acme/orbit #1042, ORBIT-1042).
 */
import { describe, expect, it } from "bun:test";
import { mergeReadOwed } from "../../shared/prFreshness.ts";
import { mergeBlockers, type BlockerInput } from "../../shared/mergeBlockers.ts";
import type { PrCheck, PrCheckRollup } from "../../shared/types.ts";

const green = { total: 3, success: 3, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] } as PrCheckRollup;
const running = { ...green, success: 1, pending: 2, allDone: false, verdict: null } as PrCheckRollup;
const read = (o: { readAt: number; mergeState: "BLOCKED" | "UNKNOWN" | "CLEAN"; mergeable?: "MERGEABLE" | "UNKNOWN"; checks?: PrCheckRollup }) => ({
  readAt: o.readAt, mergeState: o.mergeState, mergeable: o.mergeable ?? "MERGEABLE", checks: o.checks ?? green,
});

describe("a merge state older than the checks that raised the notification", () => {
  it("is read again, and a reading at or after the checks is not", () => {
    const stale = read({ readAt: 1_000, mergeState: "BLOCKED" });
    expect(mergeReadOwed(stale, { at: 2_000 })).toBe(true);
    expect(mergeReadOwed(read({ readAt: 1_000, mergeState: "UNKNOWN", mergeable: "UNKNOWN" }), { at: 2_000 })).toBe(true);
    expect(mergeReadOwed(stale, { at: 1_000 })).toBe(false);
    expect(mergeReadOwed(stale, null)).toBe(false);
    expect(mergeReadOwed(read({ readAt: 1_000, mergeState: "CLEAN" }), { at: 2_000 })).toBe(false);
    expect(mergeReadOwed(read({ readAt: 1_000, mergeState: "BLOCKED", checks: running }), { at: 2_000 })).toBe(false);
  });

  it("shows Checking… instead of calling it blocked without saying why", () => {
    const check = (name: string): PrCheck => ({ name, workflow: "CI", state: "success", done: true, required: true });
    const input = (mergeStale: boolean): BlockerInput => ({
      state: "OPEN", mergeState: "BLOCKED", mergeable: "MERGEABLE", baseRefName: "main",
      checksAll: [check("unit")], gate: undefined, openThreads: 0, mergeStale,
    });
    expect(mergeBlockers(input(true)).map((b) => b.kind)).toEqual(["checking"]);
    expect(mergeBlockers(input(false)).map((b) => b.kind)).toEqual(["unexplained"]);
  });
});

describe("the panel asks once per open, and on no timer", () => {
  it("reads the merge state when the checks are newer, using the one extra read", async () => {
    const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
    expect(src).toContain("mergeReadOwed(detail, lastChecks)");
    expect(src).toContain("void loadDetailRef.current?.(serverDetail.number, true);");
    expect(src).toContain("if (mergeReread.current === serverDetail.number) return;");
    const effect = src.slice(src.indexOf("if (!mergeStale ||"), src.indexOf("The pull request on screen"));
    expect(effect).not.toContain("setInterval");
  });
});
