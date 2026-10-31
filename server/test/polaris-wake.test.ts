/*
 * The rest of the sweep: it wakes on pull request events and keeps the gap, a global-only
 * enable is swept, `steps` caps a pass, the beacon finds its session by branch, and the
 * facts carry what the board already knows about required checks.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESETS, type DoorValue } from "../../shared/polaris.ts";
import { polarisRoots, writePolaris } from "../src/config.ts";
import { __resetPolaris, executeAction, factsOf, sweep, wakeForRepo, type PolarisIo, type RunRef } from "../src/polaris.ts";
import { polarisRoute } from "../src/polarisRoutes.ts";
import type { PrSummary } from "../../shared/types.ts";

const SRC = await Bun.file(new URL("../src/polaris.ts", import.meta.url)).text();
const saved = { home: process.env.XDG_CONFIG_HOME, root: process.env.AGENTGLASS_ROOT };
const dirs: string[] = [];
const ROOT = "/work/acme/orbit";
const OTHER = "/work/acme/relay";
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "agx-polaris-wake-"));
  dirs.push(dir);
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.AGENTGLASS_ROOT;
  __resetPolaris();
});
afterAll(() => {
  for (const [k, v] of [["XDG_CONFIG_HOME", saved.home], ["AGENTGLASS_ROOT", saved.root]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const guided = () => structuredClone(PRESETS.guided.doors);
const on = (over: Record<string, DoorValue> = {}, root = ROOT) => writePolaris(root, { enabled: true, preset: "custom", doors: { ...guided(), ...over } });
const run = (n: number): RunRef => ({ runId: 900 + n, attempt: 1, pending: false, job: { id: 10 + n, conclusion: "failure", stepConclusions: [null] } });
function io(extra: Partial<PolarisIo> = {}) {
  const calls: number[] = [];
  const i: PolarisIo = { rerunJob: async (_r, id) => { calls.push(id); return { ok: true }; }, readJobs: async () => null, ...extra };
  return { i, calls };
}

describe("waking on a pull request event", () => {
  test("only the projects of that repository are swept", async () => {
    const swept: string[] = [];
    const d = {
      roots: () => [ROOT, OTHER],
      repoOf: async (r: string) => ({ nameWithOwner: r === ROOT ? "acme/orbit" : "acme/relay" }),
      sweep: async (r: string) => { swept.push(r); return 1; },
    };
    expect(await wakeForRepo("acme/orbit", d)).toBe(1);
    expect(swept).toEqual([ROOT]);
    expect(await wakeForRepo("acme/none", d)).toBe(0);
  });

  test("an event inside lookAgain.minutes is dropped, one after it is read", async () => {
    on({ relaunch: { mode: "live", cap: 3 }, lookAgain: { mode: "on", minutes: 5, steps: 1 } });
    let loads = 0;
    const load = (async () => { loads++; return { ok: true, enabled: true, items: [] }; }) as never;
    const t0 = 20_000_000;
    await sweep(ROOT, io().i, t0, load);
    await sweep(ROOT, io().i, t0 + 4 * 60_000, load);
    expect(loads).toBe(1);
    await sweep(ROOT, io().i, t0 + 5 * 60_000, load);
    expect(loads).toBe(2);
  });

  test("the events are wired where the app already hears them", async () => {
    const index = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    expect(index).toMatch(/subscribeCi\(\(v\) => void polarisWake\(v\.repo\)/);
    expect(index).toMatch(/void polarisWake\(ev\.repo\)/);
    // After the sweep, open windows are told to re-read, but only while Polaris is on somewhere.
    const fn = index.slice(index.indexOf("async function polarisWake("), index.indexOf("onPrChanged((ev)"));
    expect(fn).toMatch(/await wakeForRepo\(repo\)/);
    expect(fn).toMatch(/if \(polarisRoots\(\)\.length\) broadcast\(\{ type: "polaris" \}\)/);
  });
});

describe("which projects the sweep covers", () => {
  test("a global-only enable sweeps the open projects; off does not", () => {
    process.env.AGENTGLASS_ROOT = "/work/acme/orbit";
    expect(polarisRoots()).toEqual([]);
    writePolaris(undefined, { enabled: true });
    expect(polarisRoots()).toEqual(["/work/acme/orbit"]);
    on({}, "/work/acme/relay");
    expect(polarisRoots().sort()).toEqual(["/work/acme/orbit", "/work/acme/relay"]);
    writePolaris(undefined, { enabled: false });
    expect(polarisRoots()).toEqual(["/work/acme/relay"]);
  });
});

describe("steps", () => {
  const items = () => ({ ok: true, enabled: true, items: [{ reason: "runner", number: 7, dropped: [run(1), run(2), run(3)] }] });
  test("a pass does at most `steps` relaunches and the rest wait for the next pass", async () => {
    on({ relaunch: { mode: "live", cap: 3 }, lookAgain: { mode: "on", minutes: 5, steps: 2 } });
    const { i, calls } = io();
    const load = (async () => items()) as never;
    expect(await sweep(ROOT, i, 30_000_000, load)).toBe(2);
    expect(calls).toEqual([11, 12]);
    expect(await sweep(ROOT, i, 30_000_000 + 6 * 60_000, load)).toBe(1);
    expect(calls).toEqual([11, 12, 13]);
  });
});

describe("the beacon finds its session", () => {
  const draft = { root: ROOT, number: 7, reason: "conflict", text: "Merge conflict with main." };
  async function send(match: "ask" | "use", over: Partial<typeof draft & { paneId: string }> = {}, found: string | null = "%9") {
    on({ beacon: { mode: "draft" }, match: { mode: match } });
    const asked: [string, number][] = [];
    const { i } = io({ sessionFor: async (r, n) => { asked.push([r, n]); return found; } });
    await executeAction("beacon-draft", draft, i);
    const r = await executeAction("beacon-send-on-click", { ...draft, ...over }, i);
    return { r, asked };
  }
  test("use: with nothing picked the matched session is the one tried", async () => {
    const { r, asked } = await send("use");
    expect(asked).toEqual([[ROOT, 7]]);
    // the fake pane has no screen, so the refusal is about idleness: the pane was resolved
    expect(r).toMatchObject({ ok: false, error: "that session is not idle" });
  });
  test("use: no single match asks the person to pick", async () => {
    expect((await send("use", {}, null)).r).toMatchObject({ ok: false, error: expect.stringContaining("pick the session") });
  });
  test("a picked session wins over the match, and ask never matches", async () => {
    const picked = await send("use", { paneId: "%3" });
    expect(picked.asked).toEqual([]);
    expect(picked.r).toMatchObject({ error: "that session is not idle" });
    const ask = await send("ask");
    expect(ask.asked).toEqual([]);
    expect(ask.r).toMatchObject({ ok: false, error: "beacon-send-on-click: pick the session" });
  });
  test("the match is by branch, and two sessions on one branch is no match", () => {
    const fn = SRC.slice(SRC.indexOf("export async function sessionFor("), SRC.indexOf("const liveIo"));
    expect(fn).toMatch(/x\.branch === b\.head/);
    expect(fn).toMatch(/hits\.length === 1/);
  });
});

describe("facts the board already has", () => {
  const row = { number: 7, title: "ORBIT-1042 add thing", author: "ada", state: "OPEN", isDraft: false, labels: [], baseRefName: "main", mergeable: "MERGEABLE", checks: { failing: [], pending: 0 }, checksLoaded: true } as unknown as PrSummary;
  const doors = () => ({ ...guided() }) as never;
  test("the base's required checks travel as requiredNames; none known is none", () => {
    expect(factsOf(row, doors(), ["build", "lint"]).requiredNames).toEqual(["build", "lint"]);
    expect(factsOf(row, doors()).requiredNames).toEqual([]);
  });
  test("the items read the base's required checks from the board's own cache, never asking", () => {
    const fn = SRC.slice(SRC.indexOf("export async function polarisItems("), SRC.indexOf("/** At most one relaunch"));
    expect(fn).toMatch(/__requiredCaches\.ctx\.get\(`\$\{repo\.key\}\\u0000\$\{p\.baseRefName\}`\)/);
    expect(fn).toMatch(/factsOf\(p, d, required\)/);
    expect(fn).not.toMatch(/scheduleRequiredCheck/);
  });
  test("a cold list is waited for, so the first read is not drawn as no pull requests", () => {
    const fn = SRC.slice(SRC.indexOf("export async function polarisItems("), SRC.indexOf("/** At most one relaunch"));
    expect(fn).toMatch(/list\.loading && !list\.prs\.length && !list\.fetchedAt/);
    expect(fn).toMatch(/waited < 8000/);
  });
  test("what the list does not carry stays at its safe default", () => {
    const f = factsOf(row, doors());
    expect(f.changedFiles).toEqual([]);
    expect(f.mergeStateStatus).toBeUndefined();
  });
});

describe("the preset is read from the settings route only", () => {
  test("GET /polaris/settings names the preset and its layer", async () => {
    writePolaris(ROOT, { enabled: true, preset: "guided", doors: guided() });
    const r = await polarisRoute("GET", "/polaris/settings", new URLSearchParams({ root: ROOT }), {}, false);
    expect(r?.body).toMatchObject({ ok: true, preset: "guided", presetLayer: "project", enabledLayer: "project" });
  });
});
