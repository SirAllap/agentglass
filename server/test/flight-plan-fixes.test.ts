/*
 * The holes an adversarial review found in the Pilot engine, each closed and each tested
 * from the side that used to get past: a coordinator lifting its own stops, rewriting the
 * plan to dodge them, saying Go without a review, racing the flying cap, draining the
 * queue around the rules, spending unseen, and holding a project under the wrong key.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";
import { startHarness, type Harness } from "./fixtures/workerHarness.ts";

const REAL_XDG = process.env.XDG_CONFIG_HOME;
const HOME = mkdtempSync(join(tmpdir(), "agx-fixes-"));
process.env.XDG_CONFIG_HOME = HOME;
mkdirSync(join(HOME, "agentglass"), { recursive: true });

const Flight = await import("../src/flightPlan.ts");
const Plans = await import("../src/flightPlanStore.ts");
const Store = await import("../src/preflightStore.ts");
const Budget = await import("../src/flightBudget.ts");
const { db } = await import("../src/db.ts");

const ROOT = "/work/orbit";
const plan = (over: Partial<Parameters<typeof Plans.createPlan>[0]> = {}, md = "# Plan\nChange the footer.") => {
  const p = Plans.createPlan({ root: ROOT, title: "Footer", request: "r", visual: false, ...over });
  Plans.patchPlan(p.id, { planMd: md });
  return Plans.getPlan(p.id)!;
};
const finding = (id: string, severity: string, action: string | null = null) => ({ id, severity, title: "t", quote: "", evidence: "", action, note: null });
const cert = (findings: object[]) => ({ id: "x", createdAt: 0, model: "m", costUsd: 0, capUsd: 1, files: [], mockups: [], skipped: [], read: [], findings }) as never;
/** A Preflight that finished on the plan as it is now. */
const reviewed = (p: { id: string; root: string }, findings: object[] = []) => {
  const run = Store.createRun({ root: p.root, moment: "before-launch", state: "running", by: "t", input: { files: [], mockups: [], root: p.root, model: "sonnet", budgetUsd: 1 } as never });
  Store.finish(run.id, cert(findings));
  Plans.setPreflightRun(p.id, run.id);
  return run;
};

afterEach(() => { db.run(`DELETE FROM flight_plan`); db.run(`DELETE FROM preflight_run`); db.run(`DELETE FROM flight_plan_setting`); Budget.forgetBudget(); });
afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  if (REAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = REAL_XDG;
});

describe("1. a coordinator cannot lift its own stops by answering findings", () => {
  const answer = (runId: string, fid: string, action: string | null, note: string | null, bySeat: boolean) => Store.setFindingAction(runId, fid, action as never, note, bySeat ? "coordinator:chair" : "you", bySeat);

  test("an Ask finding changes only by the person", () => {
    const run = reviewed(plan(), [finding("F1", "major", "ask")]);
    for (const a of ["dismiss", "fix", "contest", null]) expect(answer(run.id, "F1", a, "because", true)).toMatchObject({ ok: false, status: 403 });
    expect(answer(run.id, "F1", "dismiss", "settled in chat", false).ok).toBe(true);
  });

  test("a coordinator may not dismiss a blocker, but may fix it, contest it, or ask", () => {
    const run = reviewed(plan(), [finding("F1", "blocker"), finding("F2", "blocker"), finding("F3", "blocker"), finding("F4", "major")]);
    expect(answer(run.id, "F1", "dismiss", "not a problem", true)).toMatchObject({ ok: false, status: 403 });
    expect(answer(run.id, "F2", "fix", null, true).ok).toBe(true);
    expect(answer(run.id, "F3", "contest", "the cited line is a test fixture", true).ok).toBe(true);
    expect(answer(run.id, "F4", "dismiss", "cosmetic", true).ok).toBe(true);   // a major may be dismissed with a note
    expect(answer(run.id, "F1", "dismiss", "not a problem", false).ok).toBe(true);   // the person may
  });

  test("a coordinator's answer is stamped with its seat", () => {
    const run = reviewed(plan(), [finding("F1", "minor")]);
    const r = answer(run.id, "F1", "fix", null, true);
    expect(r.ok && r.run.certificate!.findings[0]).toMatchObject({ action: "fix", by: "coordinator:chair" });
  });

  test("the stop an Ask finding makes stays after a failed attempt to lift it", () => {
    Store.putSetting(ROOT, "flightPlan.pilot", "autopilot");
    const p = plan();
    const run = reviewed(p, [finding("F1", "major", "ask")]);
    answer(run.id, "F1", "dismiss", "n", true);
    expect(Flight.stopReason(Plans.getPlan(p.id)!)).toBe("ask-finding");
  });
});

describe("2/3. Go needs a review of the plan as it is now", () => {
  const block = (p: ReturnType<typeof plan>) => Flight.reviewBlock(Plans.getPlan(p.id)!);

  test("no run, a running one and a failed one each stop Go with their own sentence", () => {
    const p = plan();
    expect(block(p)).toContain("has not been reviewed");
    const run = Store.createRun({ root: ROOT, moment: "before-launch", state: "running", by: "t", input: { files: [], mockups: [], root: ROOT, model: "sonnet", budgetUsd: 1 } as never });
    Plans.setPreflightRun(p.id, run.id);
    expect(block(p)).toContain("still reading");
    Store.fail(run.id, "no reply");
    expect(block(p)).toContain("did not finish");
  });

  test("a review of the plan as it stands lets Go through; any edit afterwards, to the text or the size, takes it back", () => {
    const p = plan();
    reviewed(p);
    expect(block(p)).toBeNull();
    Plans.patchPlan(p.id, { planMd: "# Plan\nChange the footer and the header." });
    expect(block(p)).toContain("changed after its last Preflight");
    reviewed(p);
    expect(block(p)).toBeNull();
    Plans.patchPlan(p.id, { size: "L" });
    expect(block(p)).toContain("changed after its last Preflight");
  });

  test("an edit made after every finding had its answer is the answer: Go goes through, and the plan and the Go record say edited after Preflight", () => {
    const p = plan();
    const run = reviewed(p, [finding("F1", "blocker"), finding("F2", "minor")]);
    Store.setFindingAction(run.id, "F1", "fix", null, "coordinator:chair", true);
    Store.setFindingAction(run.id, "F2", "contest", "the footer has no such link", "coordinator:chair", true);
    Plans.patchPlan(p.id, { planMd: "# Plan\nChange the footer, and keep its old link." }, "coordinator:chair");
    Plans.patchPlan(p.id, { planMd: "# Plan\nChange the footer, and keep its old link as it is." }, "coordinator:chair");
    expect(Plans.getPlan(p.id)!.editedAfterReview).toBe("answered");
    expect(block(p)).toBeNull();
    const go = Plans.decide(p.id, "go", "you");
    expect(go.ok && go.plan.decision).toMatchObject({ by: "you", editedAfterPreflight: true });
    // A Go on the text Preflight read carries no such mark.
    const q = plan(); reviewed(q, [finding("F1", "minor", "fix")]);
    const clean = Plans.decide(q.id, "go", "you");
    expect(clean.ok && clean.plan.decision?.editedAfterPreflight).toBeUndefined();
  });

  test("a finding still open at Go, or taken back after the edit, refuses it", () => {
    const p = plan();
    reviewed(p, [finding("F1", "blocker", "fix"), finding("F2", "major")]);
    Plans.patchPlan(p.id, { planMd: "# Plan\nChange the footer and the header." });
    expect(block(p)).toContain("changed after its last Preflight");
    const q = plan();
    const r2 = reviewed(q, [finding("F1", "blocker", "fix")]);
    Plans.patchPlan(q.id, { planMd: "# Plan\nChange the footer and the header." });
    expect(block(q)).toBeNull();
    Store.setFindingAction(r2.id, "F1", null, null, "you");
    expect(block(q)).toContain("changed after its last Preflight");
  });

  test("an edit made while a finding was open stays refused after the finding is answered; so does an edit after a Go, and an edit after a clean run", () => {
    const p = plan();
    const run = reviewed(p, [finding("F1", "blocker")]);
    Plans.patchPlan(p.id, { planMd: "# Plan\nChange the footer and the header." });
    Store.setFindingAction(run.id, "F1", "fix", null, "coordinator:chair", true);
    Plans.patchPlan(p.id, { planMd: "# Plan\nChange the footer and the header, both." });
    expect(Plans.getPlan(p.id)!.editedAfterReview).toBe("open");
    expect(block(p)).toContain("changed after its last Preflight");
    // A fresh Preflight clears the mark.
    reviewed(p);
    expect(Plans.getPlan(p.id)!.editedAfterReview).toBeNull();

    const q = plan();
    reviewed(q, [finding("F1", "minor", "fix")]);
    expect(Plans.decide(q.id, "go", "you").ok).toBe(true);
    Plans.patchPlan(q.id, { planMd: "# Plan\nChange the footer after Go." });
    expect(block(q)).toContain("changed after its last Preflight");

    const c = plan();
    reviewed(c);
    Plans.patchPlan(c.id, { planMd: "# Plan\nChange the footer after a clean run." });
    expect(block(c)).toContain("changed after its last Preflight");
  });

  test("an answered edit never excuses a change of size", () => {
    const p = plan();
    reviewed(p, [finding("F1", "minor", "fix")]);
    Plans.patchPlan(p.id, { planMd: "# Plan\nChange the footer, answered.", size: "L" });
    expect(block(p)).toContain("changed after its last Preflight");
  });

  test("an S plan, an M plan when only L is reviewed, and a project that does not review plans are not held to it", () => {
    expect(block(plan({ size: "S" }))).toBeNull();
    expect(block(plan({ size: "M" }))).toContain("has not been reviewed");
    Store.putSetting(APP(), "flightPlan.preflight.sizes", "L");
    expect(block(plan({ size: "M" }))).toBeNull();
    expect(block(plan({ size: "L" }))).toContain("has not been reviewed");
    Store.putSetting(ROOT, "flightPlan.preflight.reviews", []);
    expect(block(plan({ size: "L" }))).toBeNull();
  });
});
const APP = () => Store.APP;

describe("2b. the builder's real diff", () => {
  const sh = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", "-c", "user.email=a@b.c", "-c", "user.name=orbit", ...a], { cwd }).stdout.toString().trim();

  test("a sensitive path in what the builder changed stops Integrate; a plain one does not", () => {
    const repo = mkdtempSync(join(tmpdir(), "agx-diff-"));
    try {
      sh(repo, "init", "-q", "-b", "main"); writeFileSync(join(repo, "a.ts"), "1"); sh(repo, "add", "."); sh(repo, "commit", "-q", "-m", "one");
      const from = sh(repo, "rev-parse", "HEAD");
      sh(repo, "checkout", "-q", "-b", "flight-plan/footer"); writeFileSync(join(repo, "a.ts"), "2"); sh(repo, "commit", "-q", "-am", "plain");
      const p = plan({ root: repo });
      const at = { ...Plans.getPlan(p.id)!, launched: { at: 1, title: "Footer", branch: "flight-plan/footer", from } };
      expect(Flight.sensitiveDiff(at)).toBeNull();
      mkdirSync(join(repo, "db", "migrations"), { recursive: true });
      writeFileSync(join(repo, "db", "migrations", "0001_add_thing.sql"), "x"); sh(repo, "add", "."); sh(repo, "commit", "-q", "-m", "migration");
      expect(Flight.sensitiveDiff(at)).toBe("db/migrations/0001_add_thing.sql");
      expect(Flight.builderDiff(at)).toEqual(["a.ts", "db/migrations/0001_add_thing.sql"]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("a plan with no recorded start has no diff to read", () => {
    expect(Flight.builderDiff({ ...plan(), launched: null })).toEqual([]);
  });
});

describe("5. the queue is not a way round the rules", () => {
  test("a hold key is the project's root, however the path is spelled", () => {
    Store.putSetting(Flight.heldKey("/work/orbit/"), "flightPlan.held", true);
    expect(Flight.isHeld("/work/orbit")).toBe(true);
    expect(Flight.isHeld("/work/orbit/")).toBe(true);
    expect(Flight.isHeld("/work/other")).toBe(false);
  });
});

describe("6. the budget", () => {
  test("a turn counts when it ran in a launched plan's tree, with or without the branch", () => {
    const rows = [
      { branch: "feat/renamed", dir: "/work/orbit-fp-footer/web", session_id: "a", usd: 2, last_ts: 1 },
      { branch: "", dir: "/work/orbit-fp-footer", session_id: "b", usd: 1, last_ts: 1 },
      { branch: "flight-plan/other", dir: "/work/elsewhere", session_id: "c", usd: 0.5, last_ts: 1 },
      { branch: "feat/mine", dir: "/work/orbit-fp-footer-2", session_id: "d", usd: 9, last_ts: 1 },
    ];
    const total = Budget.spentSince(0, { rows: () => rows, preflight: () => 0.25, roots: () => [ROOT], trees: () => ["/work/orbit-fp-footer"] });
    expect(total).toBeCloseTo(3.75);
  });

  test("a Go reads the books as they are: the cache never answers it", () => {
    Store.putSetting(Store.APP, "flightPlan.budget.dailyUsd", 5);
    Budget.forgetBudget();
    expect(Budget.budgetState().reached).toBeNull();            // cached: nothing spent
    const run = Store.createRun({ root: ROOT, moment: "before-launch", state: "running", by: "t", input: { files: [], mockups: [], root: ROOT, model: "sonnet", budgetUsd: 1 } as never });
    Store.finish(run.id, { ...(cert([]) as object), costUsd: 9 } as never);
    expect(Budget.budgetState().reached).toBeNull();            // a view still reads the cache
    Store.putSetting(ROOT, "flightPlan.pilot", "autopilot");
    const p = plan(); reviewed(p);
    expect(Flight.seatMayFly(Plans.getPlan(p.id)!)).toMatchObject({ ok: false, error: expect.stringContaining("budget") });
  });
});

const have = !!Bun.which("tmux") && !!Bun.which("python3") && !!Bun.which("git");
describe.skipIf(!have)("a coordinator on a booted server, in a real repository", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness("fpfix");
    for (const a of [["init", "-q", "-b", "main"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"]]) Bun.spawnSync(["git", ...a], { cwd: h.dir });
    await h.asPerson("/settings/door", { id: "flightPlan.enabled", value: true });
    await h.asPerson("/settings/door", { id: "flightPlan.pilot", value: "autopilot", root: h.dir });
    await h.asPerson("/settings/door", { id: "flightPlan.preflight.reviews", value: [], root: h.dir });
  }, SERVER_BOOT_MS);
  afterAll(async () => { if (h) await h.stop(); });

  const seat = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(h.base + path, { method, headers: { Authorization: `Bearer ${h.seatToken}`, "Content-Type": "application/json", Origin: h.base }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const ready = async (size = "M", md = "# Plan\nChange the footer text.") => {
    const id = (await seat("POST", "/flight-plan/plans", { root: h.dir, request: "footer", size })).body.plan.id as string;
    expect((await seat("PATCH", `/flight-plan/plans/${id}`, { plan_md: md })).status).toBe(200);
    return id;
  };
  const planOf = async (id: string) => (await h.read(`/flight-plan/plans/${id}`, h.seatToken)).body;

  test("a coordinator raises a plan's size and is refused lowering it", async () => {
    const id = await ready("M");
    expect((await seat("PATCH", `/flight-plan/plans/${id}`, { size: "S" })).status).toBe(403);
    expect((await seat("PATCH", `/flight-plan/plans/${id}`, { size: "L" })).status).toBe(200);
    expect((await seat("PATCH", `/flight-plan/plans/${id}`, { size: "M" })).body.error).toContain("never lowers");
  });

  test("Go waits for a review when the project reviews plans", async () => {
    await h.asPerson("/settings/door", { id: "flightPlan.preflight.reviews", value: ["plan"], root: h.dir });
    try {
      const id = await ready("M");
      const go = await seat("POST", `/flight-plan/plans/${id}/go`, {});
      expect(go.status).toBe(409);
      expect(go.body.error).toContain("Go has to wait");
      const person = await h.asPerson(`/flight-plan/plans/${id}/go`, {}) as any;
      expect(person.ok).toBe(false);
    } finally { await h.asPerson("/settings/door", { id: "flightPlan.preflight.reviews", value: [], root: h.dir }); }
  });

  test("1. a coordinator's extra Preflight press in Autopilot is refused past the ceiling per plan; the person's is not", async () => {
    const id = await ready();
    const { Database } = await import("bun:sqlite");
    const db2 = new Database(join(h.dir, "w.db")); db2.query(`UPDATE flight_plan SET review_rounds = 9 WHERE id = ?`).run(id); db2.close();
    const r = await seat("POST", `/flight-plan/plans/${id}/preflight`, {});
    expect(r.status).toBe(403);
    expect(r.body.error).toContain(`${Flight.AUTOPILOT_PREFLIGHTS_MAX} Preflights in Autopilot`);
  });

  test("in Autopilot only the seat's press gets past the second looks: another agent's is refused at them", async () => {
    const id = await ready();
    const { Database } = await import("bun:sqlite");
    const db2 = new Database(join(h.dir, "w.db")); db2.query(`UPDATE flight_plan SET review_rounds = 2 WHERE id = ?`).run(id); db2.close();
    const other = await h.asPerson(`/flight-plan/plans/${id}/preflight`, {}, { "X-Agentglass-Agent": "builder-orbit" });
    expect(other.status).toBe(403);
    expect(other.error).toContain("second looks are used");
    // The seat passes the count; this project reviews nothing, so the run itself is refused after it.
    const own = await seat("POST", `/flight-plan/plans/${id}/preflight`, {});
    expect(own.status).toBe(409);
    expect(own.body.error).toContain("does not review");
  });

  test("presses at once start one run and never pass the ceiling", async () => {
    const id = await ready();
    const { Database } = await import("bun:sqlite");
    const db2 = new Database(join(h.dir, "w.db")); db2.query(`UPDATE flight_plan SET review_rounds = ? WHERE id = ?`).run(Flight.AUTOPILOT_PREFLIGHTS_MAX - 1, id); db2.close();
    await h.asPerson("/settings/door", { id: "flightPlan.preflight.reviews", value: ["plan"], root: h.dir });
    try {
      // Every body is held until all six requests are in, so each one has read the plan and waits in the same await before any goes on.
      let open!: () => void;
      const gate = new Promise<void>((res) => { open = res; });
      const press = async () => {
        const body = new ReadableStream({ async start(c) { await gate; c.enqueue(new TextEncoder().encode("{}")); c.close(); } });
        const r = await fetch(h.base + `/flight-plan/plans/${id}/preflight`, { method: "POST", body, duplex: "half", headers: { Authorization: `Bearer ${h.seatToken}`, "Content-Type": "application/json", Origin: h.base } } as RequestInit);
        return { status: r.status, body: (await r.json()) as Record<string, any> };
      };
      const pending = Array.from({ length: 6 }, press);
      await Bun.sleep(300);
      open();
      const all = await Promise.all(pending);
      const runs = new Set(all.filter((r) => r.status === 200).map((r) => r.body.run.id));
      expect(runs.size).toBe(1);
      expect(all.every((r) => r.status === 200 || r.status === 403)).toBe(true);
      expect((await planOf(id)).plan.reviewRounds).toBe(Flight.AUTOPILOT_PREFLIGHTS_MAX);
    } finally { await h.asPerson("/settings/door", { id: "flightPlan.preflight.reviews", value: [], root: h.dir }); }
  });

  test("a hold named by a folder inside the project, with a trailing slash, holds the project", async () => {
    mkdirSync(join(h.dir, "packages", "web"), { recursive: true });
    const r = await h.asPerson("/flight-plan/hold", { root: join(h.dir, "packages", "web") + "/" }) as any;
    expect(r.held).toBe(true);
    const id = await ready();
    expect((await seat("POST", `/flight-plan/plans/${id}/go`, {})).body.error).toContain("held");
    expect((await h.asPerson("/flight-plan/resume", { root: h.dir })).ok).toBe(true);
    expect((await planOf(id)).held).toBe(false);
  });

  test("two Go presses at once launch one builder and queue the other when one may fly", async () => {
    await h.asPerson("/settings/door", { id: "flightPlan.maxFlying", value: 1, root: h.dir });
    const [a, b] = [await ready(), await ready()];
    const [ra, rb] = await Promise.all([seat("POST", `/flight-plan/plans/${a}/go`, {}), seat("POST", `/flight-plan/plans/${b}/go`, {})]);
    const results = [ra.body, rb.body];
    expect(results.filter((r) => r.queued === false && !r.launchError).length).toBe(1);
    expect(results.filter((r) => r.queued === true).length).toBe(1);
    const states = [(await planOf(a)).plan, (await planOf(b)).plan].map((p) => `${p.state}${p.queued ? "+queued" : ""}`).sort();
    expect(states).toEqual(["go+queued", "launched"]);
  });

  test("the list says what the builder's tab is doing: live, then gone with the time first seen, and who holds the slot a queued plan waits for", async () => {
    /* Earlier tests leave builders in the air on this server: the cap leaves room for exactly one more. */
    const inAir = (await h.read(`/flight-plan/plans?root=${encodeURIComponent(h.dir)}`, h.seatToken)).body.plans.filter((x: Record<string, any>) => x.state === "launched" && !x.landed).length;
    await h.asPerson("/settings/door", { id: "flightPlan.maxFlying", value: inAir + 1, root: h.dir });
    const [a, b] = [await ready(), await ready()];
    await seat("POST", `/flight-plan/plans/${a}/go`, {});
    await seat("POST", `/flight-plan/plans/${b}/go`, {});
    const wire = async () => Object.fromEntries(((await h.read(`/flight-plan/plans?root=${encodeURIComponent(h.dir)}`, h.seatToken)).body.plans as Record<string, any>[]).map((x) => [x.id, x]));
    const first = (await wire())[a]!;
    expect(first.builder).toBe("live");
    expect(first.goneAt).toBeNull();
    expect(first.stateSince).toBe(first.launched.at);
    expect(typeof first.reviewedVersion === "number" || first.reviewedVersion === null).toBe(true);
    const waiting = (await wire())[b]!;
    expect(waiting.queued).toBe(true);
    expect(waiting.slotHolders.map((x: { id: string }) => x.id)).toContain(a);
    expect(waiting.builder).toBeUndefined();
    // The tab closes (another session keeps the tmux server up): gone, stamped once, and no longer holding the slot.
    await h.handTab(h.dir);
    Bun.spawnSync(["tmux", "-L", `agx-fpfix-${process.pid}`, ...TMUX_ISOLATED, "kill-window", "-t", first.launched.window], { env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR, TMUX: "" } });
    const gone = (await wire())[a]!;
    expect(gone.builder).toBe("gone");
    expect(typeof gone.goneAt).toBe("number");
    await Bun.sleep(15);
    expect((await wire())[a]!.goneAt).toBe(gone.goneAt);
    expect((await wire())[b]!.slotHolders.map((x: { id: string }) => x.id)).not.toContain(a);
    expect(gone.stopReason).toBeNull();
  });

  /** A builder's work lands: one commit in its tree, fast-forwarded into the project's main. */
  const land = async (id: string) => {
    const l = (await planOf(id)).plan.launched;
    const git = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd });
    writeFileSync(join(l.worktree, `${id}.txt`), "done");
    git(l.worktree, "add", "."); git(l.worktree, "commit", "-q", "-m", "work");
    expect(git(h.dir, "merge", "-q", "--ff-only", l.branch).exitCode).toBe(0);
  };
  const fly = async (id: string) => seat("POST", `/flight-plan/plans/${id}/go`, {});
  const stateOf = async (id: string) => { const p = (await planOf(id)).plan; return `${p.state}${p.queued ? "+queued" : ""}`; };

  test("5. a queued plan is checked again when a builder lands: the pilot narrowed meanwhile, so it stays at Go, un-queued", async () => {
    const listed = (await seat("GET", "/flight-plan/plans")).body.plans as any[];
    const flying = listed.find((p) => p.state === "launched" && !p.landed)!;
    const queued = listed.find((p) => p.state === "go" && p.queued)!;
    await h.asPerson("/settings/door", { id: "flightPlan.pilot", value: "manual", root: h.dir });
    await land(flying.id);
    await seat("GET", "/flight-plan/plans");                       // the look that sees it landed also drains
    await h.until(async () => (await stateOf(queued.id)) === "go" ? true : undefined);
    await h.asPerson("/settings/door", { id: "flightPlan.pilot", value: "autopilot", root: h.dir });
  });

  test("5. and launches the next one when it still may: landed, room, rules intact", async () => {
    const [c, d] = [await ready(), await ready()];
    expect((await fly(c)).body.queued).toBe(false);
    expect((await fly(d)).body.queued).toBe(true);
    await land(c);
    await seat("GET", "/flight-plan/plans");
    await h.until(async () => (await stateOf(d)) === "launched" ? true : undefined);
  });

  test("8. a launched builder always has its worktree and its own scratch directory in the environment", async () => {
    const p = ((await seat("GET", "/flight-plan/plans?state=launched")).body.plans as any[]).find((x) => x.launched?.window)!;
    const ls = Bun.spawnSync(["tmux", "-L", `agx-fpfix-${process.pid}`, ...TMUX_ISOLATED, "list-panes", "-a", "-F", "#{window_id} #{pane_pid}"], { env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR, TMUX: "" } }).stdout.toString();
    const pid = ls.split("\n").map((l) => l.split(" ")).find(([w]) => w === p.launched.window)?.[1];
    expect(pid).toBeDefined();
    const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    expect(env).toContain(`AGENTGLASS_BUILDER_WORKTREE=${p.launched.worktree}`);
    expect(env.find((e) => e.startsWith("TMPDIR="))).toMatch(/agx-builder-/);
  });

  test("7. a builder's own CLI is refused settings and rules writes; any other agent is not", async () => {
    const p = ((await seat("GET", "/flight-plan/plans?state=launched")).body.plans as any[])[0]!;
    const door = (extra: Record<string, string>) => fetch(h.base + "/settings/door", { method: "POST", headers: { Authorization: `Bearer ${h.seatToken}`, "Content-Type": "application/json", ...extra }, body: JSON.stringify({ id: "flightPlan.maxFlying", value: 1, root: h.dir }) });
    const asBuilder = await door({ "x-agentglass-builder": p.launched.worktree });
    expect(asBuilder.status).toBe(403);
    expect(((await asBuilder.json()) as any).error).toContain("builder does not change settings");
    expect((await door({})).status).not.toBe(403);
    expect((await door({ "x-agentglass-builder": "/work/never-launched" })).status).not.toBe(403);
    const rules = await fetch(h.base + "/agent-rules", { method: "POST", headers: { Authorization: `Bearer ${h.seatToken}`, "Content-Type": "application/json", "x-agentglass-builder": p.launched.worktree }, body: JSON.stringify({ root: h.dir, match: "Bash(ls:*)", setting: "never" }) });
    expect(rules.status).toBe(403);
  });

  test("9. any agent can hold a project it can see, and not one the server does not have open", async () => {
    const hold = (root: string) => fetch(h.base + "/flight-plan/hold", { method: "POST", headers: { Authorization: `Bearer ${h.seatToken}`, "Content-Type": "application/json", Origin: h.base }, body: JSON.stringify({ root }) });
    expect((await hold(h.dir)).status).toBe(200);
    expect((await h.asPerson("/flight-plan/resume", { root: h.dir })).ok).toBe(true);
    const away = await fetch(h.base + "/flight-plan/hold", { method: "POST", headers: { Authorization: "Bearer machine-token-example", "Content-Type": "application/json", Origin: h.base, "x-agentglass-agent": "helper" }, body: JSON.stringify({ root: "/work/not-open-here" }) });
    expect(away.status).toBe(400);
  });
});
