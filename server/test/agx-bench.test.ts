/**
 * agx-bench, the parts that run without a browser: the fixture server's
 * routes and answers, the arithmetic, the harness's accounting, the report,
 * and the runner's options. The browser half is the benchmark itself.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVLOOP_BUGS,
  MEASURE_DELAYS,
  MEASURE_ITEMS,
  MEASURE_OUT_OF_STOCK,
  MEASURE_SLOWEST,
  SIGNUP_VALID,
  freshState,
  makeHandler,
  startFixtures,
} from "../../scripts/agx-bench/fixtures.ts";
import {
  median,
  percentile,
  summarizeArms,
  summarizeTasks,
  summarizeVerbs,
  tokensOf,
  type Run,
} from "../../scripts/agx-bench/metrics.ts";
import { afterOf, pick, runArm, Session, StepFailed, View, type Exec, type Task } from "../../scripts/agx-bench/bench.ts";
import { buildResults, toMarkdown } from "../../scripts/agx-bench/report.ts";
import { TASKS, checkupProblems } from "../../scripts/agx-bench/tasks.ts";
import { cliEnv, parseOptions } from "../../scripts/agx-bench/run.ts";

const O = "http://127.0.0.1:1";
const get = (h: ReturnType<typeof makeHandler>, path: string) => h(new Request(O + path));
const post = (h: ReturnType<typeof makeHandler>, path: string, body: unknown) =>
  h(new Request(O + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

describe("fixture routes", () => {
  test("every page a task opens is served as html", async () => {
    const h = makeHandler(freshState());
    for (const p of ["/", "/spa/", "/spa/items", "/spa/about", "/docs/1", "/docs/3", "/form", "/devloop", "/measure"]) {
      const r = await get(h, p);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
    }
    expect((await get(h, "/docs/4")).status).toBe(404);
    expect((await get(h, "/nope")).status).toBe(404);
  });

  test("the guide links forward until its last page, which has none", async () => {
    const h = makeHandler(freshState());
    expect(await (await get(h, "/docs/2")).text()).toContain('href="/docs/3"');
    expect(await (await get(h, "/docs/3")).text()).not.toContain("Next");
  });

  test("the signup is refused for a bad email and recorded when valid", async () => {
    const state = freshState();
    const h = makeHandler(state);
    const bad = await post(h, "/api/signup", { ...SIGNUP_VALID, email: "not-an-email" });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: string }).error).toMatch(/email/i);
    expect(state).toMatchObject({ rejected: 1, signups: [] });
    expect((await post(h, "/api/signup", { ...SIGNUP_VALID, terms: false })).status).toBe(422);
    const ok = await post(h, "/api/signup", SIGNUP_VALID);
    expect(ok.status).toBe(200);
    expect(state.signups).toEqual([SIGNUP_VALID]);
  });

  test("the dev-loop page is broken until the edit, then clean", async () => {
    const state = freshState();
    const h = makeHandler(state);
    expect((await get(h, "/api/widgets")).status).toBe(DEVLOOP_BUGS.failedRequest.status);
    const broken = await (await get(h, "/devloop")).text();
    expect(broken).toContain("cart.first.price");
    expect(broken).toContain(DEVLOOP_BUGS.visibleError);
    await post(h, "/__bench/state", { devloop: "fixed" });
    expect(state.devloop).toBe("fixed");
    expect((await get(h, "/api/widgets")).status).toBe(200);
    expect(await (await get(h, "/devloop")).text()).not.toContain("cart.first.price");
    // A value that is not a state is ignored, not stored.
    await post(h, "/__bench/state", { devloop: "half" });
    expect(state.devloop).toBe("fixed");
    await post(h, "/__bench/reset", {});
    expect(state).toEqual(freshState());
  });

  test("the report's requests are delayed by the table, the slowest well clear of the rest", async () => {
    const slept: number[] = [];
    const h = makeHandler(freshState(), async (ms) => void slept.push(ms));
    for (const k of Object.keys(MEASURE_DELAYS)) expect((await get(h, `/api/report/${k}`)).status).toBe(200);
    expect(slept).toEqual(Object.values(MEASURE_DELAYS));
    const others = Object.entries(MEASURE_DELAYS).filter(([k]) => k !== MEASURE_SLOWEST).map(([, v]) => v);
    expect(MEASURE_DELAYS[MEASURE_SLOWEST]).toBeGreaterThan(2 * Math.max(...others));
    expect((await get(h, "/api/report/unknown")).status).toBe(404);
  });

  test("the measurement page renders the rows the grader counts", async () => {
    const html = await (await get(makeHandler(freshState()), "/measure")).text();
    expect(html.match(/<li class="item/g)?.length).toBe(MEASURE_ITEMS);
    expect(html.split("out of stock").length - 1).toBe(MEASURE_OUT_OF_STOCK);
  });

  const live = startFixtures(0);
  afterAll(() => live.server.stop(true));
  test("the server listens on loopback and answers", async () => {
    expect(live.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const r = await fetch(live.origin + "/__bench/state");
    expect(await r.json()).toEqual(freshState());
  });
});

describe("metrics", () => {
  test("percentiles interpolate between closest ranks, as numpy does", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([4, 1, 3, 2], 95)).toBeCloseTo(3.85, 10);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([10, 20], 0)).toBe(10);
    expect(percentile([10, 20], 100)).toBe(20);
    expect(median([3, 1, 2])).toBe(2);
    expect(percentile([], 50)).toBeNaN();
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });

  test("tokens are bytes over 3.5, rounded", () => {
    expect(tokensOf(35)).toBe(10);
    expect(tokensOf(0)).toBe(0);
    expect(tokensOf(36)).toBe(10);
  });

  const run = (task: string, arm: string, ok: boolean, wallMs: number, tokens: number, verbMs: number[]): Run => ({
    task, family: "form", arm, rep: 1, ok, wallMs, steps: verbMs.length, bytes: tokens * 3.5, stdoutBytes: tokens * 3.5,
    tokens, edits: 0,
    calls: verbMs.map((ms) => ({ verb: "observe", argv: [], ms, exit: 0, stdoutBytes: 1, stderrBytes: 0 })),
  });

  test("tasks, verbs and arms are summarised by median and percentile", () => {
    const runs = [
      run("a", "baseline", true, 100, 10, [10, 20]),
      run("a", "baseline", false, 300, 30, [30]),
      run("a", "baseline", true, 200, 20, [40]),
      run("b", "baseline", true, 50, 5, [50]),
    ];
    const t = summarizeTasks(runs).find((s) => s.task === "a")!;
    expect(t).toMatchObject({ n: 3, successes: 2, medianWallMs: 200, medianTokens: 20 });
    const v = summarizeVerbs(runs);
    expect(v).toEqual([{ arm: "baseline", verb: "observe", n: 5, p50: 30, p95: 48 }]);
    const [a] = summarizeArms(runs);
    expect(a).toMatchObject({ arm: "baseline", runs: 4, successes: 3, wallMs: 250, tokens: 25 });
    expect(a.tokensPerSuccess).toBeCloseTo(65 / 3, 10);
  });
});

describe("the harness", () => {
  const control = { state: async () => freshState(), set: async () => {} };
  const fake = (out: Record<string, { exit?: number; stdout?: string; stderr?: string }>): Exec =>
    async (argv) => {
      // The verb is whichever argument names a canned answer; the rest are
      // flags and operands.
      const verb = argv.find((a) => a in out) ?? "";
      return { exit: out[verb]?.exit ?? 0, stdout: out[verb]?.stdout ?? "", stderr: out[verb]?.stderr ?? "" };
    };

  test("a call is counted in bytes as printed, verb and flags recorded, JSON parsed", async () => {
    let t = 0;
    const s = new Session(fake({ observe: { stdout: '{"title":"Café"}', stderr: "ñ" } }), ["--as", "x"], O, control, () => (t += 5));
    const r = await s.cli("observe", ["--shot"]);
    expect(r.json).toEqual({ title: "Café" });
    expect(s.calls).toEqual([
      { verb: "observe", argv: ["--as", "x", "observe", "--shot"], ms: 5, exit: 0, stdoutBytes: 17, stderrBytes: 2 },
    ]);
  });

  test("a failed step fails the arm unless the arm says it may fail", async () => {
    const s = new Session(fake({ click: { exit: 1, stderr: "nothing matched" } }), [], O, control);
    await expect(s.cli("click", ["e9"])).rejects.toThrow(/click e9 exited 1: nothing matched/);
    const r = await s.cli("click", ["e9"], { allowFail: true });
    expect(r.exit).toBe(1);
    expect(s.calls.length).toBe(2);
  });

  test("pick refuses zero or two matches rather than guessing", () => {
    const tree = [
      { e: "e1", role: "a", name: "Next" },
      { e: "e2", role: "a", name: "Next" },
      { e: "e3", role: "button", name: "Go" },
    ];
    expect(pick(tree, "button", "Go").e).toBe("e3");
    expect(() => pick(tree, "a", "Next")).toThrow(StepFailed);
    expect(() => pick(tree, "a", /^Prev/)).toThrow(/found 0/);
  });

  const task = (arm: Task["arms"][string], grade: Task["grade"] = () => null): Task =>
    ({ id: "t", family: "form", title: "t", arms: { baseline: arm }, grade });

  test("runArm grades the answer, and turns a throw or a timeout into a failure with its reason", async () => {
    const mk = () => new Session(fake({ observe: { stdout: "abcdefg" } }), [], O, control);
    const good = await runArm(task(async (s) => (await s.cli("observe")).stdout), "baseline", 1, mk());
    expect(good).toMatchObject({ ok: true, steps: 1, bytes: 7, tokens: 2 });
    const wrong = await runArm(task(async () => 1, (a) => (a === 2 ? null : `got ${a}`)), "baseline", 1, mk());
    expect(wrong).toMatchObject({ ok: false, error: "got 1" });
    const threw = await runArm(task(async () => { throw new Error("no tree"); }), "baseline", 1, mk());
    expect(threw).toMatchObject({ ok: false, error: "no tree" });
    const slow = await runArm(task(() => new Promise(() => {})), "baseline", 1, mk(), 20);
    expect(slow).toMatchObject({ ok: false, error: "timed out after 20 ms" });
    await expect(runArm(task(async () => 0), "phase1", 1, mk())).rejects.toThrow(/no arm phase1/);
  });

  test("an edit to the fixture is counted apart from browser steps", async () => {
    const seen: unknown[] = [];
    const s = new Session(fake({}), [], O, { state: async () => freshState(), set: async (p) => void seen.push(p) });
    const r = await runArm(task(async (x) => { await x.edit({ devloop: "fixed" }); }), "baseline", 1, s);
    expect(r).toMatchObject({ edits: 1, steps: 0 });
    expect(seen).toEqual([{ devloop: "fixed" }]);
  });
});

describe("the task set", () => {
  test("every task has a unique id and a baseline arm", () => {
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
    for (const t of TASKS) expect(typeof t.arms.baseline).toBe("function");
    expect(new Set(TASKS.map((t) => t.family))).toEqual(new Set(["navigation", "form", "devloop", "measure", "phase2"]));
  });

  const byId = (id: string) => TASKS.find((t) => t.id === id)!;
  const clean = { consoleErrors: [], failedRequests: [], visibleErrors: [] };
  const seen = {
    consoleErrors: [`Uncaught ${DEVLOOP_BUGS.consoleError}`],
    failedRequests: [{ path: "/api/widgets", status: 500 }],
    visibleErrors: [`${DEVLOOP_BUGS.visibleError} (HTTP 500)`],
  };
  const fixed = { ...freshState(), devloop: "fixed" as const };

  test("the dev loop passes only with all three bugs reported, the fix applied, and a clean page after", () => {
    const g = byId("devloop-load").grade;
    expect(g({ before: seen, after: clean }, fixed)).toBeNull();
    expect(g({ before: { ...seen, consoleErrors: [], failedRequests: [] }, after: clean }, fixed))
      .toBe("missed the console error, the failed request");
    expect(g({ before: seen, after: clean }, freshState())).toBe("never applied the fix");
    expect(g({ before: seen, after: seen }, fixed)).toMatch(/still saw 3 problem/);
    expect(g(undefined, fixed)).toBe("no answer");
  });

  test("the form passes only when the server recorded exactly the valid signup", () => {
    const g = byId("form-signup").grade;
    const answer = { error: "Email must look like name@domain", welcome: `Welcome, ${SIGNUP_VALID.name}!` };
    expect(g(answer, { ...freshState(), rejected: 1, signups: [SIGNUP_VALID] })).toBeNull();
    expect(g(answer, { ...freshState(), rejected: 0, signups: [SIGNUP_VALID] })).toMatch(/never reached/);
    expect(g(answer, { ...freshState(), rejected: 1, signups: [] })).toMatch(/0 signups/);
    expect(g({ ...answer, error: undefined }, { ...freshState(), rejected: 1, signups: [SIGNUP_VALID] })).toMatch(/validation error/);
  });

  test("the measurement is graded against the delays the server applied", () => {
    const g = byId("measure-report").grade;
    const n = Object.keys(MEASURE_DELAYS).length;
    expect(g({ slowest: MEASURE_SLOWEST, requests: n, outOfStock: MEASURE_OUT_OF_STOCK }, freshState())).toBeNull();
    expect(g({ slowest: "orders", requests: n, outOfStock: MEASURE_OUT_OF_STOCK }, freshState())).toMatch(/slowest/);
    expect(g({ slowest: MEASURE_SLOWEST, requests: 0, outOfStock: MEASURE_OUT_OF_STOCK }, freshState())).toMatch(/saw 0/);
  });
});

describe("reading deltas (the phase1 arm)", () => {
  test("a View applies a full answer, then a delta: removed, changed (null deletes), added", () => {
    const v = new View().apply({
      url: "http://x/a", title: "A", console: [{ level: "log" }],
      tree: [{ e: "e1", role: "h1", name: "Home" }, { e: "e2", role: "button", name: "Save", disabled: true }],
    });
    v.apply({
      delta: true, url: "http://x/b", title: "B", console: [], network: [],
      removed: ["e1"], changed: [{ e: "e2", disabled: null, name: "Saved" }], added: [{ e: "e7", role: "h1", name: "Items" }], same: 0,
    });
    expect(v.tree).toEqual([{ e: "e2", role: "button", name: "Saved" }, { e: "e7", role: "h1", name: "Items" }]);
    expect([v.url, v.title, v.console.length, v.fulls, v.deltas]).toEqual(["http://x/b", "B", 0, 1, 1]);
    // A full answer after a navigation replaces the tree, it is not merged.
    v.apply({ delta: false, reason: "new document", url: "http://x/c", tree: [{ e: "e1", role: "h1", name: "C" }] });
    expect(v.tree).toEqual([{ e: "e1", role: "h1", name: "C" }]);
    expect(() => new View().apply({ url: "u" })).toThrow(StepFailed);
  });

  test("afterOf takes `after`, and a failed look after a good action fails the step", () => {
    const r = (json: unknown) => ({ exit: 0, stdout: JSON.stringify(json), stderr: "", json, ms: 1 });
    expect(afterOf(r({ clicked: "e1", after: { delta: true } }))).toEqual({ delta: true });
    expect(() => afterOf(r({ clicked: "e1", afterFailed: "timed out" }))).toThrow(StepFailed);
    expect(() => afterOf(r({ clicked: "e1" }))).toThrow(StepFailed);
  });

  test("the form's phase1 arm fills by locator and reads the error and the welcome from its two looks", async () => {
    /* A stand-in CLI answering the way the real one does on this fixture:
       the first look is the submit's (full: nothing to diff against), then a
       delta — the alert turns into a status. */
    const tree = [
      { e: "e1", role: "h1", name: "Sign up" }, { e: "e2", role: "input", name: "Full name" },
      { e: "e3", role: "input", name: "Email" }, { e: "e4", role: "select", name: "Plan", id: "plan" },
      { e: "e5", role: "input", name: "I accept the terms" }, { e: "e6", role: "button", name: "Create account" },
    ];
    let clicks = 0;
    const exec: Exec = async (argv) => {
      const verb = argv[0];
      const out = verb === "open" ? { url: "u" }
        : verb === "click" && clicks++ === 0 ? { clicked: "e6", after: { delta: false, reason: "no earlier observe to compare with", url: "u", title: "Sign up", tree: [...tree, { e: "e9", role: "alert", name: "Enter a valid email address" }] } }
        : verb === "click" ? { clicked: "e6", after: { delta: true, added: [], removed: [], changed: [{ e: "e9", role: "status", name: `Welcome, ${SIGNUP_VALID.name}!` }], same: 6 } }
        : {};
      return { exit: 0, stdout: JSON.stringify(out), stderr: "" };
    };
    const s = new Session(exec, [], "http://127.0.0.1:1", { state: async () => freshState(), set: async () => {} });
    const a = (await TASKS.find((t) => t.id === "form-signup")!.arms.phase1!(s)) as { error: string; welcome: string };
    expect(a.error).toContain("valid email");
    expect(a.welcome).toContain(SIGNUP_VALID.name);
    // No separate look: every observation came back on an act verb.
    expect(s.calls.map((c) => c.verb)).not.toContain("observe");
    // And no look before the first act: every target is named, not an id
    // or a CSS selector read off a tree.
    expect(s.calls.find((c) => c.verb === "open")!.argv).not.toContain("--observe");
    const targets = s.calls.filter((c) => c.verb !== "open").map((c) => c.argv[c.argv.indexOf(c.verb) + 1]);
    expect(targets.every((t) => /^(label|role)=/.test(t!))).toBe(true);
  });

  test("a checkup answer reads back as the grader's three lists", () => {
    const p = checkupProblems({
      verdict: "3 problems",
      errors: ["TypeError: Cannot read properties of undefined (reading 'price') @ /devloop:11"],
      failed: ["500 GET http://127.0.0.1:1/api/widgets?x=1", "failed GET http://127.0.0.1:1/a.js: net::ERR_BLOCKED_BY_CLIENT"],
      visible: ["Could not load widgets (HTTP 500)"],
    });
    expect(p.failedRequests[0]).toEqual({ path: "/api/widgets", status: 500 });
    expect(p.failedRequests[1]!.status).toBe(0);
    expect(p.consoleErrors).toHaveLength(1);
    expect(checkupProblems({ verdict: "ok" })).toEqual({ consoleErrors: [], failedRequests: [], visibleErrors: [] });
    expect(checkupProblems(undefined).consoleErrors).toEqual([]);
  });

  test("devloop-load's phase1 arm is two checkups, and the grader passes on their answers", async () => {
    const state = freshState();
    const broken = {
      verdict: "3 problems", url: "u", title: "Widgets",
      errors: [`${DEVLOOP_BUGS.consoleError} @ /devloop:11`],
      failed: [`${DEVLOOP_BUGS.failedRequest.status} GET http://127.0.0.1:1${DEVLOOP_BUGS.failedRequest.path}`],
      visible: [`${DEVLOOP_BUGS.visibleError} (HTTP 500)`],
    };
    const exec: Exec = async (argv) => ({
      exit: 0, stderr: "",
      stdout: JSON.stringify(argv[0] === "checkup" && state.devloop !== "fixed" ? broken : { verdict: "ok", url: "u", title: "Widgets" }),
    });
    const s = new Session(exec, [], "http://127.0.0.1:1", { state: async () => state, set: async (p) => void Object.assign(state, p) });
    const task = TASKS.find((t) => t.id === "devloop-load")!;
    const a = await task.arms.phase1!(s);
    expect(task.grade(a, state)).toBeNull();
    expect(s.calls.map((c) => c.verb)).toEqual(["checkup", "checkup"]);
    expect(s.calls[1]!.argv).toContain("--reload");
  });

  test("phase1 covers at least the tasks a delta or a folded look applies to", () => {
    // At least: later phase-1 items add their tasks to the same arm.
    const withPhase1 = TASKS.filter((t) => t.arms.phase1).map((t) => t.id);
    expect(withPhase1).toEqual(expect.arrayContaining(["devloop-click", "devloop-load", "form-signup", "measure-report", "nav-links", "nav-spa"]));
  });
});

describe("report and runner options", () => {
  test("the markdown names the estimator, renders a missing number as a dash, and lists failures", () => {
    const runs: Run[] = [
      { task: "nav-spa", family: "navigation", arm: "baseline", rep: 1, ok: false, error: "ended at /", wallMs: 1234.4,
        steps: 3, bytes: 700, stdoutBytes: 690, tokens: 200, edits: 0, calls: [] },
    ];
    const md = toMarkdown(buildResults({ startedAt: "2026-01-01T00:00:00Z", commit: "abc1234", reps: 1, arms: ["baseline"], server: O, host: "linux-x64", load: [1.25, 2] }, runs));
    expect(md).toContain("tokens ≈ bytes / 3.5 — load 1.3 → 2.0");
    expect(md).toContain("| nav-spa | navigation | baseline | 0/1 | 1234 | 3 | 700 | 200 |");
    expect(md).toContain("| baseline | 0/1 | 1234 | 3 | 700 | 200 | — |");
    expect(md).toContain("- nav-spa / baseline / rep 1: ended at /");
  });

  const dir = mkdtempSync(join(tmpdir(), "agx-bench-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("an instance directory supplies the server, the token and the CLI's private caches", () => {
    mkdirSync(join(dir, "cfg", "agentglass"), { recursive: true });
    writeFileSync(join(dir, "port"), "4999\n");
    writeFileSync(join(dir, "cfg", "agentglass", "token"), "tok-example\n");
    const o = parseOptions(["--instance", dir, "--reps", "2", "--task", "nav-spa,form-signup", "--out", join(dir, "out")]);
    expect(o).toMatchObject({ server: "http://127.0.0.1:4999", token: "tok-example", reps: 2, arms: ["baseline"], tasks: ["nav-spa", "form-signup"] });
    const env = cliEnv(o, { PATH: "/usr/bin", TMUX: "/tmp/tmux-1/default,1,0", AGENTGLASS_TOKEN: "other" });
    expect(env).toEqual({
      PATH: "/usr/bin",
      AGENTGLASS_SERVER: "http://127.0.0.1:4999",
      AGENTGLASS_TOKEN: "tok-example",
      XDG_CONFIG_HOME: join(dir, "cfg"),
      XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_BROWSER_STATE_DIR: join(dir, "browser"),
    });
  });

  test("a task, an arm or a rep count that does not exist is refused", () => {
    const base = ["--server", O, "--out", join(dir, "out")];
    expect(() => parseOptions([...base, "--task", "nav-nowhere"])).toThrow(/no task nav-nowhere/);
    expect(() => parseOptions([...base, "--arm", "phase9"])).toThrow(/no task has an arm phase9/);
    expect(() => parseOptions([...base, "--reps", "0"])).toThrow(/positive integer/);
    expect(() => parseOptions(["--out", join(dir, "out")])).toThrow(/--instance DIR/);
  });
});

describe("phase-2 fixtures and graders", () => {
  test("a page is served in full every time, not only the first (a Response body reads once)", async () => {
    const h = makeHandler(freshState());
    for (const p of ["/confirm", "/marks", "/slot/3"]) {
      const first = await (await get(h, p)).text();
      expect(first.length).toBeGreaterThan(100);
      expect(await (await get(h, p)).text()).toBe(first);
    }
  });

  test("a beacon is counted by name, and a reset forgets it", async () => {
    const state = freshState();
    const h = makeHandler(state);
    await h(new Request(`${O}/__bench/beacon?name=deleted`, { method: "POST" }));
    expect(state.beacons).toEqual({ deleted: 1 });
    await post(h, "/__bench/reset", {});
    expect(state.beacons).toEqual({});
  });

  const task = (id: string) => TASKS.find((t) => t.id === id)!;

  test("dialog-cancel: the server's count of deletes decides, not what the arm says", () => {
    const g = task("p2-dialog-cancel").grade;
    expect(g({ status: "Report kept" }, { ...freshState(), beacons: {} })).toBeNull();
    expect(g({ status: "Report kept" }, { ...freshState(), beacons: { deleted: 1 } })).toContain("went through");
    expect(g({ status: "Report deleted" }, freshState())).toContain("status was");
  });

  test("shot-marks: the labels must be the tree's ids, exactly, and the fixture's four", () => {
    const g = task("p2-shot-marks").grade;
    const ids = ["e2", "e3", "e4", "e5"];
    expect(g({ ids, marks: ids }, freshState())).toBeNull();
    expect(g({ ids, marks: [...ids, "e1"] }, freshState())).toContain("the picture says");
    expect(g({ ids, marks: [] }, freshState())).toContain("nothing labelled");
    expect(g({ ids: ids.slice(1), marks: ids.slice(1) }, freshState())).toContain("usable controls");
    expect(g({ ids, marks: ids, pictureMarks: ["e9"] }, freshState())).toContain("real shot");
  });

  test("wait-slot: a tab that arrived without waiting proves nothing", () => {
    const g = task("p2-wait-slot").grade;
    expect(g({ gotTab: true, waitedMs: 2600 }, freshState())).toBeNull();
    expect(g({ gotTab: true, waitedMs: 300 }, freshState())).toContain("without waiting");
    expect(g({ gotTab: false, refusedBy: "12 pages awake at once" }, freshState())).toContain("no tab");
  });

  test("real-input: activation, the clipboard, :hover and the editor's text are all required", () => {
    const g = task("p2-real-input").grade;
    const ok = { click: { active: true, clipboard: "ok" }, hover: { hover: true }, text: "bye" };
    expect(g(ok, freshState())).toBeNull();
    expect(g({ ...ok, click: { active: false, clipboard: "NotAllowedError" } }, freshState())).toContain("user activation");
    expect(g({ ...ok, hover: { hover: false } }, freshState())).toContain(":hover");
    expect(g({ ...ok, text: "" }, freshState())).toContain("editor text");
  });

  test("handoff: the server must have seen the gate passed, and the handoff end for a reason", () => {
    const g = task("p2-handoff").grade;
    const passed = { ...freshState(), beacons: { "gate-passed": 1 } };
    expect(g({ state: "condition" }, passed)).toBeNull();
    expect(g({ state: "done" }, passed)).toBeNull();
    expect(g({ state: "stuck" }, freshState())).toContain("never passed");
    expect(g({ state: "waiting" }, passed)).toContain("ended as");
  });

  test("audit: every seeded fault is named, and an unpainted page may not be called good", () => {
    const g = task("p2-audit").grade;
    const a11y = { unlabelled: { n: 1 }, imgNoAlt: { n: 1 }, headingSkips: { n: 1 }, noLang: true };
    expect(g({ a11y, vitals: { verdict: "unmeasured: this page has not painted", vitals: {} } }, freshState())).toBeNull();
    expect(g({ a11y, vitals: { verdict: "good", vitals: { cls: { value: 0 } } } }, freshState())).toContain("honest verdict");
    expect(g({ a11y: { imgNoAlt: 1 }, vitals: null }, freshState())).toContain("heading jump");
  });

  test("clean-html: no scripts or styles, an id on the button, and smaller than the raw markup", () => {
    const g = task("p2-clean-html").grade;
    const html = '<body><button data-agx-e="e1">Go</button></body>';
    expect(g({ html, rawLength: 900 }, freshState())).toBeNull();
    expect(g({ html: html + "<script>x</script>", rawLength: 900 }, freshState())).toContain("still in the markup");
    expect(g({ html: "<body><button>Go</button></body>", rawLength: 900 }, freshState())).toContain("no observe id");
    expect(g({ html, rawLength: html.length }, freshState())).toContain("not smaller");
  });

  test("mcp-core: a failed call is the answer, and the heading is what grades it", () => {
    const g = task("p2-mcp-core").grade;
    expect(g({ heading: "Items", listBytes: 1 }, freshState())).toBeNull();
    expect(g({ error: "a call failed: x" }, freshState())).toBe("a call failed: x");
    expect(g({ heading: "Home" }, freshState())).toContain("ended on");
  });
});
