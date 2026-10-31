/*
 * The guardrails as code: executeAction refuses what is not on its list, forces a dry
 * run when the door says dry, and logs every outcome; and the source of the module and
 * its routes has no way to merge, comment, label, review or move a card.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESETS, classifyPr, type DoorValue } from "../../shared/polaris.ts";
import { actionLog } from "../src/db.ts";
import { writePolaris } from "../src/config.ts";
import { ACTION_TYPES, __draftOf, __resetPolaris, executeAction, factsOf, needsNames, polarisItems, sweep, type PolarisIo, type RunRef } from "../src/polaris.ts";
import { polarisRoute } from "../src/polarisRoutes.ts";
import type { PrSummary } from "../../shared/types.ts";

const SRC = {
  "polaris.ts": await Bun.file(new URL("../src/polaris.ts", import.meta.url)).text(),
  "polarisRoutes.ts": await Bun.file(new URL("../src/polarisRoutes.ts", import.meta.url)).text(),
};
const savedHome = process.env.XDG_CONFIG_HOME;
const dirs: string[] = [];
const ROOT = "/work/acme/orbit";
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "agx-polaris-act-"));
  dirs.push(dir);
  process.env.XDG_CONFIG_HOME = dir;
  __resetPolaris();
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedHome;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const doors = () => structuredClone(PRESETS.guided.doors);
const on = (over: Record<string, DoorValue> = {}) => writePolaris(ROOT, { enabled: true, preset: "custom", doors: { ...doors(), ...over } });
function io() {
  const calls: number[] = [];
  const i: PolarisIo = { rerunJob: async (_r, id) => { calls.push(id); return { ok: true }; }, readJobs: async () => null };
  return { i, calls };
}
const run = (over: Partial<RunRef> = {}): RunRef => ({ runId: 900, attempt: 1, pending: false, job: { id: 11, conclusion: "failure", stepConclusions: [null] }, ...over });
const lastLog = () => actionLog(5).find((r) => r.actor === "polaris")!;

describe("executeAction", () => {
  test("the allow-list is the nine writes and nothing else", async () => {
    expect([...ACTION_TYPES]).toEqual(["relaunch", "beacon-draft", "beacon-edit", "beacon-discard", "beacon-send-on-click", "dock", "ignore", "propose", "sync"]);
    on();
    for (const t of ["merge", "comment", "label", "review", "move-card", "close"]) {
      expect(await executeAction(t, { root: ROOT, number: 7 })).toMatchObject({ ok: false, error: expect.stringContaining("not something Polaris does") });
    }
  });

  test("nothing happens while Polaris is off", async () => {
    const { i, calls } = io();
    expect(await executeAction("relaunch", { root: ROOT, number: 7, run: run() }, i)).toMatchObject({ ok: false, error: "Polaris is off for this project" });
    expect(calls).toEqual([]);
  });

  test("a dry run records skipped-in-dry-run in the audit log and calls nothing", async () => {
    on();
    const { i, calls } = io();
    expect(await executeAction("relaunch", { root: ROOT, number: 7, run: run() }, i)).toEqual({ ok: true, outcome: "skipped-in-dry-run" });
    expect(calls).toEqual([]);
    expect(lastLog()).toMatchObject({ action: "/polaris/relaunch", target: "orbit #7", ok: 1, detail: "skipped-in-dry-run" });
  });

  test("live relaunches a dropped job once, at attempt 1 and 2, never at attempt 3", async () => {
    on({ relaunch: { mode: "live", cap: 3 } });
    const { i, calls } = io();
    expect(await executeAction("relaunch", { root: ROOT, number: 7, run: run({ attempt: 1 }) }, i)).toMatchObject({ ok: true, outcome: "done" });
    expect(calls).toEqual([11]);
    expect(await executeAction("relaunch", { root: ROOT, number: 7, run: run({ attempt: 3 }) }, i)).toMatchObject({ ok: false });
    expect(calls).toEqual([11]);
    expect(lastLog()).toMatchObject({ ok: 0 });
  });

  test("never a job that failed on its own steps, a cancelled one, or while a check runs", async () => {
    on({ relaunch: { mode: "live", cap: 3 } });
    const { i, calls } = io();
    const job = (conclusion: string, steps: (string | null)[]) => run({ job: { id: 12, conclusion, stepConclusions: steps } });
    expect(await executeAction("relaunch", { root: ROOT, number: 7, run: job("failure", ["failure"]) }, i)).toMatchObject({ ok: false });
    expect(await executeAction("relaunch", { root: ROOT, number: 7, run: job("cancelled", [null]) }, i)).toMatchObject({ ok: false });
    expect(await executeAction("relaunch", { root: ROOT, number: 7, run: run({ pending: true }) }, i)).toMatchObject({ ok: false });
    expect(await executeAction("relaunch", { root: ROOT, number: 7 }, i)).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  test("a door that is off refuses its action", async () => {
    on({ relaunch: { mode: "off", cap: 3 }, beacon: { mode: "off" }, dock: { mode: "off", label: "docked", excluded: [] } });
    const { i, calls } = io();
    expect(await executeAction("relaunch", { root: ROOT, number: 7, run: run() }, i)).toMatchObject({ ok: false });
    expect(await executeAction("beacon-draft", { root: ROOT, number: 7, reason: "conflict", text: "x" }, i)).toMatchObject({ ok: false });
    expect(await executeAction("dock", { root: ROOT, number: 7 }, i)).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  test("a beacon is a draft once per reason, and sending needs a draft and a session", async () => {
    on();
    const a = { root: ROOT, number: 7, reason: "conflict", text: "Merge conflict with main in 2 files." };
    expect(await executeAction("beacon-draft", a)).toMatchObject({ ok: true });
    expect(await executeAction("beacon-draft", a)).toMatchObject({ ok: false, error: expect.stringContaining("already") });
    expect(await executeAction("beacon-send-on-click", { root: ROOT, number: 7, reason: "conflict" })).toMatchObject({ ok: false, error: expect.stringContaining("pick the session") });
    expect(await executeAction("beacon-send-on-click", { root: ROOT, number: 8, reason: "conflict", paneId: "%1" })).toMatchObject({ ok: false, error: "there is no draft for this reason" });
  });

  test("a draft is edited or discarded by the person, and a discarded reason is not drafted again", async () => {
    on();
    const a = { root: ROOT, number: 7, reason: "conflict", text: "Merge conflict with main in 2 files." };
    expect(await executeAction("beacon-edit", { ...a, text: "x" })).toMatchObject({ ok: false, error: "there is no draft for this reason" });
    expect(await executeAction("beacon-discard", a)).toMatchObject({ ok: false });
    await executeAction("beacon-draft", a);
    expect(await executeAction("beacon-edit", { ...a, text: "  " })).toMatchObject({ ok: false });
    expect(await executeAction("beacon-edit", { ...a, text: "Bring main in and push." })).toMatchObject({ ok: true });
    expect(__draftOf(ROOT, 7, "conflict")).toBe("Bring main in and push.");
    expect(await executeAction("beacon-discard", a)).toMatchObject({ ok: true });
    expect(__draftOf(ROOT, 7, "conflict")).toBeUndefined();
    expect(await executeAction("beacon-draft", a)).toMatchObject({ ok: false, error: expect.stringContaining("already") });
    // a different reason is a different beacon
    expect(await executeAction("beacon-draft", { ...a, reason: "review" })).toMatchObject({ ok: true });
  });

  test("dock adds the number to the dock door and ignore only marks the item", async () => {
    on();
    expect(await executeAction("dock", { root: ROOT, number: 7 })).toMatchObject({ ok: true });
    const f = factsOf({ number: 7, labels: [], state: "OPEN", isDraft: false, checks: { pending: 0, failing: [] }, mergeable: "MERGEABLE", reviewDecision: null } as never, (await import("../src/config.ts")).readPolaris(ROOT).settings.doors);
    expect(f.excluded).toBe(true);
    expect(await executeAction("ignore", { root: ROOT, number: 7, reason: "review" })).toMatchObject({ ok: true });
    expect(await executeAction("propose", { root: ROOT, number: 7 })).toMatchObject({ ok: false });
    expect(await executeAction("propose", { root: ROOT, number: 7, door: "cleanup", text: "close the session" })).toMatchObject({ ok: true });
  });
});

describe("the sweep and its routes", () => {
  const pr = { number: 7, title: "Add retry to the webhook sender", author: "ada", state: "OPEN", isDraft: false, headRefName: "feat/retry", baseRefName: "main", url: "https://example.test/acme/orbit/pull/7", labels: [], reviewDecision: "APPROVED", mergeable: "MERGEABLE", checksLoaded: true, humanReview: { kind: "approved", who: ["ada"] }, checks: { total: 1, success: 0, failure: 1, skipped: 0, pending: 0, allDone: true, verdict: "red", failing: [{ name: "test", workflow: "ci", state: "failure", done: true, required: true, url: "https://example.test/acme/orbit/actions/runs/900/job/11", completedAt: "t1" }] } } as unknown as PrSummary;

  test("facts from a board row: the failing check carries its run, an approval by a person counts", () => {
    const f = factsOf(pr, PRESETS.guided.doors);
    expect(f.checks[0]).toMatchObject({ name: "test", state: "failure", required: true, runId: 900 });
    expect(f.approvals).toEqual([{ isBot: false }]);
  });

  test("a row the list counts red but does not name is read once; a named or green row is not", () => {
    const red = { ...pr, checks: { ...pr.checks, failing: [] } } as PrSummary;
    expect(needsNames(red)).toBe(true);
    expect(needsNames(pr)).toBe(false);
    expect(needsNames({ ...red, checks: { ...red.checks, failure: 0 } } as PrSummary)).toBe(false);
    // The classification hangs on it: without the names a red pull request would read as cleared to land.
    expect(classifyPr(factsOf(red, PRESETS.guided.doors)).cls).toBe("Cleared to land");
    expect(classifyPr(factsOf(pr, PRESETS.guided.doors)).cls).toBe("Needs you");
  });

  test("the names are read only behind that test, through the io seam", () => {
    const t = SRC["polaris.ts"];
    const fn = t.slice(t.indexOf("export async function polarisItems("), t.indexOf("/** At most one relaunch per run attempt"));
    expect(fn).toMatch(/needsNames\(row\) \? await io\.checksFor\?\.\(root, row\.number\) : null/);
    expect(t.match(/\bprRollup\(/g)).toHaveLength(1);
  });

  test("off, or no follow door, reads nothing", async () => {
    expect(await polarisItems(ROOT)).toEqual({ ok: true, enabled: false, items: [] });
    on({ follow: { mode: "off" } });
    expect(await polarisItems(ROOT)).toEqual({ ok: true, enabled: true, items: [] });
  });

  test("an agent cannot write settings or act through the routes", async () => {
    for (const [m, p] of [["PUT", "/polaris/settings"], ["POST", "/polaris/items/7/action"], ["POST", "/polaris/items/7/beacon/send"], ["POST", "/polaris/items/7/beacon/edit"], ["POST", "/polaris/items/7/beacon/discard"]] as const) {
      expect(await polarisRoute(m, p, new URLSearchParams(), { root: ROOT, enabled: true, type: "dock" }, false)).toMatchObject({ status: 403 });
    }
  });

  test("the person's route sets a preset and enabling, and refuses a bad door", async () => {
    const put = (b: Record<string, unknown>) => polarisRoute("PUT", "/polaris/settings", new URLSearchParams(), { root: ROOT, ...b }, true);
    expect((await put({ preset: "watchOnly" }))!.body).toMatchObject({ ok: true, preset: "watchOnly", enabled: false });
    expect((await put({ enabled: true }))!.body).toMatchObject({ enabled: true, preset: "watchOnly" });
    expect((await put({ settings: { doors: { relaunch: { mode: "now" } } } }))!.status).toBe(400);
    expect((await put({ preset: "turbo" }))!.status).toBe(400);
    const got = await polarisRoute("GET", "/polaris/settings", new URLSearchParams({ root: ROOT }), {}, false);
    expect(got!.body).toMatchObject({ ok: true, enabled: true, layers: { follow: "project" } });
    expect(await polarisRoute("GET", "/other", new URLSearchParams(), {}, true)).toBeNull();
  });

  test("the person's routes edit and discard a draft; send is its own route and an action body cannot name it", async () => {
    on();
    const post = (path: string, b: Record<string, unknown>) => polarisRoute("POST", `/polaris/items/7/${path}`, new URLSearchParams(), { root: ROOT, reason: "conflict", ...b }, true);
    expect((await post("action", { type: "beacon-draft", text: "Merge conflict with main." }))!.status).toBe(200);
    expect((await post("beacon/edit", { text: "Bring main in." }))!.status).toBe(200);
    expect(__draftOf(ROOT, 7, "conflict")).toBe("Bring main in.");
    expect((await post("beacon/edit", {}))!.status).toBe(409);
    expect((await post("beacon/discard", {}))!.status).toBe(200);
    expect(__draftOf(ROOT, 7, "conflict")).toBeUndefined();
    expect((await post("action", { type: "relaunch" }))!.status).toBe(400);
    expect((await post("action", { type: "merge" }))!.status).toBe(400);
  });

  test("the sweep relaunches a dropped job once per run attempt and keeps the gap", async () => {
    on({ relaunch: { mode: "live", cap: 3 }, lookAgain: { mode: "on", minutes: 5, steps: 1 } });
    const { i, calls } = io();
    const item = { reason: "runner", number: 7, dropped: [run()] };
    const load = (async () => ({ ok: true, enabled: true, items: [item] })) as never;
    const t0 = 10_000_000;
    expect(await sweep(ROOT, i, t0, load)).toBe(1);
    expect(calls).toEqual([11]);
    // inside the gap nothing is read; after it, the same run attempt is not tried again
    expect(await sweep(ROOT, i, t0 + 60_000, load)).toBe(0);
    expect(await sweep(ROOT, i, t0 + 6 * 60_000, load)).toBe(0);
    // a new attempt of the run is a new try
    item.dropped = [run({ attempt: 2 })];
    expect(await sweep(ROOT, i, t0 + 12 * 60_000, load)).toBe(1);
    expect(calls).toEqual([11, 11]);
  });
});

describe("the source: no way to merge, comment, label, review or move a card", () => {
  /* Comment lines stripped; what is left is code and strings. Patterns are call shapes, not words:
     the doors are named labels and approvals. */
  const code = (t: string) => t.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  const FORBIDDEN: [string, RegExp][] = [
    ["a merge", /\bpr["',\s]+merge\b|\/merge\b|mergePullRequest|enablePullRequestAutoMerge|mergeBranch/],
    ["a comment", /\bpr["',\s]+comment\b|issue["',\s]+comment|\/comments\b|addComment|addPullRequestReviewComment|createComment/],
    ["a label", /\bissue["',\s]+edit\b|issues\/[^"'`\s]*\/labels|addLabels|removeLabel|--add-label|--remove-label/],
    ["a review", /\bpr["',\s]+review\b|\/reviews\b|submitReview|addPullRequestReview|--approve|--request-changes/],
    ["a card move", /transitionJiraIssue|\/transitions\b|updateTask|\/task\/|moveCard|setStatus/],
  ];
  for (const [file, text] of Object.entries(SRC)) {
    for (const [what, re] of FORBIDDEN) test(`${file} has no path to ${what}`, () => expect(code(text)).not.toMatch(re));
  }

  test("each pattern goes red on a line that does what it forbids", () => {
    const bad = ['gh(["pr", "merge", "7"])', 'gh(["pr", "comment", "7"])', 'gh(["issue", "edit", "7", "--add-label", "x"])', 'gh(["pr", "review", "7", "--approve"])', 'transitionJiraIssue(k)'];
    FORBIDDEN.forEach(([, re], n) => expect(code(bad[n]!)).toMatch(re));
    expect(code("// pr merge is never here")).not.toMatch(FORBIDDEN[0]![1]);
  });

  test("the two gh writes are the rerun helper and the sync helper, each called only inside executeAction", () => {
    const t = code(SRC["polaris.ts"]);
    const calls = [...t.matchAll(/\bgh\(\s*\[([^\]]*)\]/g)].map((m) => m[1]!.replace(/\s+/g, " "));
    // Every other gh call is a read through `gh api` with no method flag.
    expect(calls.filter((c) => !/^"api", `/.test(c))).toEqual([
      '"run", "rerun", "--job", String(jobId), "-R", repo.nameWithOwner',
      '"api", "-X", "PUT", `repos/${repo.nameWithOwner}/pulls/${number}/update-branch`, "-f", `expected_head_sha=${expectedHeadSha}`',
    ]);
    expect(calls.filter((c) => /"-X"|"--method"/.test(c))).toHaveLength(1);
    expect(t.match(/function rerunJob\(/g)).toHaveLength(1);
    expect(t.match(/function updateBranch\(/g)).toHaveLength(1);
    const exec = t.slice(t.indexOf("export async function executeAction("), t.indexOf("async function run("));
    const body = t.slice(t.indexOf("async function run("), t.indexOf("// ── the sweep ──"));
    expect(exec).not.toMatch(/promptAgent\(/);
    expect(body.match(/io\.rerunJob\(/g)).toHaveLength(1);
    // update-branch: one call, in the sync case, and nowhere in the sweep, the items or the wake.
    expect(body.match(/io\.updateBranch\(/g)).toHaveLength(1);
    expect(body.slice(body.indexOf('case "sync"'), body.indexOf('case "beacon-draft"'))).toMatch(/io\.updateBranch\(/);
    expect(body.match(/io\.localAfter\?*\.?\(/g)).toHaveLength(1);
    expect(t.slice(t.indexOf("export async function sweep("))).not.toMatch(/executeAction\("sync"|\bupdateBranch\b/);
  });

  test("promptAgent is called once, from the click case of executeAction's run", () => {
    const t = code(SRC["polaris.ts"]);
    expect(t.match(/\bpromptAgent\(/g)).toHaveLength(1);
    const click = t.slice(t.indexOf('case "beacon-send-on-click"'), t.indexOf('case "dock"'));
    expect(click).toMatch(/promptAgent\(/);
  });

  test("editing and discarding a draft stay in memory: no gh, no session, no send", () => {
    const t = code(SRC["polaris.ts"]);
    const cases = t.slice(t.indexOf('case "beacon-edit"'), t.indexOf('case "propose"'));
    expect(cases).toMatch(/drafts\.set\(/);
    expect(cases).not.toMatch(/promptAgent|io\.|gh\(|writePolaris|sent\./);
    expect(t.slice(t.indexOf("async function run("), t.indexOf("// ── the sweep ──")).match(/drafts\.(set|delete)\(/g)).toHaveLength(5);
  });

  test("the routes reach the module only through executeAction, and write only settings", () => {
    const r = code(SRC["polarisRoutes.ts"]);
    expect(r).not.toMatch(/\bgh\(|promptAgent|rerunJob|recordAction/);
    expect(r.match(/executeAction\(/g)).toHaveLength(1);
    // The sync is reachable from the click route only, and that route is behind the person check.
    expect(r).not.toMatch(/updateBranch/);
    expect(r.indexOf("if (!person)")).toBeLessThan(r.indexOf("executeAction("));
    expect(r.match(/\bwritePolaris\(/g)).toHaveLength(1);
    expect(r).toMatch(/if \(!person\)/);
  });
});
