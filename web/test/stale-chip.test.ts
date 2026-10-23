/*
 * "stale review · head moved" on a review of the current head. The head the
 * header compared with was the app's cached one, a push behind the review that
 * had just run. Decisions are in shared/headCompare.ts and lib/publishReview.ts.
 */
import { describe, expect, test } from "bun:test";
import { headNeedsRead, reviewStale, sameCommit } from "../../shared/headCompare.ts";
import { latestRun, publishButtonState } from "../src/lib/publishReview.ts";
import { deskGated } from "../src/lib/deskGate.ts";
import type { PrRun } from "../src/lib/pluginTypes.ts";

const A = "aaaaaaa1111111111111111111111111111111aa";
const B = "bbbbbbb2222222222222222222222222222222bb";
const C = "ccccccc3333333333333333333333333333333cc";
const run = (over: Partial<PrRun> = {}): PrRun => ({ id: "r1", repo: "acme/orbit", number: 1042, state: "done", title: "Review", sha: B, startedAt: 9_000, finishedAt: 10_000, ...over });

describe("one comparison", () => {
  test("prefix, case, and what is too short or not hex", () => {
    expect(sameCommit(B, B.slice(0, 7))).toBe(true);
    expect(sameCommit(B.toUpperCase(), B)).toBe(true);
    expect(sameCommit(A, B)).toBe(false);
    expect(sameCommit(B.slice(0, 6), B)).toBeNull();
    expect(sameCommit("not-a-sha!", B)).toBeNull();
    expect(sameCommit(undefined, B)).toBeNull();
  });
  test("stale only with both known, different, and the head read after the review ended", () => {
    expect(reviewStale(B, 10_000, { sha: C, at: 11_000 })).toBe(true);
    expect(reviewStale(B, 10_000, { sha: C, at: 5_000 })).toBeNull();
    expect(reviewStale(B, 10_000, { sha: B, at: 5_000 })).toBe(false);
    expect(reviewStale(undefined, 10_000, { sha: C, at: 11_000 })).toBeNull();
    expect(reviewStale(B, 10_000, undefined)).toBeNull();
    expect(headNeedsRead(B, 10_000, { sha: A, at: 5_000 })).toBe(true);
    expect(headNeedsRead(B, 10_000, { sha: A, at: 11_000 })).toBe(false);
  });
});

describe("the header chip", () => {
  test("cached head A, review of B finished after the read: no chip", () => {
    expect(publishButtonState(run(), [], { sha: A, at: 5_000 }).staleChip).toBe(false);
  });
  test("fresh head C: the chip; fresh head B: none", () => {
    expect(publishButtonState(run(), [], { sha: C, at: 11_000 })).toMatchObject({ staleChip: true, kind: "stale" });
    expect(publishButtonState(run(), [], { sha: B, at: 11_000 }).staleChip).toBe(false);
  });
  test("an older run is superseded, never stale", () => {
    const s = publishButtonState(run(), [], { sha: C, at: 11_000 }, true);
    expect(s).toMatchObject({ staleChip: false, supersededChip: true });
    expect(publishButtonState(run(), [], { sha: B, at: 11_000 }).supersededChip).toBe(false);
  });
});

describe("which run a plugin stands on", () => {
  const r = (id: string, plugin: string, startedAt: number, over: Partial<PrRun> = {}) => ({ ...run({ id, startedAt, finishedAt: startedAt + 5 }), plugin, ...over });
  test("the latest finished by finish time; a running one shows; other plugins ignored", () => {
    const runs = [r("r1", "acme-review", 1, { finishedAt: 50 }), r("r2", "acme-review", 2, { finishedAt: 20 }), r("x", "acme-lint", 9)];
    expect(latestRun(runs, "acme-review")?.id).toBe("r1");
    expect(latestRun([...runs, r("r3", "acme-review", 60, { state: "running", finishedAt: undefined })], "acme-review")?.id).toBe("r3");
  });
});

test("the publish routes carry the desk key and use the shared post", async () => {
  expect(deskGated("/plugins/pr-notes/publish")).toBe(true);
  expect(deskGated("/plugins/pr-notes/publish-preview")).toBe(true);
  expect(deskGated("/plugins/pr-notes/summary")).toBe(false);
  const api = await Bun.file(new URL("../src/lib/api.ts", import.meta.url)).text();
  expect(api).toContain('post<PublishPreview>("/plugins/pr-notes/publish-preview"');
  expect(api).toContain('post<{ ok: boolean; error?: string; url?: string; edited?: boolean }>("/plugins/pr-notes/publish"');
});
