/*
 * A red the base branch has too: detection from the commit a run tested, one read of the
 * base per commit however many pull requests inherit, one signal per base fix, and the
 * sync that is only ever a click. The fixture is a repo whose test job broke on `main`.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESETS, type DoorValue, type PolarisItem, type PrFacts } from "../../shared/polaris.ts";
import { actionLog } from "../src/db.ts";
import { writePolaris } from "../src/config.ts";
import { __resetPolaris, __syncConflicted, baseReader, basesOf, executeAction, markInherited, onBaseFixed, sweep, type BaseChecks, type BaseFixed, type PolarisIo } from "../src/polaris.ts";
import { polarisRoute } from "../src/polarisRoutes.ts";

const ROOT = "/work/acme/orbit";
const dirs: string[] = [];
const savedHome = process.env.XDG_CONFIG_HOME;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "agx-polaris-inh-"));
  dirs.push(dir);
  process.env.XDG_CONFIG_HOME = dir;
  __resetPolaris();
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedHome;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sha = (c: string) => c.repeat(40);
const OLD = sha("a"), NEW = sha("d"), HEAD = sha("1");
const doors = () => structuredClone(PRESETS.guided.doors);
const on = (over: Record<string, DoorValue> = {}) => writePolaris(ROOT, { enabled: true, preset: "custom", doors: { ...doors(), ...over } });
const failing = (runId: number, name = "django-tests"): PrFacts["checks"][number] => ({ name, state: "failure", required: true, runId });

/** A GitHub that answers for `main`: red at OLD, and at NEW whatever `tip` says. */
function gh(tip: "red" | "green" | "pending" = "red") {
  const calls: string[] = [];
  const at: Record<string, BaseChecks> = {
    [OLD]: { sha: OLD, checks: [{ name: "django-tests", state: "failure" }] },
    [NEW]: { sha: NEW, checks: [{ name: "django-tests", state: tip === "green" ? "success" : tip === "pending" ? "pending" : "failure" }] },
  };
  const io: PolarisIo = {
    rerunJob: async () => ({ ok: true }), readJobs: async () => null,
    // Runs 901 to 904 tested OLD through a merge commit; run 905 ran on a plain commit, which says nothing about the base.
    testedBase: async (_r, id) => (id >= 901 && id <= 904 ? OLD : null),
    baseChecks: async (_r, ref) => { calls.push(ref === "main" ? "tip" : ref.slice(0, 1)); return ref === "main" ? at[NEW]! : at[ref] ?? null; },
  };
  return { io, calls };
}
const item = (number: number, over: Partial<PolarisItem> = {}): PolarisItem => ({
  number, title: `PR ${number}`, url: "", author: "ada", head: `f${number}`, ignored: false, draft: null, proposed: [], dropped: [], headSha: HEAD, canSync: false, syncDraft: null,
  cls: "Needs you", reason: "inherited", sentence: "", inherited: { checks: ["django-tests"], baseSha: OLD }, ...over,
});

describe("detection", () => {
  test("red on the PR and red on the base at the commit the run tested is inherited", async () => {
    const { io } = gh();
    const facts = { checks: [{ name: "build", state: "success" as const }, failing(901)] } as PrFacts;
    expect(await markInherited(ROOT, facts, io, baseReader(ROOT, io))).toEqual({ checks: ["django-tests"], baseSha: OLD });
    expect(facts.checks[1]!.inherited).toBe(true);
    expect(facts.checks[0]!.inherited).toBeUndefined();
  });

  test("a red the base did not have is the pull request's own", async () => {
    const { io } = gh();
    const facts = { checks: [failing(901, "lint")] } as PrFacts;
    expect(await markInherited(ROOT, facts, io, baseReader(ROOT, io))).toBeUndefined();
    expect(facts.checks[0]!.inherited).toBeUndefined();
  });

  test("a run on a plain commit says nothing about the base: not inherited", async () => {
    const { io } = gh();
    expect(await markInherited(ROOT, { checks: [failing(905)] } as PrFacts, io, baseReader(ROOT, io))).toBeUndefined();
  });

  test("a job the runner dropped is never inherited", async () => {
    const { io } = gh();
    const c = { ...failing(901), job: { conclusion: "failure", stepConclusions: [null] } };
    expect(await markInherited(ROOT, { checks: [c] } as PrFacts, io, baseReader(ROOT, io))).toBeUndefined();
  });

  test("four pull requests on one base commit read it once", async () => {
    const { io, calls } = gh();
    const read = baseReader(ROOT, io);
    for (const run of [901, 902, 903, 904]) await markInherited(ROOT, { checks: [failing(run)] } as PrFacts, io, read);
    expect(calls).toEqual(["a"]);
  });
});

test("the live read takes the base from a merge commit only: two parents, the first", async () => {
  const t = await Bun.file(new URL("../src/polaris.ts", import.meta.url)).text();
  const fn = t.slice(t.indexOf("async function testedBase("), t.indexOf("async function baseChecks("));
  expect(fn).toMatch(/parents\.length === 2 \? parents\[0\]! : null/);
});

describe("the base, fixed or not", () => {
  const four = () => [1, 2, 3, 4].map((n) => item(n));
  const baseOf = new Map<number, string>([1, 2, 3, 4].map((n) => [n, "main"]));
  const idle = new Map<number, number>([1, 2, 3, 4].map((n) => [n, 0]));

  test("still red at a newer commit: banner, nothing to sync", async () => {
    const { io, calls } = gh("red");
    const items = four();
    const bases = await basesOf(items, baseOf, idle, baseReader(ROOT, io));
    expect(bases).toEqual([{ base: "main", checks: ["django-tests"], sinceSha: OLD, tipSha: NEW, fixed: false, inheritors: [1, 2, 3, 4], canSync: [] }]);
    expect(calls).toEqual(["tip"]);
  });

  test("green at a newer commit: all four can sync, from one read of the tip", async () => {
    const { io, calls } = gh("green");
    const items = four();
    const [b] = await basesOf(items, baseOf, idle, baseReader(ROOT, io));
    expect(b).toMatchObject({ fixed: true, canSync: [1, 2, 3, 4], tipSha: NEW });
    expect(items.every((i) => i.canSync)).toBe(true);
    expect(calls).toEqual(["tip"]);
  });

  test("a check still running, or the same commit, is not fixed; a pull request with checks running waits", async () => {
    expect((await basesOf(four(), baseOf, idle, baseReader(ROOT, gh("pending").io)))[0]!.fixed).toBe(false);
    const items = four();
    const busy = new Map(idle).set(2, 1);
    const [b] = await basesOf(items, baseOf, busy, baseReader(ROOT, gh("green").io));
    expect(b!.canSync).toEqual([1, 3, 4]);
    const same: PolarisIo = { ...gh().io, baseChecks: async () => ({ sha: OLD, checks: [{ name: "django-tests", state: "success" }] }) };
    expect((await basesOf(four(), baseOf, idle, baseReader(ROOT, same)))[0]!.fixed).toBe(false);
  });

  test("no inheritors, no base", async () => {
    expect(await basesOf([item(1, { inherited: undefined })], baseOf, idle, baseReader(ROOT, gh().io))).toEqual([]);
  });
});

describe("the sweep and an inherited red", () => {
  const answer = (fixed: boolean, tip = NEW) => async () => ({
    ok: true as const, enabled: true, items: [item(1), item(2)],
    bases: [{ base: "main", checks: ["django-tests"], sinceSha: OLD, tipSha: tip, fixed, inheritors: [1, 2], canSync: fixed ? [1, 2] : [] }],
  });

  test("an inherited red is never run again and spends nothing", async () => {
    on({ relaunch: { mode: "live", cap: 3 } });
    const rerun: number[] = [];
    const io: PolarisIo = { rerunJob: async (_r, id) => { rerun.push(id); return { ok: true }; }, readJobs: async () => null };
    const load = async () => ({ ok: true as const, enabled: true, items: [item(1, { dropped: [{ runId: 901, attempt: 1, pending: false, job: { id: 11, conclusion: "failure", stepConclusions: [null] } }] })] });
    expect(await sweep(ROOT, io, 1_000_000, load)).toBe(0);
    expect(rerun).toEqual([]);
  });

  test("one signal per base fix, not per pull request or per pass; a newer fix signals again", async () => {
    on({ lookAgain: { mode: "on", minutes: 5, steps: 1 } });
    const got: BaseFixed[] = [];
    onBaseFixed((s) => got.push(s));
    const io = gh().io;
    const t = 10_000_000;
    await sweep(ROOT, io, t, answer(true));
    await sweep(ROOT, io, t + 6 * 60_000, answer(true));
    await sweep(ROOT, io, t + 12 * 60_000, answer(true));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ base: "main", tipSha: NEW, canSync: [1, 2] });
    await sweep(ROOT, io, t + 18 * 60_000, answer(true, sha("e")));
    expect(got).toHaveLength(2);
    onBaseFixed(null);
  });

  test("no signal while the base is red, or when the signals door is off", async () => {
    const got: BaseFixed[] = [];
    onBaseFixed((s) => got.push(s));
    on({ lookAgain: { mode: "on", minutes: 5, steps: 1 } });
    await sweep(ROOT, gh().io, 10_000_000, answer(false));
    on({ signals: { mode: "off" }, lookAgain: { mode: "on", minutes: 5, steps: 1 } });
    await sweep(ROOT, gh().io, 20_000_000, answer(true));
    expect(got).toEqual([]);
    onBaseFixed(null);
  });
});

describe("sync", () => {
  const args = { root: ROOT, number: 7, headSha: HEAD, baseSha: NEW };
  function io() {
    const calls: [number, string][] = [];
    let reply: { ok: boolean; status?: number; error?: string } = { ok: true };
    const i: PolarisIo = { rerunJob: async () => ({ ok: true }), readJobs: async () => null, updateBranch: async (_r, n, h) => { calls.push([n, h]); return reply; } };
    return { i, calls, answer: (r: typeof reply) => { reply = r; } };
  }

  test("a dry run says what it would do and calls nothing", async () => {
    on();
    const { i, calls } = io();
    expect(await executeAction("sync", args, i)).toEqual({ ok: true, outcome: "skipped-in-dry-run" });
    expect(calls).toEqual([]);
  });

  test("live names the head the person saw, once per base fix, and writes one audit line", async () => {
    on({ relaunch: { mode: "live", cap: 3 } });
    const { i, calls } = io();
    expect(await executeAction("sync", args, i)).toMatchObject({ ok: true, outcome: "done" });
    expect(calls).toEqual([[7, HEAD]]);
    expect(await executeAction("sync", args, i)).toMatchObject({ ok: false, error: expect.stringContaining("already synced") });
    expect(calls).toHaveLength(1);
    expect(actionLog(5).find((r) => r.action === "/polaris/sync" && r.ok === 1)).toMatchObject({ target: "orbit #7", ok: 1, detail: expect.stringContaining("1111111") });
    // A later base fix is a new sync.
    expect(await executeAction("sync", { ...args, baseSha: sha("e") }, i)).toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);
  });

  test("without the head sha, or with the door off, or while Polaris is off, nothing is sent", async () => {
    const { i, calls } = io();
    expect(await executeAction("sync", args, i)).toMatchObject({ ok: false, error: "Polaris is off for this project" });
    on({ relaunch: { mode: "live", cap: 3 } });
    expect(await executeAction("sync", { root: ROOT, number: 7 }, i)).toMatchObject({ ok: false });
    expect(await executeAction("sync", { ...args, headSha: "abc" }, i)).toMatchObject({ ok: false });
    on({ relaunch: { mode: "off" } });
    expect(await executeAction("sync", args, i)).toMatchObject({ ok: false, error: expect.stringContaining("relaunch door is off") });
    expect(calls).toEqual([]);
  });

  test("after a sync a clean local copy is fast-forwarded and any other is left alone with a draft for its session", async () => {
    on({ relaunch: { mode: "live", cap: 3 } });
    const { i } = io();
    const seen: string[] = [];
    for (const state of ["fast-forwarded", "absent", "dirty", "diverged"] as const) {
      __resetPolaris();
      const n = state.length;
      await executeAction("sync", { ...args, number: n }, { ...i, localAfter: async () => ({ state, branch: "feat/retry" }) });
      const r = await polarisRoute("POST", `/polaris/items/${n}/beacon/edit`, new URLSearchParams(), { root: ROOT, reason: "synced", text: "x" }, true);
      seen.push(`${state}:${r!.status}`);
    }
    // 200: a draft exists for the reason "synced" (edit finds it); 409: none.
    expect(seen).toEqual(["fast-forwarded:409", "absent:409", "dirty:200", "diverged:200"]);
  });

  test("a 422 is needs-you, not retried, and the next sync of that head is allowed to say so again", async () => {
    on({ relaunch: { mode: "live", cap: 3 } });
    const { i, calls, answer } = io();
    answer({ ok: false, status: 422, error: "HTTP 422" });
    expect(await executeAction("sync", args, i)).toEqual({ ok: false, error: "conflict with base" });
    expect(__syncConflicted(ROOT, 7, HEAD)).toBe(true);
    expect(__syncConflicted(ROOT, 7, sha("2"))).toBe(false);
    expect(calls).toHaveLength(1);
    answer({ ok: false, status: 500, error: "boom" });
    expect(await executeAction("sync", { ...args, baseSha: sha("e") }, i)).toMatchObject({ ok: false, error: "boom" });
    expect(__syncConflicted(ROOT, 7, HEAD)).toBe(true);
  });

  test("the route: an agent is refused, the person's click reaches the action", async () => {
    on();
    const post = (person: boolean) => polarisRoute("POST", "/polaris/items/7/action", new URLSearchParams(), { root: ROOT, type: "sync", headSha: HEAD, baseSha: NEW }, person);
    expect(await post(false)).toMatchObject({ status: 403 });
    expect(await post(true)).toMatchObject({ status: 200, body: { ok: true, outcome: "skipped-in-dry-run" } });
  });
});
