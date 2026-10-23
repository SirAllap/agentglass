/*
 * A finding belongs to the pull request, not to the run that last touched it.
 * A plugin with four reviews, the earlier ones closing findings with replies
 * and the last one clean, used to publish an EMPTY preview: the route kept only
 * the notes of the latest run.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_PUBLISH_OPTIONS, buildReviewComment, headerRun, previewReview, publishNotes, type PublishDeps } from "../src/review-publish.ts";
import type { PrNote, PrRun } from "../../shared/pluginUi.ts";

const P = "acme-review", REPO = "acme/orbit";
const HEAD = "a07f77d0e8b7a6f5e4d3c2b1a09f8e7d6c5b4a39";
type R = PrRun & { plugin: string };
type N = PrNote & { plugin: string };
const run = (id: string, startedAt: number, over: Partial<R> = {}): R =>
  ({ id, plugin: P, repo: REPO, number: 1042, sha: HEAD, state: "done", title: "Review", startedAt, finishedAt: startedAt + 100, ...over });
const runs = [run("r1", 1000), run("r2", 2000), run("r3", 3000), run("r4", 4000, { agent: "Claude Code" })];
const resolved = (i: number): N => ({
  id: `f-${i}`, plugin: P, repo: REPO, number: 1042, severity: "medium", title: `Closed finding ${i}`, status: "resolved", runId: `r${(i % 3) + 1}`,
  createdAt: i, updatedAt: i, replies: [{ id: `x${i}`, text: `Fixed ${i}.`, at: i, by: "user", withStatus: "resolved" }],
});
const notes = [...Array(9).keys()].map((i) => resolved(i + 1));
const build = (o = {}) => {
  const hdr = headerRun(runs, P);
  const b = buildReviewComment({ plugin: P, repo: REPO, number: 1042, run: hdr.run!, reviews: hdr.reviews, notes: publishNotes(notes, P, REPO, 1042), options: { ...DEFAULT_PUBLISH_OPTIONS, ...o } });
  if (!b.ok) throw new Error(b.error);
  return b.markdown;
};
const priced = [run("r1", 1000, { costUsd: 0.5 }), run("r2", 2000, { costUsd: 1.25 }), run("r3", 3000)];
const blocks = (m: string) => (m.match(/<details/g) ?? []).length;

describe("4 runs, 9 resolved findings in the older ones, a clean last run", () => {
  test("defaults: header and verdict, none of the closed ones", () => {
    const m = build();
    expect(m).toContain("Local review");
    expect(m).toContain("Verdict: no open findings");
    expect(m).toContain("4 reviews");
    expect(blocks(m)).toBe(0);
  });
  test("tick resolved: nine blocks, replies kept", () => {
    const m = build({ includeResolved: true, includeReplies: true });
    expect(blocks(m)).toBe(9);
    expect(m).toContain("Fixed 9.");
    expect(m).toContain("9 resolved");
  });
  test("the header speaks for the latest finished run, however the list is ordered", () => {
    expect(headerRun([...runs].reverse(), P).run!.id).toBe("r4");
    expect(headerRun([...runs, run("r5", 5000, { state: "running", finishedAt: undefined })], P).run!.id).toBe("r4");
  });
  test("another plugin's findings never ride along", () => {
    expect(publishNotes([...notes, { ...resolved(99), plugin: "acme-lint" }], P, REPO, 1042)).toHaveLength(9);
  });
});

describe("the preview's stale flag", () => {
  const deps = (headSha: string, headReadAt: number): PublishDeps => ({
    read: async () => ({ ok: true, viewer: "acme-user", comments: [], headSha, headReadAt }),
    create: async () => ({ ok: true }), edit: async () => ({ ok: true }),
  });
  const req = { plugin: P, repo: REPO, number: 1042, run: runs[3]!, notes: [], options: DEFAULT_PUBLISH_OPTIONS };
  test("a head read before the review ended is not stale; a fresh different one is", async () => {
    const other = "c".repeat(40);
    expect((await previewReview(req, deps(other, 4050)) as any).stale).toBe(false);
    expect((await previewReview(req, deps(other, 9000)) as any).stale).toBe(true);
    expect((await previewReview(req, deps(HEAD, 9000)) as any).stale).toBe(false);
  });
});

describe("the Cost column with more than one review", () => {
  const table = (rs: R[]) => {
    const hdr = headerRun(rs, P);
    const b = buildReviewComment({ plugin: P, repo: REPO, number: 1042, run: hdr.run!, reviews: hdr.reviews, totalCost: hdr.totalCost, notes: [], options: { ...DEFAULT_PUBLISH_OPTIONS } });
    if (!b.ok) throw new Error(b.error);
    return b.markdown;
  };
  test("sums every finished review and says so, not the last run's cost alone", () => {
    expect(headerRun(priced, P).totalCost).toBe(1.75);
    expect(table(priced)).toContain("| $1.75 total |");
  });
  test("one review keeps its own cost, unlabelled", () => {
    expect(table([priced[1]!])).toContain("| $1.25 |");
  });
  test("no run priced: a dash, not $0.00", () => {
    expect(headerRun(runs, P).totalCost).toBeUndefined();
    expect(table(runs)).toContain("| - | 1970-01-01 |");
  });
});
