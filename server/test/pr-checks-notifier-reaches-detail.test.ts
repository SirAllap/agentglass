/*
 * A CHECKS READ THE NOTIFIER MADE REACHES THE OPEN DETAIL.
 *
 * A suite failed while the detail sat in cache saying "1 check still running".
 * A finishing check does not move the pull request's `updatedAt`, so the
 * projections gated on it never carried the fresher read across.
 */
import { describe, expect, test } from "bun:test";
import { __peekDetail, __seedDetail, projectChecks, rollupChecks } from "../src/prs.ts";
import type { PrDetail } from "../../shared/types.ts";

const repo = { key: "acme/orbit", nameWithOwner: "acme/orbit", owner: "acme", name: "orbit" } as any;
const raw = (name: string, status: string, conclusion: string | null) =>
  ({ __typename: "CheckRun", name, status, conclusion, workflowName: "ci" }) as any;

const running = rollupChecks([raw("unit", "COMPLETED", "SUCCESS"), raw("summary", "IN_PROGRESS", null)]);
const failed = rollupChecks([raw("unit", "COMPLETED", "SUCCESS"), raw("summary", "COMPLETED", "FAILURE")]);

const seed = () => {
  const all = running.all.map((c) => ({ ...c, required: c.name === "summary" }));
  __seedDetail("acme/orbit#1042", { number: 1042, updatedAt: "2026-01-01T00:00:00Z", checks: running.rollup, checksAll: all } as unknown as PrDetail);
};

describe("projectChecks", () => {
  test("a fresher read replaces the detail's running checks and keeps its required marks", () => {
    seed();
    expect(__peekDetail("acme/orbit#1042")!.checks.allDone).toBe(false);
    projectChecks(repo, 1042, failed.rollup, failed.all, Date.now() + 1);
    const d = __peekDetail("acme/orbit#1042")!;
    expect([d.checks.allDone, d.checks.verdict]).toEqual([true, "red"]);
    expect(d.checksAll.find((c) => c.name === "summary")?.required).toBe(true);
  });
  test("a detail stored after the read began is left alone", () => {
    seed();
    projectChecks(repo, 1042, failed.rollup, failed.all, Date.now() - 10_000);
    expect(__peekDetail("acme/orbit#1042")!.checks.allDone).toBe(false);
  });
});
