/*
 * What a pull request's notes add up to (`GET /plugins/pr-notes/summary`): the
 * counts a board chip is drawn from. Exercised through plugin-ui.ts against a
 * private notes file, the same way the replies are.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRunning } from "../src/plugins.ts"; // imported first: the cycle plugins.ts <-> plugin-ui.ts resolves only from this side
import { __setPluginNotesPath, dropNotesOf, setLivenessCheck, setNoteStatus, summaryFor, upsertNotes, upsertRun } from "../src/plugin-ui.ts";
import type { Contributes } from "../../shared/pluginUi.ts";

const C = { prNotes: true } as Contributes;
const P = "acme-review";
const Q = "acme-lint";
const REPO = "acme/orbit";
const OLD = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-notes-summary-"));
  __setPluginNotesPath(join(dir, "plugin-notes.json"));
  setLivenessCheck(() => true);
});
afterAll(() => {
  __setPluginNotesPath(null);
  setLivenessCheck((name) => isRunning(name));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { dropNotesOf(P); dropNotesOf(Q); });

const note = (id: string, severity: string, over: Record<string, unknown> = {}) =>
  ({ id, repo: REPO, number: 1042, severity, title: `finding ${id}`, path: "src/a.ts", line: 3, ...over });
const run = (id: string, over: Record<string, unknown> = {}) =>
  upsertRun(P, C, { id, repo: REPO, number: 1042, sha: OLD, state: "done", title: "Review", startedAt: 1_000, finishedAt: 2_000, ...over });
const one = (heads?: Record<number, string>, repo = REPO, number: unknown = 1042) => summaryFor(repo, number, heads)!.prs[0];

describe("counts", () => {
  test("open by severity, resolved and dismissed apart, idea folded into info", () => {
    run("r1");
    upsertNotes(P, C, [note("a", "critical"), note("b", "critical"), note("c", "high"), note("d", "medium"), note("e", "low"), note("f", "idea"), note("g", "info"), note("h", "high"), note("i", "low")]);
    setNoteStatus(P, "h", "resolved");
    setNoteStatus(P, "i", "dismissed");
    expect(one()).toMatchObject({ open: { critical: 2, high: 1, medium: 1, low: 1, info: 2 }, resolved: 1, dismissed: 1, plugins: [P], lastReviewAt: 2_000 });
  });

  test("a change of status shows on the next read (the sums are not kept past a write)", () => {
    run("r1");
    upsertNotes(P, C, [note("a", "critical")]);
    expect(one().open.critical).toBe(1);
    setNoteStatus(P, "a", "resolved");
    expect(one().open.critical).toBe(0);
    expect(one().resolved).toBe(1);
  });

  test("two plugins on one pull request are one entry that names both", () => {
    run("r1");
    upsertNotes(P, C, [note("a", "high")]);
    upsertNotes(Q, C, [note("z", "high")]);
    expect(one().open.high).toBe(2);
    expect(one().plugins.sort()).toEqual([Q, P].sort());
  });
});

describe("stale", () => {
  test("the head the review covered against the current one", () => {
    run("r1", { sha: OLD });
    upsertNotes(P, C, [note("a", "high", { sha: OLD })]);
    expect(one({ 1042: OLD }).stale).toBe(false);
    expect(one({ 1042: NEW })).toMatchObject({ stale: true, reviewedSha: OLD, headSha: NEW });
  });

  test("a short sha from the list still matches", () => {
    run("r1", { sha: OLD });
    expect(one({ 1042: OLD.slice(0, 7) }).stale).toBe(false);
  });

  test("the newest finished run speaks for the review; a failed one does not", () => {
    run("r1", { sha: OLD, finishedAt: 2_000 });
    run("r2", { sha: NEW, finishedAt: 5_000 });
    run("r3", { sha: "3333333cccccccccccccccccccccccccccccccc", state: "failed", finishedAt: 9_000 });
    expect(one({ 1042: NEW })).toMatchObject({ stale: false, reviewedSha: NEW, lastReviewAt: 5_000 });
  });

  test("unknown head or unknown reviewed sha is null, never a guess", () => {
    run("r1", { sha: OLD });
    expect(one().stale).toBeNull();
    dropNotesOf(P);
    upsertNotes(P, C, [note("a", "high")]);
    expect(one({ 1042: NEW }).stale).toBeNull();
  });

  test("without runs the notes' own sha stands in", () => {
    upsertNotes(P, C, [note("a", "high", { sha: OLD })]);
    expect(one({ 1042: NEW })).toMatchObject({ stale: true, reviewedSha: OLD });
  });
});

describe("isolation", () => {
  test("another repository, or another pull request, is never counted", () => {
    run("r1");
    upsertNotes(P, C, [note("a", "critical"), note("b", "critical", { repo: "acme/other" }), note("c", "critical", { number: 7 })]);
    expect(one().open.critical).toBe(1);
    expect(summaryFor("acme/other", null)!.prs.map((p) => p.number)).toEqual([1042]);
    expect(summaryFor(REPO, null)!.prs.map((p) => p.number)).toEqual([7, 1042]);
    expect(summaryFor(REPO, 7)!.prs).toHaveLength(1);
    expect(summaryFor("acme/none", null)!.prs).toEqual([]);
  });

  test("a malformed repo or number is refused, not read as everything", () => {
    expect(summaryFor("orbit", null)).toBeNull();
    expect(summaryFor(undefined, null)).toBeNull();
    expect(summaryFor(REPO, "abc")).toBeNull();
    expect(summaryFor("../../etc", null)).toBeNull();
  });
});

describe("the route", async () => {
  const src = await Bun.file(join(import.meta.dir, "../src/index.ts")).text();
  const at = src.indexOf('pathname === "/plugins/pr-notes/summary"');
  const body = src.slice(at, src.indexOf("\n    }\n", at));
  test("is a GET, answers from the store and never asks GitHub", () => {
    expect(at).toBeGreaterThan(0);
    expect(body).toContain('req.method === "GET"');
    expect(body).toContain("summaryFor(");
    expect(body).not.toMatch(/fetch\(|gh\(|addComment|prRepoIdFor/);
  });
});
