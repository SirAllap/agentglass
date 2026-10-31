/*
 * The Flight plan on the server: the per-project settings (off until asked,
 * and which direction waits for the person), the runs and what may be said
 * about a finding, the moment a Preflight is allowed to start, and the hook
 * that reviews a finished task. The reviewer is a stub (preflightStub.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentVerdict, classOf } from "../../shared/settingClass.ts";

const REAL_XDG = process.env.XDG_CONFIG_HOME;
const HOME = mkdtempSync(join(tmpdir(), "agx-flightplan-"));
process.env.XDG_CONFIG_HOME = HOME;
mkdirSync(join(HOME, "agentglass"), { recursive: true });

const STUB = new URL("./preflightStub.ts", import.meta.url).pathname;
const RECORD = join(HOME, "record.json");
const { __setPreflightDeps, request, go, noGo, afterTaskDone, afterPlanText, launchPlan, preflightPlan } = await import("../src/flightPlan.ts");
const Plans = await import("../src/flightPlanStore.ts");
const Store = await import("../src/preflightStore.ts");
const Queue = await import("../src/seatqueue.ts");
const { db } = await import("../src/db.ts");
const { serverSettingDefs } = await import("../src/serverSettings.ts");

const reply = (text: string) => __setPreflightDeps({ bin: [process.execPath, STUB], env: { STUB_RECORD: RECORD, STUB_REPLY: text } });
const defs = serverSettingDefs({ terminalEnabled: false, budgetWrites: false, policyChanged() {} });
const def = (k: string) => defs.find((d) => d.id === `flightPlan.preflight.${k}`)!;
const ROOT = "/work/orbit";
const set = (k: string, v: string | number | string[], root = ROOT) => Store.putSetting(root, `flightPlan.preflight.${k}` as never, v);
const MAJOR = "### F1 - Major - Unstated\nQuote: q\nEvidence: e";
let file: string;

beforeAll(() => { file = join(HOME, "plan.md"); writeFileSync(file, "# Plan"); });
afterEach(() => { __setPreflightDeps(null); rmSync(RECORD, { force: true }); });
afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  if (REAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = REAL_XDG;
});

describe("settings", () => {
  // The global row is shared by every file in the process: put it back to the shipped value.
  afterEach(() => { Store.putSetting(Store.APP, "flightPlan.preflight.reviews", ["plan"]); });
  test("a project with no value of its own follows the global one; its own value wins", () => {
    Store.putSetting(Store.APP, "flightPlan.preflight.reviews", ["plan", "pr"]);
    expect(def("reviews").read("/work/fresh2")).toEqual(["plan", "pr"]);
    expect(def("reviews").isSet!("/work/fresh2")).toBe(false);
    def("reviews").apply(["plan"], "/work/own-plan");
    expect(def("reviews").read("/work/own-plan")).toEqual(["plan"]);
    expect(def("reviews").isSet!("/work/own-plan")).toBe(true);
  });
  test("changing one project never touches the global value or another project", () => {
    Store.putSetting(Store.APP, "flightPlan.preflight.reviews", ["plan", "taskDone", "pr"]);
    def("reviews").apply([], "/work/solo");
    expect(def("reviews").read(Store.APP)).toEqual(["plan", "taskDone", "pr"]);
    expect(def("reviews").read("/work/solo")).toEqual([]);
    expect(def("reviews").read("/work/other")).toEqual(["plan", "taskDone", "pr"]);
  });
  test("a stored value of the old per-moment keys still says what the project wanted: off is not reviewed, ask and auto are", () => {
    const legacy = (root: string, k: string, v: string) => db.query(`INSERT OR REPLACE INTO flight_plan_setting (root, key, value) VALUES (?, ?, ?)`).run(root, `flightPlan.preflight.${k}`, JSON.stringify(v));
    try {
      db.query(`DELETE FROM flight_plan_setting WHERE root = ? AND key = 'flightPlan.preflight.reviews'`).run(Store.APP);
      legacy("/work/old", "beforeLaunch", "off"); legacy("/work/old", "onTaskDone", "ask"); legacy("/work/old", "onPr", "auto");
      expect(def("reviews").read("/work/old")).toEqual(["taskDone", "pr"]);
      expect(def("reviews").isSet!("/work/old")).toBe(true);
      // an explicit list wins over the old rows
      def("reviews").apply(["plan"], "/work/old");
      expect(def("reviews").read("/work/old")).toEqual(["plan"]);
    } finally { db.query(`DELETE FROM flight_plan_setting WHERE root = '/work/old'`).run(); }
  });
  test("every one is cheap until somebody chooses; reviews and pilot are per project", () => {
    expect(def("reviews").read("/work/fresh")).toEqual(["plan"]);
    expect(defs.find((d) => d.id === "flightPlan.pilot")!.read("/work/fresh")).toBe("copilot");
    expect(def("sizes").read(undefined)).toBe("ML");
    expect(def("secondLooks").read(undefined)).toBe(1);
    expect(def("model").read("/work/fresh")).toBe("sonnet");
    expect(def("costCapUsd").read("/work/fresh")).toBe(0.5);
    expect(def("reviews").apply(["pr"], "/work/a")).toEqual({ ok: true });
    expect(def("reviews").read("/work/a")).toEqual(["pr"]);
    expect(def("reviews").read("/work/b")).toEqual(["plan"]);
    // the preflight settings are per project, except which sizes get one and how many second looks; the master switch and the mockup guide are the app's
    const appWide = ["flightPlan.preflight.sizes", "flightPlan.preflight.secondLooks"];
    expect(defs.filter((d) => d.id.startsWith("flightPlan.preflight.") && !appWide.includes(d.id)).every((d) => d.scoped)).toBe(true);
    expect(appWide.every((id) => !defs.find((d) => d.id === id)!.scoped)).toBe(true);
    expect(defs.filter((d) => d.id === "flightPlan.enabled" || d.id === "flightPlan.mockupGuide").every((d) => !d.scoped)).toBe(true);
    expect(defs.find((d) => d.id === "flightPlan.enabled")!.read(undefined)).toBe(false);
  });

  test("values outside the set are refused", () => {
    for (const bad of ["on", "AUTO", true, null, ["plan", "nope"], 3]) expect(def("reviews").validate(bad), String(bad)).toHaveProperty("error");
    expect(def("reviews").validate(["pr", "plan", "pr"])).toEqual({ value: ["pr", "plan"] });
    expect(def("reviews").validate([])).toEqual({ value: [] });
    for (const bad of ["XL", "m", 1, null]) expect(def("sizes").validate(bad), String(bad)).toHaveProperty("error");
    for (const bad of [-1, 3, 0.5, "1"]) expect(def("secondLooks").validate(bad), String(bad)).toHaveProperty("error");
    expect(def("secondLooks").validate(2)).toEqual({ value: 2 });
    for (const bad of [0, -1, 5.01, "1", Number.NaN]) expect(def("costCapUsd").validate(bad)).toHaveProperty("error");
    for (const bad of ["--help", "-x", ".hidden", "a b", ""]) expect(def("model").validate(bad), String(bad)).toHaveProperty("error");
    expect(def("model").validate("claude-sonnet-4-5")).toEqual({ value: "claude-sonnet-4-5" });
    expect(def("costCapUsd").validate(5)).toEqual({ value: 5 });
    expect(def("model").validate("two words")).toHaveProperty("error");
    expect(def("model").validate("opus")).toEqual({ value: "opus" });
  });

  test("reviewing more, looking at more sizes, raising the cap or changing model waits; the other way applies", () => {
    const v = (k: string, a: unknown, b: unknown) => agentVerdict(`flightPlan.preflight.${k}`, a, b, false);
    expect(v("reviews", ["plan"], ["plan", "taskDone"])).toBe("ask");
    expect(v("reviews", [], ["pr"])).toBe("ask");
    expect(v("reviews", ["plan", "taskDone"], ["plan"])).toBe("apply");
    expect(v("reviews", ["plan"], [])).toBe("apply");
    expect(v("sizes", "L", "ML")).toBe("ask");
    expect(v("sizes", "ML", "L")).toBe("apply");
    expect(v("secondLooks", 1, 2)).toBe("ask");
    expect(v("secondLooks", 1, 0)).toBe("apply");
    expect(v("costCapUsd", 0.5, 1)).toBe("ask");
    expect(v("costCapUsd", 0.5, 0.2)).toBe("apply");
    expect(v("model", "sonnet", "opus")).toBe("ask");
    for (const k of ["reviews", "sizes", "secondLooks", "model", "costCapUsd"]) expect(classOf(`flightPlan.preflight.${k}`)?.class).toBe("escalation");
    // the three per-moment keys are gone as settings
    for (const k of ["beforeLaunch", "onTaskDone", "onPr"]) { expect(classOf(`flightPlan.preflight.${k}`)).toBeNull(); expect(defs.some((d) => d.id === `flightPlan.preflight.${k}`)).toBe(false); }
  });

  test("the master switch and the mockup guide: on or a new path waits, off or empty applies", () => {
    expect(agentVerdict("flightPlan.enabled", false, true, false)).toBe("ask");
    expect(agentVerdict("flightPlan.enabled", true, false, false)).toBe("apply");
    expect(agentVerdict("flightPlan.mockupGuide", "", "/home/a/guide.md", false)).toBe("ask");
    expect(agentVerdict("flightPlan.mockupGuide", "/home/a/guide.md", "", false)).toBe("apply");
    expect(defs.find((d) => d.id === "flightPlan.mockupGuide")!.validate("relative.md")).toHaveProperty("error");
  });
});

describe("runs and findings", () => {
  const cert = (findings: unknown[]) => ({ id: "c", createdAt: 1, model: "m", costUsd: 0, files: [], mockups: [], skipped: [], sawConversation: false as const, isolation: "x", findings });
  const mk = (state: "awaiting-go" | "running" = "running") => Store.createRun({ root: ROOT, moment: "manual", state, by: "tester", input: { files: [file], model: "sonnet", budgetUsd: 0.5 } });
  const finding = (id: string, severity: string) => ({ id, severity, title: "t", quote: "", evidence: "", action: null, note: null });

  test("list filters by state and root, newest first", () => {
    const a = mk("awaiting-go"), b = Store.createRun({ root: "/work/other", moment: "pr", state: "running", by: "t", input: { files: [], model: "m", budgetUsd: 1 } });
    expect(Store.listRuns({ root: "/work/other" }).map((r) => r.id)).toEqual([b.id]);
    expect(Store.listRuns({ state: "awaiting-go", root: ROOT }).map((r) => r.id)).toContain(a.id);
    expect(Store.listRuns({ state: "awaiting-go", root: ROOT }).every((r) => r.state === "awaiting-go")).toBe(true);
    expect(Store.getRun(a.id)).toMatchObject({ requestedBy: "tester", moment: "manual", certificate: null, taskId: null });
  });

  test("contest and dismiss need a note; fix, ask and none do not; unknown things are refused", () => {
    const r = mk(); Store.finish(r.id, cert([finding("F1", "major")]) as never);
    for (const a of ["contest", "dismiss"] as const) {
      expect(Store.setFindingAction(r.id, "F1", a, "  ", "me")).toMatchObject({ ok: false, status: 400 });
      expect(Store.setFindingAction(r.id, "F1", a, null, "me")).toMatchObject({ ok: false });
    }
    expect(Store.getRun(r.id)!.certificate!.findings[0]!.action).toBeNull();
    expect(Store.setFindingAction(r.id, "F1", "contest", "the code does it, see a.ts:3", "me")).toMatchObject({ ok: true });
    expect(Store.getRun(r.id)!.certificate!.findings[0]).toMatchObject({ action: "contest", note: "the code does it, see a.ts:3", by: "me" });
    expect(Store.setFindingAction(r.id, "F1", "fix", null, "me")).toMatchObject({ ok: true });
    expect(Store.setFindingAction(r.id, "F1", null, null, "me")).toMatchObject({ ok: true });
    expect(Store.getRun(r.id)!.certificate!.findings[0]).toMatchObject({ action: null, note: null });
    expect(Store.setFindingAction(r.id, "F9", "fix", null, "me")).toMatchObject({ ok: false, status: 404 });
    expect(Store.setFindingAction(r.id, "F1", "bogus" as never, null, "me")).toMatchObject({ ok: false, status: 400 });
    expect(Store.setFindingAction("pf_none", "F1", "fix", null, "me")).toMatchObject({ ok: false, status: 404 });
  });

  test("flag: advisory, a finished review is checked and counts open blocker or major findings beside it", () => {
    const r = mk(); expect(Store.flagOf(Store.getRun(r.id)!)).toEqual({ status: "pending", openFindings: 0 });
    Store.finish(r.id, cert([finding("F1", "blocker"), finding("F2", "nit")]) as never);
    const s = () => Store.flagOf(Store.getRun(r.id)!);
    expect(s()).toEqual({ status: "checked", openFindings: 1 });
    Store.setFindingAction(r.id, "F1", "ask", null, "me"); expect(s().openFindings).toBe(1);
    Store.setFindingAction(r.id, "F1", "fix", null, "me"); expect(s()).toEqual({ status: "checked", openFindings: 0 });
    const f = mk(); Store.fail(f.id, "boom"); expect(Store.flagOf(Store.getRun(f.id)!)).toEqual({ status: "failed", openFindings: 0 });
  });
});

describe("the moment", () => {
  test("a moment the project does not review refuses with a sentence and creates nothing", () => {
    const before = Store.listRuns({ root: "/work/off" }).length;
    expect(request({ root: "/work/off", moment: "task-done", by: "t", files: [file] })).toEqual({ ok: false, error: "Preflight does not review task-done in /work/off." });
    expect(request({ root: "/work/off", moment: "pr", by: "t", files: [file] })).toEqual({ ok: false, error: "Preflight does not review pr in /work/off." });
    expect(Store.listRuns({ root: "/work/off" }).length).toBe(before);
  });

  test("a moment the project reviews starts running at once: no row waits for Go", async () => {
    reply("No findings"); set("reviews", ["pr"], "/work/now");
    const r = request({ root: "/work/now", moment: "pr", by: "t", files: [file] }) as Extract<ReturnType<typeof request>, { ok: true }>;
    expect(r.run.state).toBe("running");
    await r.done;
    expect(existsSync(RECORD)).toBe(true);
    expect(Store.getRun(r.run.id)).toMatchObject({ state: "done" });
    expect(go(r.run.id)).toMatchObject({ ok: false, status: 409 });
    // the list is per moment: this project reviews pr and nothing else
    expect(request({ root: "/work/now", moment: "before-launch", by: "t", files: [file] })).toMatchObject({ ok: false, error: "Preflight does not review before-launch in /work/now." });
  });

  test("the project's model and cap reach the reviewer", async () => {
    reply("No findings"); set("reviews", ["pr"], "/work/go"); set("model", "opus", "/work/go"); set("costCapUsd", 2, "/work/go");
    const r = request({ root: "/work/go", moment: "pr", by: "t", files: [file] }) as Extract<ReturnType<typeof request>, { ok: true }>;
    await r.done;
    expect(Store.getRun(r.run.id)).toMatchObject({ state: "done", certificate: { model: "opus", findings: [] } });
    const argv = JSON.parse(readFileSync(RECORD, "utf8")).argv as string[];
    expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2)).toEqual(["--model", "opus"]);
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("2");
  });

  // New runs never wait, but a row left awaiting-go (an older server wrote them) still answers to the person.
  const waiting = () => Store.createRun({ root: "/work/old-wait", moment: "pr", state: "awaiting-go", by: "t", input: { files: [file], model: "opus", budgetUsd: 2 } });

  test("an awaiting-go row left by an older server: nothing executes until Go, then it runs with its own model and cap", async () => {
    reply("No findings");
    const w = waiting();
    await Bun.sleep(100);
    expect(existsSync(RECORD)).toBe(false);
    const g = go(w.id) as Extract<ReturnType<typeof go>, { ok: true }>;
    expect(g.run.state).toBe("running");
    await g.done;
    expect(Store.getRun(w.id)).toMatchObject({ state: "done", certificate: { model: "opus", findings: [] } });
    expect(go(w.id)).toMatchObject({ ok: false, status: 409 });
    const argv = JSON.parse(readFileSync(RECORD, "utf8")).argv as string[];
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("2");
  });

  test("No-go declines an awaiting-go row once; neither verb works on it afterwards", () => {
    const w = waiting();
    expect(noGo(w.id)).toMatchObject({ ok: true, run: { state: "declined" } });
    expect(go(w.id)).toMatchObject({ ok: false, status: 409 });
    expect(noGo(w.id)).toMatchObject({ ok: false, status: 409 });
    expect(go("pf_none")).toMatchObject({ ok: false, status: 404 });
  });

  test("manual always runs, even with everything off", async () => {
    reply(MAJOR);
    const r = request({ root: "/work/manual", moment: "manual", by: "t", files: [file] }) as Extract<ReturnType<typeof request>, { ok: true }>;
    expect(r.run.state).toBe("running");
    await r.done;
    expect(Store.getRun(r.run.id)).toMatchObject({ state: "done", certificate: { findings: [{ id: "F1", severity: "major" }] } });
  });

  test("a reviewer that fails leaves a failed run with the reason", async () => {
    reply("nothing useful");
    const r = request({ root: "/work/manual", moment: "manual", by: "t", files: [file] }) as Extract<ReturnType<typeof request>, { ok: true }>;
    await r.done;
    expect(Store.getRun(r.run.id)).toMatchObject({ state: "failed", error: expect.stringContaining("nothing useful") });
  });
});

describe("a finished task", () => {
  // Only a task that came from an L plan is reviewed: a task with no plan, or from a smaller one, is not worth the spend.
  const task = (root: string, size?: "S" | "M" | "L") => {
    const t = Queue.addTask({ root, title: "Add thing", detail: "d", proof: "p" }); if (!t.ok) throw new Error(t.error);
    if (size) Plans.createPlan({ root, title: "Add thing", request: "r", visual: false, size, taskId: t.task.id });
    Queue.finishTask(t.task.id, "done, tested"); return Queue.taskById(t.task.id)!;
  };

  test("a project that does not review finished tasks: nothing is created and the task has no preflight, whatever its plan", async () => {
    const t = task("/work/t-off", "L");
    await afterTaskDone(t, "chair");
    expect(Queue.taskById(t.id)!.preflight).toBeNull();
    expect(Store.listRuns({ root: "/work/t-off" })).toEqual([]);
  });

  test("a task with no plan, or from an S or M plan, is not reviewed even when the project reviews finished tasks", async () => {
    reply("No findings");
    for (const [root, size] of [["/work/t-none", undefined], ["/work/t-s", "S"], ["/work/t-m", "M"]] as const) {
      set("reviews", ["taskDone"], root);
      const t = task(root, size);
      await afterTaskDone(t, "chair");
      expect(Queue.taskById(t.id)!.preflight).toBeNull();
      expect(Store.listRuns({ root })).toEqual([]);
    }
    expect(existsSync(RECORD)).toBe(false);
  });

  test("a task from an L plan: the run starts at once, linked to the task, and nothing waits for Go", async () => {
    reply("No findings"); set("reviews", ["taskDone"], "/work/t-run");
    const t = task("/work/t-run", "L");
    await afterTaskDone(t, "chair");
    const p = Queue.taskById(t.id)!.preflight!;
    expect(p.status).toBe("checked");
    expect(Store.getRun(p.runId)).toMatchObject({ state: "done", moment: "task-done", taskId: t.id, requestedBy: "chair" });
    expect(Store.listRuns({ state: "awaiting-go", root: "/work/t-run" })).toEqual([]);
  });

  test("the reviewer reads a TASK.md of the title, detail, proof and outcome; no findings is checked", async () => {
    reply("No findings"); set("reviews", ["taskDone"], "/work/t-auto");
    const t = task("/work/t-auto", "L");
    await afterTaskDone(t, "chair");
    expect(Queue.taskById(t.id)!.preflight!.status).toBe("checked");
    const body = JSON.parse(readFileSync(RECORD, "utf8")).contents["TASK.md"] as string;
    for (const part of ["# Add thing", "## Detail\nd", "## Proof\np", "## Outcome\ndone, tested"]) expect(body).toContain(part);
  });

  test("a major finding is a count on the task, not a status, and answering it lowers the count", async () => {
    reply(MAJOR); set("reviews", ["taskDone"], "/work/t-open");
    const t = task("/work/t-open", "L");
    await afterTaskDone(t, "chair");
    const p = Queue.taskById(t.id)!.preflight!;
    expect(p).toMatchObject({ status: "checked", openFindings: 1 });
    Store.setFindingAction(p.runId, "F1", "dismiss", "not for this task", "me");
    expect(Queue.taskById(t.id)!.preflight).toMatchObject({ status: "checked", openFindings: 0 });
  });

  test("a reviewer that fails: status failed, the task is still finished", async () => {
    reply("garbage"); set("reviews", ["taskDone"], "/work/t-fail");
    const t = task("/work/t-fail", "L");
    await afterTaskDone(t, "chair");
    expect(Queue.taskById(t.id)).toMatchObject({ preflight: { status: "failed" } });
    expect(Queue.taskById(t.id)!.doneAt).not.toBeNull();
  });
});

describe("a plan saved twice while its review is open", () => {
  const draft = (root = ROOT) => {
    const p = Plans.createPlan({ root, title: "Cap webhooks", request: "Cap webhooks per tenant", visual: false });
    return Plans.patchPlan(p.id, { planMd: "# Plan\nOne" });
  };
  test("the second save starts no second run", () => {
    set("reviews", ["plan"]);
    reply("No findings");
    const saved = draft();
    if (!saved.ok) throw new Error("patch failed");
    const first = afterPlanText(saved.plan, "tester");
    expect(first?.ok).toBe(true);
    const again = Plans.patchPlan(saved.plan.id, { planMd: "# Plan\nTwo" });
    if (!again.ok) throw new Error("patch failed");
    expect(afterPlanText(again.plan, "tester")).toBeNull();
    expect(Store.listRuns({ root: ROOT }).filter((r) => r.id === again.plan.preflightRunId)).toHaveLength(1);
  });

  test("a project that does not review plans: new text is refused with the sentence and no run is made", () => {
    set("reviews", ["pr"], "/work/no-plan-review");
    const saved = draft("/work/no-plan-review");
    if (!saved.ok) throw new Error("patch failed");
    expect(afterPlanText(saved.plan, "tester")).toEqual({ ok: false, error: "Preflight does not review before-launch in /work/no-plan-review." });
    expect(Store.listRuns({ root: "/work/no-plan-review" })).toEqual([]);
  });
});

describe("which plans get a Preflight", () => {
  const sized = (size: "S" | "M" | "L", root = ROOT) => {
    const p = Plans.createPlan({ root, title: "Sized", request: "r", visual: false, size });
    const r = Plans.patchPlan(p.id, { planMd: "# Plan\nOne" });
    if (!r.ok) throw new Error("patch failed");
    return r.plan;
  };
  afterEach(() => { def("sizes").apply("ML", undefined); });

  test("an S plan gets none: not on its own, not when asked for", () => {
    reply("No findings");
    const s = sized("S");
    expect(afterPlanText(s, "tester")).toBeNull();
    expect(preflightPlan(s, "tester")).toMatchObject({ ok: false, error: expect.stringContaining("S plan") });
    expect(s.preflightRunId).toBeNull();
  });

  test("M and L are reviewed by default; with sizes set to L an M plan is skipped on its own and an L plan is not", async () => {
    reply("No findings");
    const m = afterPlanText(sized("M"), "tester");
    expect(m?.ok).toBe(true);
    await (m as { done: Promise<void> }).done;
    // set the way the door sets it: one value for the app
    def("sizes").apply("L", undefined);
    expect(afterPlanText(sized("M"), "tester")).toBeNull();
    const l = afterPlanText(sized("L"), "tester");
    expect(l?.ok).toBe(true);
    await (l as { done: Promise<void> }).done;
  });
});

describe("automatic reviews per plan", () => {
  const fresh = (root: string) => {
    const p = Plans.createPlan({ root, title: "Loop guard", request: "r", visual: false });
    return (md: string) => { const r = Plans.patchPlan(p.id, { planMd: md }); if (!r.ok) throw new Error("patch failed"); return r.plan; };
  };

  test("the first text and the first edit review on their own (one second look); later edits do not, an explicit Preflight still does", async () => {
    set("reviews", ["plan"]);
    reply("No findings");
    const edit = fresh(ROOT);
    const one = afterPlanText(edit("# Plan\nOne"), "tester");
    expect(one?.ok).toBe(true);
    await (one as { done: Promise<void> }).done;
    const two = afterPlanText(edit("# Plan\nTwo"), "tester");
    expect(two?.ok).toBe(true);
    await (two as { done: Promise<void> }).done;
    const three = edit("# Plan\nThree");
    expect(three.autoRuns).toBe(2);
    expect(afterPlanText(three, "tester")).toBeNull();
    expect(preflightPlan(three, "tester")?.ok).toBe(true);
  });

  test("the second looks setting moves the limit: 0 reviews once, 2 reviews three times", async () => {
    reply("No findings");
    try {
      for (const [looks, runs] of [[0, 1], [2, 3]] as const) {
        const root = `/work/looks-${looks}`;
        set("reviews", ["plan"], root); def("secondLooks").apply(looks, undefined);
        const edit = fresh(root);
        let started = 0;
        for (let i = 0; i < 5; i++) {
          const r = afterPlanText(edit(`# Plan\nv${i}`), "tester");
          if (r?.ok) { started++; await r.done; }
        }
        expect(started).toBe(runs);
      }
    } finally { def("secondLooks").apply(1, undefined); }
  });
});

describe("launching a plan", () => {
  const atGo = () => {
    const p = Plans.createPlan({ root: ROOT, title: "Launch me", request: "r", visual: false });
    Plans.patchPlan(p.id, { planMd: "# Plan" });
    Plans.decide(p.id, "go", "tester");
    return Plans.getPlan(p.id)!;
  };
  test("a mint that throws leaves the plan at Go, so it can be launched again", () => {
    const p = atGo();
    expect(() => launchPlan(p, () => { throw new Error("no ticket"); })).toThrow("no ticket");
    expect(Plans.getPlan(p.id)!.state).toBe("go");
    expect(launchPlan(p, () => "t1")).toBe("t1");
    expect(Plans.getPlan(p.id)!.state).toBe("launched");
    expect(launchPlan(p, () => "t2")).toBeNull();
  });
});
