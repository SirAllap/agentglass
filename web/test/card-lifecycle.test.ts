/*
 * The card's lifecycle join: stages, tiles, timeline and next action come only from what was recorded, and what nothing recorded
 * is left out (and named as a gap) rather than shown as a number.
 */
import { describe, expect, test } from "bun:test";
import { cardLifecycle, movesOf, nextOf, spanOf, stagesOf, timelineOf, type LifecycleInput, type PlanLite } from "../src/lib/cardLifecycle.ts";
import type { CardEvent } from "../../shared/providers.ts";

const H = 3_600_000;
const NOW = 1_000 * H;
const move = (at: number, status: string, from?: string): CardEvent => ({ at, kind: "status", status, ...(from ? { from } : {}) });
const plan = (o: Partial<PlanLite> = {}): PlanLite => ({ id: "p1", title: "Rotate session tokens", state: "launched", createdAt: NOW - 30 * H, reviewRounds: 2, ...o });
const base = (o: Partial<LifecycleInput> = {}): LifecycleInput => ({
  now: NOW, status: "In progress", statusKind: "open", moves: [], plans: [], runs: [], sessions: [], pr: null, checks: null, ...o,
});
const ids = (l: ReturnType<typeof cardLifecycle>, k: "tiles" | "stages") => l[k].map((x) => x.id);

describe("a card nothing recorded anything for", () => {
  const life = cardLifecycle(base());
  test("has no tile, and each missing one is a gap", () => {
    expect(life.tiles).toEqual([]);
    expect(life.gaps.some((g) => g.startsWith("Cost"))).toBe(true);
    expect(life.gaps.some((g) => g.startsWith("Cycle time"))).toBe(true);
    expect(life.gaps.some((g) => g.startsWith("Deploy"))).toBe(true);
  });
  test("never draws a Deploy stage, and every other stage is still to come", () => {
    expect(ids(life, "stages")).toEqual(["picked", "plan", "session", "branch", "pr", "merge"]);
    expect(life.stages.every((s) => s.state === "todo")).toBe(true);
  });
  test("offers to send the card to a terminal", () => {
    expect(life.next.kind).toBe("send");
  });
});

describe("a card with a plan, a live worker, a pull request and checks", () => {
  const input = base({
    moves: [{ at: NOW - 40 * H, kind: "created" }, move(NOW - 36 * H, "In progress", "To do")],
    plans: [plan({ decision: { by: "you", at: NOW - 28 * H }, launched: { at: NOW - 20 * H, branch: "ORBIT-1042-rotate" }, lastReport: { line: "Writing rotation", at: NOW - 2 * H } })],
    runs: [{ id: "r1", createdAt: NOW - 29 * H, state: "done", certificate: { costUsd: 0.4, findings: [{ severity: "blocker" }, { severity: "nit" }] } }],
    sessions: [{ sessionId: "s1", title: "builder-01", status: "working", cost: 1.84, model: "sonnet", lastSeen: NOW, live: true }],
    pr: { number: 412, state: "OPEN", url: "https://github.com/orbit/example/pull/412" },
    checks: { total: 10, success: 8, failure: 0, pending: 2, allDone: false, at: NOW - H },
  });
  const life = cardLifecycle(input);
  test("stages run Picked to PR, the last reached one is current", () => {
    const s = Object.fromEntries(life.stages.map((x) => [x.id, x.state]));
    expect(s).toMatchObject({ picked: "done", plan: "done", session: "done", branch: "done", pr: "current", merge: "todo" });
  });
  test("tiles are measured: cost adds the sessions and the known review cost, checks count, rounds sum", () => {
    const t = Object.fromEntries(life.tiles.map((x) => [x.id, x.value]));
    expect(t.cost).toBe("$2.24");
    expect(t.checks).toBe("8/10");
    expect(t.rounds).toBe("2");
    expect(t.cycle).toBe("1d 12h");
  });
  test("time in stage is absent when the current stage has no start, and named as a gap", () => {
    expect(ids(life, "tiles")).not.toContain("stage");
    expect(life.gaps.some((g) => g.startsWith("Time in stage"))).toBe(true);
  });
  test("the next action is the worker", () => {
    expect(life.next).toMatchObject({ kind: "open-worker", label: "Open live worker", tone: "ok" });
  });
  test("the timeline is in time order, rows that only know now come last, each with its role", () => {
    const rows = life.timeline;
    const timed = rows.filter((r) => r.at !== null).map((r) => r.at!);
    expect(timed).toEqual([...timed].sort((a, b) => a - b));
    expect(rows.findIndex((r) => r.at === null)).toBeGreaterThan(rows.map((r) => r.at !== null).lastIndexOf(true));
    const roles = new Set(rows.map((r) => r.role));
    for (const r of ["planner", "builder", "reviewer", "verifier"] as const) expect(roles.has(r)).toBe(true);
    expect(rows.find((r) => r.title === "Preflight review")?.detail).toBe("2 findings, 1 blocking");
  });
});

describe("failures and ends", () => {
  test("a failing check turns the tile red and the next action to the pull request", () => {
    const l = cardLifecycle(base({ pr: { number: 7, state: "OPEN", url: "u" }, checks: { total: 5, success: 3, failure: 2, pending: 0, allDone: true, at: NOW } }));
    expect(l.tiles.find((t) => t.id === "checks")).toMatchObject({ value: "3/5", tone: "bad" });
    expect(l.next).toMatchObject({ kind: "open-pr", tone: "bad" });
  });
  test("a merged pull request completes the strip through Merge and says nothing is left", () => {
    const l = cardLifecycle(base({ statusKind: "done", status: "Done", pr: { number: 9, state: "MERGED", url: "u" }, plans: [plan({ launched: { at: NOW - 5 * H, branch: "b" }, decision: { by: "you", at: NOW - 9 * H }, landedAt: NOW - H })] }));
    expect(l.stages.find((s) => s.id === "merge")?.state).toBe("done");
    expect(l.next.kind).toBe("none");
    expect(l.timeline.some((r) => r.role === "landing")).toBe(true);
  });
  test("a stage with no evidence under a later one is skipped, not made up", () => {
    const l = cardLifecycle(base({ pr: { number: 3, state: "OPEN", url: "u" } }));
    const s = Object.fromEntries(l.stages.map((x) => [x.id, x.state]));
    expect(s).toMatchObject({ plan: "skipped", session: "skipped", pr: "current" });
  });
  test("a declined plan is a red planner row with its reason", () => {
    const rows = timelineOf(base({ plans: [plan({ state: "no-go", decision: { by: "you", at: NOW - H, reason: "Too wide" } })] }));
    expect(rows.find((r) => r.title === "Plan declined")).toMatchObject({ role: "planner", tone: "bad", detail: "Too wide" });
  });
  test("a plan that waits for Go, or asks a question, outranks a live worker", () => {
    const live = { sessionId: "s", title: "builder-01", status: "working", cost: 0, model: null, lastSeen: NOW, live: true };
    expect(nextOf(base({ sessions: [live], plans: [plan({ state: "ready" })] })).kind).toBe("open-plan");
    expect(nextOf(base({ sessions: [live], plans: [plan({ question: { text: "Which table?" } })] })).body).toBe("Which table?");
  });
  test("a worker that waits asks for the person", () => {
    const n = nextOf(base({ sessions: [{ sessionId: "s", title: "builder-01", status: "waiting", cost: 0, model: null, lastSeen: NOW, live: true }] }));
    expect(n).toMatchObject({ title: "The worker needs you", tone: "warn" });
  });
});

describe("QA is the statuses the workflow map names", () => {
  const qaStatuses = ["Acceptance"];
  test("a move into a mapped status marks QA with its time", () => {
    const l = cardLifecycle(base({ qaStatuses, status: "Acceptance", moves: [move(NOW - 3 * H, "Acceptance", "Review")], pr: { number: 1, state: "OPEN", url: "u" } }));
    expect(l.stages.find((s) => s.id === "qa")).toMatchObject({ state: "current", at: NOW - 3 * H });
    expect(l.tiles.find((t) => t.id === "stage")?.value).toBe("3h");
  });
  test("a status that only reads like testing is not QA when it is not mapped", () => {
    expect(stagesOf(base({ qaStatuses, status: "Testing lab", moves: [move(NOW - H, "Testing lab")] })).find((s) => s.id === "qa")?.state).toBe("todo");
  });
  test("nothing mapped: the QA stage is hidden and named as a gap, never guessed", () => {
    const l = cardLifecycle(base({ status: "Acceptance", moves: [move(NOW - H, "Acceptance")] }));
    expect(l.stages.some((s) => s.id === "qa")).toBe(false);
    expect(l.gaps.some((g) => g.startsWith("QA: no status is mapped"))).toBe(true);
  });
});

describe("helpers", () => {
  test("spans", () => {
    expect([spanOf(0), spanOf(30_000), spanOf(12 * 60_000), spanOf(17 * H), spanOf(51 * H), spanOf(48 * H)]).toEqual(["0m", "now", "12m", "17h", "2d 3h", "2d"]);
  });
  test("moves keep only status changes, oldest first", () => {
    const m = movesOf([move(5, "B"), { at: 1, kind: "created" }, { at: 3, kind: "change", text: "x" } as CardEvent, move(2, "A")]);
    expect(m.map((x) => x.status)).toEqual(["A", "B"]);
  });
});
