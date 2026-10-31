/*
 * Who flies a flight plan. The coordinator may say Go alone only in Autopilot,
 * not held, with no stop rule firing; every refusal says why; the second looks,
 * the S skip and the budget keep a review from spending without a limit; and a
 * launched builder carries a deny list in its argv. The routes run on a booted
 * server with a real chair (fixtures/workerHarness.ts), the rules on the
 * modules directly.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentVerdict, refusalWhy } from "../../shared/settingClass.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { MACHINE, startHarness, type Harness } from "./fixtures/workerHarness.ts";

const REAL_XDG = process.env.XDG_CONFIG_HOME;
const HOME = mkdtempSync(join(tmpdir(), "agx-pilot-"));
process.env.XDG_CONFIG_HOME = HOME;
mkdirSync(join(HOME, "agentglass"), { recursive: true });

const Flight = await import("../src/flightPlan.ts");
const Plans = await import("../src/flightPlanStore.ts");
const Store = await import("../src/preflightStore.ts");
const Budget = await import("../src/flightBudget.ts");
const { db } = await import("../src/db.ts");
const { launchPerm, launchFlags } = await import("../src/launchperm.ts");

const ROOT = "/work/orbit";
const APP = Store.APP;
const plan = (over: Partial<Parameters<typeof Plans.createPlan>[0]> = {}, md = "# Plan\nChange the footer.") => {
  const p = Plans.createPlan({ root: ROOT, title: "Footer", request: "r", visual: false, ...over });
  Plans.patchPlan(p.id, { planMd: md });
  return Plans.getPlan(p.id)!;
};
const cert = (findings: object[], costUsd = 0) => ({ id: "x", createdAt: 0, model: "m", costUsd, capUsd: 1, files: [], mockups: [], skipped: [], read: [], findings }) as never;
const finding = (id: string, severity: string, action: string | null = null) => ({ id, severity, title: "t", quote: "", evidence: "", action, note: null });
const withRun = (p: { id: string; root: string }, findings: object[], costUsd = 0) => {
  const run = Store.createRun({ root: p.root, moment: "before-launch", state: "running", by: "t", input: { files: [], mockups: [], root: p.root, model: "sonnet", budgetUsd: 1 } as never });
  Store.finish(run.id, cert(findings, costUsd));
  Plans.setPreflightRun(p.id, run.id);
  return run;
};

afterEach(() => {
  db.run(`DELETE FROM flight_plan`); db.run(`DELETE FROM preflight_run`); db.run(`DELETE FROM flight_plan_setting`);
  Budget.forgetBudget();
});
afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  if (REAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = REAL_XDG;
});

describe("the pilot and the hold", () => {
  test("a project flies in Co-pilot until somebody says otherwise; its own value wins over the app's", () => {
    expect(Flight.pilotOf(ROOT)).toBe("copilot");
    Store.putSetting(APP, "flightPlan.pilot", "manual");
    expect(Flight.pilotOf(ROOT)).toBe("manual");
    Store.putSetting(ROOT, "flightPlan.pilot", "autopilot");
    expect(Flight.pilotOf(ROOT)).toBe("autopilot");
    expect(Flight.pilotOf("/work/other")).toBe("manual");
  });

  test("a hold is the project's own: it never reaches another project through the app row", () => {
    Store.putSetting(APP, "flightPlan.held", true);
    expect(Flight.isHeld(ROOT)).toBe(false);
    Store.putSetting(ROOT, "flightPlan.held", true);
    expect(Flight.isHeld(ROOT)).toBe(true);
    expect(Flight.isHeld("/work/other")).toBe(false);
  });

  test("an old project's three moments read as the new list: off is not reviewed, ask and auto are", () => {
    expect(Store.getSetting(ROOT, "flightPlan.preflight.reviews")).toEqual(["plan"]);
    const put = (root: string, key: string, v: string) => db.query(`INSERT INTO flight_plan_setting (root, key, value) VALUES (?, ?, ?)`).run(root, key, JSON.stringify(v));
    put(ROOT, "flightPlan.preflight.beforeLaunch", "off");
    put(ROOT, "flightPlan.preflight.onTaskDone", "ask");
    put(ROOT, "flightPlan.preflight.onPr", "auto");
    expect(Store.getSetting(ROOT, "flightPlan.preflight.reviews")).toEqual(["taskDone", "pr"]);
    expect(Store.hasSetting(ROOT, "flightPlan.preflight.reviews")).toBe(true);
    Store.putSetting(ROOT, "flightPlan.preflight.reviews", ["plan"]);
    expect(Store.getSetting(ROOT, "flightPlan.preflight.reviews")).toEqual(["plan"]);
  });
});

describe("seatMayFly: Go for a coordinator", () => {
  const fly = (p: ReturnType<typeof plan>) => Flight.seatMayFly(p);

  test("refused in Manual and Co-pilot with the pilot named; allowed in Autopilot with nothing in the way", () => {
    const p = plan();
    expect(fly(p)).toEqual({ ok: false, error: "this project flies in Co-pilot: Go is the person's" });
    Store.putSetting(ROOT, "flightPlan.pilot", "manual");
    expect(fly(p)).toEqual({ ok: false, error: "this project flies in Manual: Go is the person's" });
    Store.putSetting(ROOT, "flightPlan.pilot", "autopilot");
    expect(fly(p)).toEqual({ ok: true });
  });

  test("held refuses it, and resuming (false) lets it through again", () => {
    const p = plan();
    Store.putSetting(ROOT, "flightPlan.pilot", "autopilot");
    Store.putSetting(ROOT, "flightPlan.held", true);
    expect(fly(p)).toEqual({ ok: false, error: "this project is held: no new Go until the person resumes it" });
    Store.putSetting(ROOT, "flightPlan.held", false);
    expect(fly(p).ok).toBe(true);
  });

  test("the two ask rules are per project: one project off still stops while another keeps asking, and the app value is the fallback", () => {
    const OTHER = "/work/acme";
    const risky = (root: string) => plan({ root, size: "L" }, "# Plan\nTouch `server/src/auth/token.ts`.");
    const a = risky(ROOT), b = risky(OTHER);
    expect(Flight.stopReason(a)).toBe("large");
    Store.putSetting(ROOT, "flightPlan.autopilot.askOnLarge", false);
    expect(Flight.stopReason(a)).toBe("sensitive");
    Store.putSetting(ROOT, "flightPlan.autopilot.askOnSensitive", false);
    expect(Flight.stopReason(a)).toBeNull();
    expect(Flight.stopReason(b)).toBe("large");
    Store.putSetting(OTHER, "flightPlan.autopilot.askOnLarge", false);
    expect(Flight.stopReason(b)).toBe("sensitive");
    // A project with no value of its own follows the app value; a value of its own wins over it.
    const C = risky("/work/third");
    Store.putSetting(APP, "flightPlan.autopilot.askOnLarge", false);
    Store.putSetting(APP, "flightPlan.autopilot.askOnSensitive", false);
    expect(Flight.stopReason(C)).toBeNull();
    Store.putSetting("/work/third", "flightPlan.autopilot.askOnSensitive", true);
    expect(Flight.stopReason(C)).toBe("sensitive");
    expect(Store.hasSetting("/work/fourth", "flightPlan.autopilot.askOnLarge")).toBe(false);
  });

  test("every stop rule refuses with its own sentence", () => {
    Store.putSetting(ROOT, "flightPlan.pilot", "autopilot");
    const why = (p: ReturnType<typeof plan>) => (Flight.stopReason(p) ? Flight.seatMayFly(p) : null);

    const ask = plan(); withRun(ask, [finding("F1", "major", "ask")]);
    expect(Flight.stopReason(Plans.getPlan(ask.id)!)).toBe("ask-finding");
    expect(why(Plans.getPlan(ask.id)!)).toEqual({ ok: false, error: `Go is the person's here: ${Flight.STOP_SENTENCE["ask-finding"]}` });

    const large = plan({ size: "L" });
    expect(Flight.stopReason(large)).toBe("large");
    Store.putSetting(APP, "flightPlan.autopilot.askOnLarge", false);
    expect(Flight.stopReason(large)).toBeNull();

    const risky = plan({}, "# Plan\nTouch `server/src/auth/token.ts`.");
    expect(Flight.stopReason(risky)).toBe("sensitive");
    Store.putSetting(APP, "flightPlan.autopilot.askOnSensitive", false);
    expect(Flight.stopReason(risky)).toBeNull();
  });

  test("a question the coordinator raised stops it until the person answers", () => {
    Store.putSetting(ROOT, "flightPlan.pilot", "autopilot");
    const p = plan();
    expect(Plans.raiseQuestion(p.id, { text: "Keep the old URL?", choices: ["Yes", "No"], reason: "ask-finding" }, "coordinator:chair").ok).toBe(true);
    expect(Flight.stopReason(Plans.getPlan(p.id)!)).toBe("ask-finding");
    expect(Plans.raiseQuestion(p.id, { text: "again", choices: [], reason: "ask-finding" }, "c").ok).toBe(false);
    expect(Plans.answerQuestion(p.id, "Yes", "you").ok).toBe(true);
    expect(Flight.stopReason(Plans.getPlan(p.id)!)).toBeNull();
  });

  test("a blocker is a stop only once the second looks are used up", () => {
    const p = plan();
    withRun(p, [finding("F1", "blocker")]);
    expect(Flight.stopReason(Plans.getPlan(p.id)!)).toBeNull();
    for (let i = 0; i < Flight.autoRunsMax(); i++) Plans.countAutoRun(p.id);
    expect(Flight.stopReason(Plans.getPlan(p.id)!)).toBe("open-blocker");
    // A blocker the coordinator already answered is not open.
    const q = plan(); withRun(q, [finding("F1", "blocker", "fix")]);
    for (let i = 0; i < Flight.autoRunsMax(); i++) Plans.countAutoRun(q.id);
    expect(Flight.stopReason(Plans.getPlan(q.id)!)).toBeNull();
  });

  test("the budget stops it: the day's Preflight spend reaches the cap, and raising the cap lets it go", () => {
    Store.putSetting(ROOT, "flightPlan.pilot", "autopilot");
    const p = plan();
    expect(Flight.stopReason(p)).toBeNull();
    withRun(plan(), [], 5.5);
    Budget.forgetBudget();
    expect(Budget.budgetState().reached).toBe("daily");
    expect(Flight.stopReason(p)).toBe("budget");
    expect(Flight.seatMayFly(p)).toEqual({ ok: false, error: `Go is the person's here: ${Flight.STOP_SENTENCE.budget}` });
    Store.putSetting(APP, "flightPlan.budget.dailyUsd", 10);
    expect(Flight.stopReason(p)).toBeNull();
  });
});

describe("budget", () => {
  test("builder turns count by their flight-plan branch, and nothing else does", () => {
    const rows = [
      { branch: "flight-plan/footer", dir: "/w", session_id: "a", usd: 1.25, last_ts: 1 },
      { branch: "feat/other", dir: "/w", session_id: "b", usd: 9, last_ts: 1 },
      { branch: "", dir: "/w", session_id: "c", usd: 9, last_ts: 1 },
    ];
    expect(Budget.spentSince(0, { rows: () => rows, preflight: () => 0.5, roots: () => [ROOT] })).toBeCloseTo(1.75);
  });

  test("the day starts at local midnight and the week on Monday", () => {
    const wed = new Date(2026, 9, 28, 15, 30).getTime();
    expect(new Date(Budget.dayStart(wed)).getHours()).toBe(0);
    const mon = new Date(Budget.weekStart(wed));
    expect([mon.getDay(), mon.getDate(), mon.getHours()]).toEqual([1, 26, 0]);
    expect(new Date(Budget.weekStart(new Date(2026, 9, 25, 12).getTime())).getDate()).toBe(19);
  });

  test("a cap reached tells which one and when it resets", () => {
    const now = new Date(2026, 9, 28, 15).getTime();
    const s = Budget.budgetState(now, { rows: () => [], preflight: (since) => (since === Budget.dayStart(now) ? 6 : 6), roots: () => [] });
    expect(s.reached).toBe("daily");
    expect(s.until).toBe(Budget.dayStart(now) + 86_400_000);
    const w = Budget.budgetState(now, { rows: () => [], preflight: (since) => (since === Budget.dayStart(now) ? 1 : 21), roots: () => [] });
    expect(w.reached).toBe("weekly");
    expect(w.until).toBe(Budget.weekStart(now) + 7 * 86_400_000);
  });
});

describe("what a Preflight costs", () => {
  test("an S plan never gets one, by hand or by itself", () => {
    const p = plan({ size: "S" });
    expect(Flight.afterPlanText(p, "t")).toBeNull();
    expect(Flight.preflightPlan(p, "t")).toEqual({ ok: false, error: expect.stringContaining("S plan gets no Preflight") });
    expect(db.query(`SELECT COUNT(*) AS c FROM preflight_run`).get()).toEqual({ c: 0 });
  });

  test("sizes=L leaves an M plan to a press on Run; the review count stops at 1 + secondLooks", () => {
    Store.putSetting(APP, "flightPlan.preflight.sizes", "L");
    expect(Flight.afterPlanText(plan({ size: "M" }), "t")).toBeNull();
    Store.putSetting(APP, "flightPlan.preflight.sizes", "ML");
    expect(Flight.autoRunsMax()).toBe(2);
    Store.putSetting(APP, "flightPlan.preflight.secondLooks", 0);
    expect(Flight.autoRunsMax()).toBe(1);
    Store.putSetting(APP, "flightPlan.preflight.secondLooks", 2);
    expect(Flight.autoRunsMax()).toBe(3);
  });

  test("afterPlanText stops once the project's second looks are used", () => {
    Store.putSetting(ROOT, "flightPlan.preflight.reviews", ["plan"]);
    Store.putSetting(APP, "flightPlan.preflight.secondLooks", 0);
    const p = plan();
    Plans.countAutoRun(p.id);
    expect(Flight.afterPlanText(Plans.getPlan(p.id)!, "t")).toBeNull();
  });

  test("a Preflight the project does not list is refused with a sentence", () => {
    Store.putSetting(ROOT, "flightPlan.preflight.reviews", ["pr"]);
    expect(Flight.request({ root: ROOT, moment: "before-launch", by: "t" })).toEqual({ ok: false, error: `Preflight does not review before-launch in ${ROOT}.` });
  });

  test("a task-done review needs taskDone listed and an L plan behind the task", async () => {
    const STUB = new URL("./preflightStub.ts", import.meta.url).pathname;
    Flight.__setPreflightDeps({ bin: [process.execPath, STUB], env: { STUB_REPLY: "No findings." } });
    try {
      const task = { id: "T-1", root: ROOT, title: "t", detail: "", proof: "", outcome: "" } as never;
      const runs = () => (db.query(`SELECT COUNT(*) AS c FROM preflight_run`).get() as { c: number }).c;
      const linked = plan({ taskId: "T-1", size: "M" });
      Store.putSetting(ROOT, "flightPlan.preflight.reviews", ["plan", "taskDone"]);
      await Flight.afterTaskDone(task, "t");
      expect(runs()).toBe(0);
      Plans.patchPlan(linked.id, { size: "L" });
      Store.putSetting(ROOT, "flightPlan.preflight.reviews", ["plan"]);
      await Flight.afterTaskDone(task, "t");
      expect(runs()).toBe(0);
      Store.putSetting(ROOT, "flightPlan.preflight.reviews", ["plan", "taskDone"]);
      await Flight.afterTaskDone(task, "t");
      expect(runs()).toBe(1);
    } finally { Flight.__setPreflightDeps(null); }
  });
});

describe("the builder never", () => {
  const rules = ["git push", "gh pr", "gh release", "git merge", "git tag", "agentglass-ui settings set", "agentglass-ui rules set"].map((c) => `Bash(${c}:*)`);

  test("the deny list is in the launch argv, on top of the person's own, in every mode", () => {
    for (const mode of ["default", "auto", "bypassPermissions"]) {
      const argv = launchFlags("claude", launchPerm(mode, undefined, false, Flight.BUILDER_DENY));
      const denied = argv[argv.indexOf("--disallowedTools") + 1]!;
      for (const r of rules) expect(denied).toContain(r);
    }
  });

  test("the launch passes it: the route's launch function names BUILDER_DENY (break this and the builder is unfenced)", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url).pathname).text();
    const start = src.indexOf("async function launchFlightPlan(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(start).toBeGreaterThan(0);
    expect(body).toContain("launchPerm(builder.mode, undefined, false, FlightPlan.BUILDER_DENY)");
  });

  test("the launch gives the builder's tab its worktree in the environment, which is what holds its file writes (break this and they are free)", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url).pathname).text();
    const start = src.indexOf("async function launchFlightPlan(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toContain("{ [FlightPlan.BUILDER_ENV]: tree.path, TMPDIR: scratch }");
    expect(Flight.BUILDER_ENV).toBe("AGENTGLASS_BUILDER_WORKTREE");
    const hook = await Bun.file(new URL("../../hooks/send_event.py", import.meta.url).pathname).text();
    expect(hook).toContain(Flight.BUILDER_ENV);
  });

  test("the brief says what is denied and what to do instead of a merge", () => {
    expect(Flight.reportingBlock("chair")).toContain("rebase");
  });
});

describe("worktreeVerdict", () => {
  const tree = "/work/orbit-fp-footer";
  const verdict = (tool: string, input: object, cwd = tree) => Flight.worktreeVerdict(tree, cwd, tool, JSON.stringify(input));

  test("only the file-writing tools are held, and only outside the tree", () => {
    expect(verdict("Edit", { file_path: `${tree}/src/a.ts` })).toBeNull();
    expect(verdict("Write", { file_path: "src/a.ts" })).toBeNull();
    expect(verdict("Write", { file_path: "../acme/b.ts" })).toMatchObject({ decision: "never", ruleId: "flight-plan-worktree", reason: expect.stringContaining(tree) });
    expect(verdict("NotebookEdit", { notebook_path: "/work/elsewhere/n.ipynb" })).toMatchObject({ decision: "never" });
    expect(verdict("MultiEdit", { file_path: "/work/orbit/main-checkout.ts" })).toMatchObject({ decision: "never" });
    expect(verdict("Read", { file_path: "/work/elsewhere/a.ts" })).toBeNull();
    expect(verdict("Bash", { command: "echo x > /work/elsewhere/a" })).toBeNull();   // the named limit
    expect(verdict("Write", {})).toBeNull();
  });

  test("a sibling that merely starts with the tree's name is outside it", () => {
    expect(verdict("Write", { file_path: `${tree}-other/a.ts` })).toMatchObject({ decision: "never" });
  });
});

describe("what an agent may change about the pilot", () => {
  const v = (id: string, prev: unknown, next: unknown) => agentVerdict(id, prev, next, true);

  test("autopilot is the person's even with the switch on; narrowing applies at once", () => {
    expect(v("flightPlan.pilot", "copilot", "autopilot")).toBe("refuse");
    expect(refusalWhy("flightPlan.pilot", "copilot", "autopilot")).toContain("only the person turns it on");
    expect(v("flightPlan.pilot", "autopilot", "copilot")).toBe("apply");
    expect(v("flightPlan.pilot", "copilot", "manual")).toBe("apply");
    expect(v("flightPlan.pilot", "manual", "copilot")).toBe("apply");
  });

  test("a budget is lowered at once and raised only by the person; the two stop rules likewise", () => {
    expect(v("flightPlan.budget.dailyUsd", 5, 3)).toBe("apply");
    expect(v("flightPlan.budget.dailyUsd", 5, 8)).toBe("refuse");
    expect(v("flightPlan.budget.weeklyUsd", 20, 30)).toBe("refuse");
    expect(v("flightPlan.autopilot.askOnLarge", true, false)).toBe("refuse");
    expect(v("flightPlan.autopilot.askOnSensitive", true, false)).toBe("refuse");
    expect(v("flightPlan.autopilot.askOnLarge", false, true)).toBe("apply");
  });

  test("hold is open to anyone and release is the person's", () => {
    expect(agentVerdict("flightPlan.held", false, true, false)).toBe("apply");
    expect(agentVerdict("flightPlan.held", true, false, true)).toBe("refuse");
  });

  test("reviews, sizes and second looks only narrow at once", () => {
    expect(agentVerdict("flightPlan.preflight.reviews", ["plan", "pr"], ["plan"], false)).toBe("apply");
    expect(agentVerdict("flightPlan.preflight.reviews", ["plan"], ["plan", "pr"], false)).toBe("ask");
    expect(agentVerdict("flightPlan.preflight.sizes", "ML", "L", false)).toBe("apply");
    expect(agentVerdict("flightPlan.preflight.sizes", "L", "ML", false)).toBe("ask");
    expect(agentVerdict("flightPlan.preflight.secondLooks", 2, 1, false)).toBe("apply");
    expect(agentVerdict("flightPlan.preflight.secondLooks", 1, 2, false)).toBe("ask");
    expect(agentVerdict("flightPlan.maxFlying", 2, 1, false)).toBe("apply");
  });
});

describe("what the view reads off a plan", () => {
  const sh = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", "-c", "user.email=a@b.c", "-c", "user.name=orbit", ...a], { cwd }).stdout.toString().trim();

  test("a builder has landed once its branch moved off its start and main holds it, or the branch is gone", () => {
    const repo = mkdtempSync(join(tmpdir(), "agx-landed-"));
    try {
      sh(repo, "init", "-q", "-b", "main"); writeFileSync(join(repo, "a"), "1"); sh(repo, "add", "a"); sh(repo, "commit", "-q", "-m", "one");
      const from = sh(repo, "rev-parse", "HEAD");
      sh(repo, "branch", "flight-plan/footer");
      const p = plan({ root: repo });
      const at = (over: object) => ({ ...Plans.getPlan(p.id)!, launched: { at: 1, title: "Footer", branch: "flight-plan/footer", from, ...over } });
      expect(Flight.landed(at({}), "main")).toBe(false);                 // cut, nothing built: git calls it an ancestor of main, it has landed nothing
      sh(repo, "checkout", "-q", "flight-plan/footer"); writeFileSync(join(repo, "b"), "2"); sh(repo, "add", "b"); sh(repo, "commit", "-q", "-m", "two");
      expect(Flight.landed(at({}), "main")).toBe(false);                 // built, not merged
      sh(repo, "checkout", "-q", "main"); sh(repo, "merge", "-q", "--ff-only", "flight-plan/footer");
      expect(Flight.landed(at({}), "main")).toBe(true);                  // merged
      sh(repo, "branch", "-q", "-D", "flight-plan/footer");
      expect(Flight.landed(at({}), "main")).toBe(true);                  // branch gone
      expect(Flight.landed(at({ branch: undefined }), "main")).toBe(true); // launched before the branch was kept
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("the first sighting of a landing is kept and not moved by the next", async () => {
    const p = plan();
    Plans.markLanded(p.id);
    const first = Plans.getPlan(p.id)!.landedAt;
    expect(first).not.toBeNull();
    await Bun.sleep(5);
    Plans.markLanded(p.id);
    expect(Plans.getPlan(p.id)!.landedAt).toBe(first);
  });

  test("a builder's report is one capped line of data; only a launched plan takes one; steps must add up", () => {
    const p = plan();
    expect(Plans.reportProgress(p.id, { line: "x" }, "builder").ok).toBe(false);
    db.query(`UPDATE flight_plan SET state = 'launched' WHERE id = ?`).run(p.id);
    const long = "step\n  done ".repeat(60);
    const r = Plans.reportProgress(p.id, { line: long, step: 2, of: 5 }, "builder");
    expect(r.ok && r.plan.lastReport).toMatchObject({ step: 2, of: 5, by: "builder" });
    expect(r.ok && r.plan.lastReport!.line.length).toBeLessThanOrEqual(200);
    expect(r.ok && r.plan.lastReport!.line).not.toContain("\n");
    expect(Plans.reportProgress(p.id, { line: "x", step: 6, of: 5 }, "b")).toMatchObject({ ok: false, status: 400 });
    expect(Plans.reportProgress(p.id, { line: "   " }, "b")).toMatchObject({ ok: false, status: 400 });
  });

  test("a question carries an id, its detail and which choice the coordinator recommends", () => {
    const p = plan();
    expect(Plans.raiseQuestion(p.id, { text: "Keep the URL?", detail: "The old one is linked from docs.", choices: ["Yes", "No"], recommended: 1, reason: "ask-finding" }, "coordinator:chair").ok).toBe(true);
    expect(Plans.getPlan(p.id)!.question).toMatchObject({ id: expect.stringMatching(/^q_[0-9a-f]{8}$/), detail: "The old one is linked from docs.", recommended: 1, choices: ["Yes", "No"] });
    const bad = plan();
    expect(Plans.raiseQuestion(bad.id, { text: "q", choices: ["Yes"], recommended: 3, reason: "ask-finding" }, "c")).toMatchObject({ ok: false, status: 400 });
  });

  test("who held a project and when is kept with the hold and dropped with the release", () => {
    expect(Store.heldMeta(ROOT)).toBeNull();
    Store.markHeld(ROOT, true, "you");
    expect(Store.heldMeta(ROOT)).toMatchObject({ by: "you", at: expect.any(Number) });
    Store.markHeld(ROOT, false, "you");
    expect(Store.heldMeta(ROOT)).toBeNull();
  });
});

const have = !!Bun.which("tmux") && !!Bun.which("python3");
describe.skipIf(!have)("a coordinator on a booted server", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness("fppilot");
    await h.asPerson("/settings/door", { id: "flightPlan.enabled", value: true });
    // These tests are about who may say Go; a review before it has its own tests (flight-plan-fixes.test.ts).
    await h.asPerson("/settings/door", { id: "flightPlan.preflight.reviews", value: [], root: h.dir });
  }, SERVER_BOOT_MS);
  afterAll(async () => { if (have && h) await h.stop(); });

  const seat = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(h.base + path, { method, headers: { Authorization: `Bearer ${h.seatToken}`, "Content-Type": "application/json", Origin: h.base }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const setPilot = (value: string) => h.asPerson("/settings/door", { id: "flightPlan.pilot", value, root: h.dir });
  const ready = async (size = "M", md = "# Plan\nChange the footer text.") => {
    const made = await seat("POST", "/flight-plan/plans", { root: h.dir, request: "footer", size });
    const id = made.body.plan.id as string;
    const set = await seat("PATCH", `/flight-plan/plans/${id}`, { plan_md: md });
    expect(set.status).toBe(200);
    return id;
  };
  const planOf = async (id: string) => ((await h.read(`/flight-plan/plans/${id}`, h.seatToken)).body);

  test("it writes the plan itself: create and save are open to it, and no author tab is minted", async () => {
    const made = await seat("POST", "/flight-plan/plans", { root: h.dir, request: "footer" });
    expect(made.status).toBe(200);
    expect(made.body.ticket).toBeNull();
  });

  test("Go is refused in Co-pilot and in Manual, with the pilot named, and the plan does not move", async () => {
    const id = await ready();
    for (const [pilot, word] of [["copilot", "Co-pilot"], ["manual", "Manual"]] as const) {
      await setPilot(pilot);
      const r = await seat("POST", `/flight-plan/plans/${id}/go`, {});
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(`this project flies in ${word}: Go is the person's`);
    }
    expect((await planOf(id)).plan.state).toBe("ready");
  });

  test("only the person can turn Autopilot on: the coordinator's own request is refused outright", async () => {
    const r = await h.asSeat("/settings/door", { id: "flightPlan.pilot", value: "autopilot" });
    expect(JSON.stringify(r)).toContain("only the person turns it on");
    expect((await planOf(await ready())).pilot).not.toBe("autopilot");
  });

  test("in Autopilot its Go is recorded under the seat's name; held, a stop rule and Resume each have their say", async () => {
    await setPilot("autopilot");
    const id = await ready();
    const go = await seat("POST", `/flight-plan/plans/${id}/go`, {});
    // The project here is no git checkout, so the launch that follows Go cannot cut a tree: the decision is what this asserts.
    expect(go.body.plan?.decision?.by ?? (await planOf(id)).plan.decision.by).toMatch(/^coordinator:/);

    const held = await ready();
    const hold = await seat("POST", "/flight-plan/hold", {});
    expect(hold.body).toMatchObject({ ok: true, held: true });
    const refused = await seat("POST", `/flight-plan/plans/${held}/go`, {});
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("this project is held: no new Go until the person resumes it");

    expect((await seat("POST", "/flight-plan/resume", {})).status).toBe(403);
    // The wall turns a seat away first; an agent speaking with the person's key is the route's own check.
    const agent = await fetch(h.base + "/flight-plan/resume", { method: "POST", headers: { Authorization: `Bearer ${MACHINE}`, "Content-Type": "application/json", Origin: h.base, "x-agentglass-agent": "helper" }, body: JSON.stringify({ root: h.dir }) });
    expect(agent.status).toBe(403);
    expect((await planOf(held)).held).toBe(true);
    expect((await h.asPerson("/flight-plan/resume", { root: h.dir })).ok).toBe(true);
    expect((await planOf(held)).held).toBe(false);

    const large = await ready("L");
    const stop = await seat("POST", `/flight-plan/plans/${large}/go`, {});
    expect(stop.status).toBe(403);
    expect(stop.body.error).toBe(`Go is the person's here: ${Flight.STOP_SENTENCE.large}`);
    expect((await planOf(large)).stopReason).toBe("large");
  });

  test("the one question: the coordinator raises it, cannot answer it, the person does, and Go then goes", async () => {
    await setPilot("autopilot");
    const id = await ready();
    const ask = await seat("POST", `/flight-plan/plans/${id}/ask`, { question: "Keep the old URL?", choices: ["Yes", "No"] });
    expect(ask.status).toBe(200);
    expect((await seat("POST", `/flight-plan/plans/${id}/go`, {})).body.error).toContain(Flight.STOP_SENTENCE["ask-finding"]);
    expect((await seat("POST", `/flight-plan/plans/${id}/answer`, { answer: "Yes" })).status).toBe(403);
    expect((await h.asPerson(`/flight-plan/plans/${id}/answer`, { answer: "Yes" })).ok).toBe(true);
    expect((await planOf(id)).stopReason).toBeNull();
  });

  test("the list and the plan carry what the view reads: creator, hold who and when, landed, the question and the builder's report", async () => {
    await setPilot("autopilot");
    const made = await seat("POST", "/flight-plan/plans", { root: h.dir, request: "creator" });
    expect(made.body.plan.createdBy).toMatch(/^coordinator:/);
    const person = await h.asPerson("/flight-plan/plans", { root: h.dir, request: "by hand" }) as any;
    expect(person.plan.createdBy).toBe("you");

    const id = await ready();
    const ask = await seat("POST", `/flight-plan/plans/${id}/ask`, { question: "Keep it?", detail: "Linked from docs.", choices: ["Yes", "No"], recommended: 1 });
    expect(ask.status).toBe(200);
    expect(ask.body.plan.question).toMatchObject({ id: expect.stringMatching(/^q_/), detail: "Linked from docs.", recommended: 1 });
    expect((await seat("POST", `/flight-plan/plans/${id}/ask`, { question: "x", choices: ["a"], recommended: 4 })).status).toBe(409); // already asked
    expect((await h.asPerson(`/flight-plan/plans/${id}/answer`, { answer: "Yes" }) as any).ok).toBe(true);

    await seat("POST", "/flight-plan/hold", {});
    let listed = (await seat("GET", "/flight-plan/plans")).body;
    expect(listed.plans[0]).toMatchObject({ held: true, heldBy: expect.stringMatching(/^coordinator:/), heldAt: expect.any(Number) });
    await h.asPerson("/flight-plan/resume", { root: h.dir });
    listed = (await seat("GET", "/flight-plan/plans")).body;
    expect(listed.plans[0]).toMatchObject({ held: false, heldBy: null, heldAt: null });
    await h.asPerson("/flight-plan/hold", { root: h.dir });
    expect((await seat("GET", "/flight-plan/plans")).body.plans[0].heldBy).toBe("you");
    await h.asPerson("/flight-plan/resume", { root: h.dir });

    // A launched plan: rows go straight into the server's own database (the project here is no git checkout, so nothing can launch for real).
    // The server is another process still writing after the resume above; a second connection waits for its lock the way the server's own does, or it throws SQLITE_BUSY on a 1-2 core runner (3 of 3 runs at 1 CPU).
    const db2 = new Database(join(h.dir, "w.db"));
    db2.run("PRAGMA busy_timeout = 5000");
    db2.query(`INSERT INTO flight_plan (id, root, title, request, state, launched, created_at, updated_at) VALUES ('fp_00000000000000aa', ?, 'old', 'r', 'launched', '{"at":1,"title":"old"}', 1, 1)`).run(h.dir);
    db2.query(`INSERT INTO flight_plan (id, root, title, request, state, launched, created_at, updated_at) VALUES ('fp_00000000000000bb', ?, 'new', 'r', 'launched', '{"at":2,"title":"new","branch":"flight-plan/new","from":"abc"}', 2, 2)`).run(h.dir);
    db2.close();
    const rows = Object.fromEntries((await seat("GET", "/flight-plan/plans?state=launched")).body.plans.map((p: any) => [p.id, p]));
    expect(rows["fp_00000000000000aa"]).toMatchObject({ landed: true });    // launched before the branch was kept: history
    expect(rows["fp_00000000000000bb"]).toMatchObject({ landed: false });   // no git checkout to say otherwise: it still flies
    expect((await planOf("fp_00000000000000bb")).landed).toBe(false);

    const rep = await seat("POST", "/flight-plan/plans/fp_00000000000000bb/report", { line: "Footer text done, tests next", step: 2, of: 4 });
    expect(rep.body.plan.lastReport).toMatchObject({ line: "Footer text done, tests next", step: 2, of: 4 });
    expect((await planOf("fp_00000000000000bb")).plan.lastReport.line).toBe("Footer text done, tests next");
    expect((await seat("POST", `/flight-plan/plans/${id}/report`, { line: "x" })).status).toBe(409);   // not launched: no builder
  });
});

describe("Flight plan in one project", () => {
  const OFF = "/work/acme/billing";
  afterEach(() => { db.query(`DELETE FROM flight_plan_setting WHERE key = 'flightPlan.project.enabled'`).run(); });
  test("a project is in until the person leaves it out, and the others stay in", () => {
    expect(Flight.projectOn(OFF)).toBe(true);
    Store.putSetting(OFF, "flightPlan.project.enabled", false);
    expect(Flight.projectOn(OFF)).toBe(false);
    expect(Flight.projectOn(ROOT)).toBe(true);
  });
  test("a Preflight is refused in a project that is left out, even when the person presses Run", () => {
    Store.putSetting(OFF, "flightPlan.project.enabled", false);
    const r = Flight.request({ root: OFF, moment: "manual", by: "you" });
    expect(r.ok).toBe(false);
  });
  test("an agent may leave a project out, and turning it back on waits for the person", () => {
    const id = "flightPlan.project.enabled";
    expect(agentVerdict(id, true, false, false)).toBe("apply");
    expect(agentVerdict(id, false, true, false)).toBe("ask");
  });
});
