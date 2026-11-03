/*
 * FLIGHT PLAN, PILOT: what the strip says, who owns each station, what waits on
 * the person. Plain functions, so plain tests; the wiring of the event that
 * replaced the 120 s poll is asserted against source at the bottom.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  effectivePilot, flightGroups, handledChip, needsYou, stationsFor, stopCopy, stripFor,
  type FlightItem, type PilotQuestion, type PilotSnapshot, type StripCounts,
} from "../src/lib/flightPilot.ts";
import type { Plan, Run } from "../src/lib/flightPlan.ts";

const NOW = new Date(2026, 9, 28, 12, 0).getTime();
const plan = (over: Partial<Plan> = {}): Plan => ({
  id: "p1", root: "/work/acme/orbit", title: "Retry webhooks on 502", request: "", visual: false, planMd: "# Plan", planBytes: 6,
  mockups: [], state: "ready", decision: null, preflightRunId: "r1", taskId: "ORBIT-1042", autoRuns: 0, launched: null, reviewRounds: 0, stopReason: null, question: null, queued: false, createdBy: null, landedAt: null, lastReport: null, size: "M",
  createdAt: NOW - 9e5, updatedAt: NOW - 6e5, ...over,
});
const run = (state: Run["state"] = "done"): Run => ({
  id: "r1", createdAt: NOW - 8e5, root: "/work/acme/orbit", moment: "plan", state, requestedBy: "coordinator",
  input: {}, certificate: null, error: null, taskId: null,
});
const q = (answered = false): PilotQuestion => ({
  id: "q1", planId: "p1", askedBy: "coordinator", askedAt: NOW, text: "Where does the retry count show?", choices: [],
  answer: answered ? { by: "person", text: "card", at: NOW } : null,
});
const item = (over: Partial<FlightItem> & { plan?: Plan } = {}): FlightItem => ({ plan: plan(), run: run(), ...over });
const snap = (over: Partial<PilotSnapshot> = {}): PilotSnapshot => ({
  pilot: "copilot", held: false, seat: "orbit seat",
  budget: { dailyUsd: 5, weeklyUsd: 20, todayUsd: 1.2, weekUsd: 6.8 }, flying: 2, budgetReached: null, ...over,
});
const counts = (over: Partial<StripCounts> = {}): StripCounts => ({ flying: 2, waiting: 1, live: 2, onGround: 3, handledToday: 9, askedToday: 1, goReady: 1, needAnswers: 0, findingsToAnswer: 0, ...over });

describe("needsYou", () => {
  test("a question counts, an answered one does not, findings never do", () => {
    const r = needsYou([item({ plan: plan({ state: "draft" }), run: null, questions: [q()] }), item({ plan: plan({ id: "p2", state: "draft" }), run: null, questions: [q(true)] })]);
    expect(r).toEqual({ questions: 1, go: 0, total: 1, label: "needs you · 1 question" });
    const run0 = { ...run(), certificate: { findings: [{ id: "f1", severity: "blocker", action: null }] } } as unknown as Run;
    expect(needsYou([item({ plan: plan({ state: "draft" }), run: run0 })]).total).toBe(0);
  });
  test("plan started, Preflight running and landed are not needs-you", () => {
    expect(needsYou([item({ plan: plan({ state: "draft" }), run: null }), item({ run: run("running") }), item({ plan: plan({ state: "launched" }), landedAt: NOW })]).total).toBe(0);
  });
  test("a Go card counts in Manual and Co-pilot always", () => {
    expect(needsYou([item()], snap({ pilot: "manual" })).go).toBe(1);
    expect(needsYou([item()], snap({ pilot: "copilot" })).label).toBe("needs you · 1 Go");
  });
  test("in Autopilot a Go card counts only with a stop reason, held or budget reached", () => {
    const auto = snap({ pilot: "autopilot" });
    expect(needsYou([item()], auto).go).toBe(0);
    expect(needsYou([item({ stopReason: "large" })], auto).go).toBe(1);
    expect(needsYou([item()], snap({ pilot: "autopilot", held: true })).go).toBe(1);
    expect(needsYou([item()], snap({ pilot: "autopilot", budgetReached: "day" })).go).toBe(1);
  });
  test("nobody seated: Autopilot behaves as Manual, so Go is the person's", () => {
    expect(needsYou([item()], snap({ pilot: "autopilot", seat: null })).go).toBe(1);
  });
  test("labels pluralise and join", () => {
    const two = [item({ plan: plan({ state: "draft" }), run: null, questions: [q(), q()] })];
    expect(needsYou(two).label).toBe("needs you · 2 questions");
    expect(needsYou([...two, item()]).label).toBe("needs you · 2 questions, 1 Go");
    expect(needsYou([item({ plan: plan({ state: "draft" }), run: null, questions: [q()] }), item()]).label).toBe("needs you · 1 question, 1 Go");
    expect(needsYou([]).label).toBe("");
  });
});

describe("stripFor, per mode", () => {
  test("Autopilot: Hold, and the sentence of the mockup", () => {
    const s = stripFor(snap({ pilot: "autopilot" }), counts());
    expect(s.mode).toBe("autopilot");
    expect(s.badge).toBe("Autopilot");
    expect(s.sentence).toBe("2 builders live, 1 waiting on you, 3 on the ground. On the ground costs nothing. The orchestrator handled 9 findings today and asked you once.");
    expect(s.button).toEqual({ id: "hold", label: "Hold", tone: "danger" });
    expect(s.meters).toEqual({ today: { used: 1.2, cap: 5 }, week: { used: 6.8, cap: 20 } });
  });
  test("Autopilot speaks in singulars and twice", () => {
    expect(stripFor(snap({ pilot: "autopilot" }), counts({ handledToday: 1, askedToday: 2 })).sentence).toContain("handled 1 finding today and asked you twice.");
  });
  test("Co-pilot: Review Go with the count", () => {
    const s = stripFor(snap(), counts({ goReady: 1 }));
    expect(s.mode).toBe("copilot");
    expect(s.sentence).toBe("1 ready for your Go. Written, reviewed and answered by the orchestrator; nothing left but your word. 2 builders live, 3 on the ground.");
    expect(s.button).toEqual({ id: "review-go", label: "Review Go", count: 1, tone: "go" });
    expect(stripFor(snap(), counts({ goReady: 0 })).button.disabled).toBe(true);
  });
  test("Manual: Open next, and who waits for what", () => {
    const s = stripFor(snap({ pilot: "manual" }), counts({ needAnswers: 1, findingsToAnswer: 3, goReady: 1 }));
    expect(s.mode).toBe("manual");
    expect(s.sentence).toBe("You fly. 2 plans wait for you: 1 needs answers to 3 findings, 1 is ready for Go. 2 builders live, 3 on the ground.");
    expect(s.button).toEqual({ id: "open-next", label: "Open next", tone: "plain" });
  });
  test("Held beats every mode, and offers the way out", () => {
    for (const pilot of ["manual", "copilot", "autopilot"] as const) {
      const s = stripFor(snap({ pilot, held: true, budgetReached: "day" }), counts());
      expect(s.mode).toBe("held");
      expect(s.badge).toBe("Autopilot held");
      expect(s.sentence).toBe("Held. No new Go. Builders were told to stop at their next safe point; their worktrees are kept. 2 builders live, 3 on the ground.");
      expect(s.button.id).toBe("resume");
      expect(s.secondary).toEqual({ id: "to-copilot", label: "Hand to Co-pilot" });
    }
  });
  test("Budget reached drops Autopilot to Co-pilot until tomorrow / next week", () => {
    const day = stripFor(snap({ pilot: "autopilot", budgetReached: "day", budget: { dailyUsd: 5, weeklyUsd: 20, todayUsd: 5, weekUsd: 9 } }), counts());
    expect(day.mode).toBe("budget");
    expect(day.badge).toBe("Co-pilot until tomorrow");
    expect(day.sentence).toBe("Budget reached: $5.00 today. Autopilot comes back at midnight. Plans keep being written and reviewed; Go is yours until then. 2 builders live, 3 on the ground.");
    expect(day.button).toEqual({ id: "raise", label: "Raise for today", tone: "plain" });
    const week = stripFor(snap({ pilot: "autopilot", budgetReached: "week", budget: { dailyUsd: 5, weeklyUsd: 20, todayUsd: 1, weekUsd: 20 } }), counts());
    expect(week.badge).toBe("Co-pilot until next week");
    expect(week.button.label).toBe("Raise for this week");
  });
  test("budgetReached means nothing outside Autopilot", () => {
    expect(stripFor(snap({ pilot: "copilot", budgetReached: "day" }), counts()).mode).toBe("copilot");
  });
  test("nobody seated: Manual, and the sentence says so", () => {
    for (const pilot of ["copilot", "autopilot"] as const) {
      const s = stripFor(snap({ pilot, seat: null }), counts({ goReady: 1 }));
      expect(s.mode).toBe("manual");
      expect(s.sentence).toContain("Nobody is seated in this project, so you fly.");
      expect(s.button.id).toBe("open-next");
    }
    expect(stripFor(snap({ pilot: "manual", seat: null }), counts()).sentence).not.toContain("Nobody");
  });
  test("every mode has the same slots", () => {
    const shapes = [snap({ pilot: "manual" }), snap(), snap({ pilot: "autopilot" }), snap({ held: true }), snap({ pilot: "autopilot", budgetReached: "day" })]
      .map((x) => Object.keys(stripFor(x, counts())).filter((k) => k !== "secondary").sort().join());
    expect(new Set(shapes).size).toBe(1);
  });
  test("effectivePilot", () => {
    expect(effectivePilot(snap({ pilot: "autopilot", seat: null }))).toBe("manual");
    expect(effectivePilot(snap({ pilot: "autopilot" }))).toBe("autopilot");
    expect(effectivePilot(null)).toBe("manual");
  });
});

describe("stationsFor", () => {
  const actors = (s: ReturnType<typeof stationsFor>) => s.map((x) => x.actor);
  test("six stations in order; Co-pilot: orchestrator writes, person says Go", () => {
    const s = stationsFor(plan(), run(), { pilot: "copilot" });
    expect(s.map((x) => x.id)).toEqual(["write", "review", "go", "build", "check", "merge"]);
    expect(actors(s)).toEqual(["coordinator", "reviewer", "person", "builder", "coordinator", "coordinator"]);
    expect(s.map((x) => x.state)).toEqual(["done", "done", "waiting", "todo", "todo", "todo"]);
  });
  test("Manual: the person writes, says Go, checks and integrates", () => {
    expect(actors(stationsFor(plan(), run(), { pilot: "manual" }))).toEqual(["person", "reviewer", "person", "builder", "person", "person"]);
  });
  test("Autopilot: the orchestrator says Go, until a stop reason hands it back", () => {
    const go = (stopReason?: "large") => stationsFor(plan(), run(), { pilot: "autopilot", stopReason }).find((x) => x.id === "go")!;
    expect(go()).toMatchObject({ actor: "coordinator", state: "current" });
    expect(go("large")).toMatchObject({ actor: "person", state: "waiting" });
  });
  test("nobody seated flies as Manual", () => {
    expect(actors(stationsFor(plan(), run(), { pilot: "autopilot", seated: false })).slice(0, 3)).toEqual(["person", "reviewer", "person"]);
  });
  test("S plans skip the review", () => {
    const s = stationsFor(plan({ size: "S" }), null, { pilot: "copilot" });
    expect(s[1]).toEqual({ id: "review", state: "skipped", actor: null });
    expect(s[2]!.state).toBe("waiting");
  });
  test("a waiting question makes Go the ask", () => {
    const s = stationsFor(plan(), run(), { pilot: "autopilot", asking: true, stopReason: "ask-finding" });
    expect(s[2]).toEqual({ id: "go", state: "waiting", actor: "person", ask: true });
    expect(stationsFor(plan(), run(), { pilot: "copilot" })[2]).not.toHaveProperty("ask");
  });
  test("the current station is the first not done: review while Preflight runs, build once launched", () => {
    expect(stationsFor(plan({ state: "draft", planMd: "", planBytes: 0 }), null, { pilot: "copilot" })[0]).toMatchObject({ state: "current", actor: "coordinator" });
    expect(stationsFor(plan(), run("running"), { pilot: "copilot" })[1]).toMatchObject({ state: "current", actor: "reviewer" });
    const b = stationsFor(plan({ state: "launched" }), run(), { pilot: "autopilot" });
    expect(b.map((x) => x.state)).toEqual(["done", "done", "done", "current", "todo", "todo"]);
    const landed = stationsFor(plan({ state: "launched" }), run(), { pilot: "autopilot", phase: "landed" });
    expect(landed.every((x) => x.state === "done")).toBe(true);
  });
});

describe("handledChip", () => {
  test("leaves out zero parts, counts contested", () => {
    expect(handledChip({ fixed: 3, contested: 0, dismissed: 1 })).toBe("4 handled · 3 fixed, 1 dismissed");
    expect(handledChip({ fixed: 0, contested: 2, dismissed: 0 })).toBe("2 handled · 2 contested");
    expect(handledChip({ fixed: 1, contested: 1, dismissed: 1 })).toBe("3 handled · 1 fixed, 1 contested, 1 dismissed");
    expect(handledChip({ fixed: 0, contested: 0, dismissed: 0 })).toBe("0 findings");
  });
});

describe("flightGroups", () => {
  const ids = (xs: FlightItem[]) => xs.map((x) => x.plan.id);
  const rows = [
    item({ plan: plan({ id: "go" }) }),
    item({ plan: plan({ id: "ask", state: "draft" }), run: null, questions: [q()] }),
    item({ plan: plan({ id: "build", state: "launched" }) }),
    item({ plan: plan({ id: "landed", state: "launched" }), landedAt: NOW - 1000 }),
    item({ plan: plan({ id: "old", state: "launched" }), landedAt: NOW - 3 * 86_400_000 }),
    item({ plan: plan({ id: "nogo", state: "no-go" }) }),
  ];
  test("Co-pilot: Go card and question wait; launched flies; landed today lands; No-go and old landings leave", () => {
    const g = flightGroups(rows, NOW, snap());
    expect(ids(g.waiting)).toEqual(["go", "ask"]);
    expect(ids(g.flying)).toEqual(["build"]);
    expect(ids(g.landed)).toEqual(["landed"]);
  });
  test("Autopilot: a ready plan is flying until a stop reason holds it", () => {
    const auto = snap({ pilot: "autopilot" });
    expect(ids(flightGroups(rows, NOW, auto).flying)).toEqual(["go", "build"]);
    expect(ids(flightGroups([item({ stopReason: "sensitive" })], NOW, auto).waiting)).toEqual(["p1"]);
  });
});

describe("stopCopy", () => {
  test("one sentence per reason", () => {
    for (const r of ["ask-finding", "budget", "builder-blocked", "open-blocker", "large", "sensitive"] as const) expect(stopCopy(r)).toMatch(/^[A-Z].*\.$/);
    expect(new Set((["ask-finding", "budget", "builder-blocked", "open-blocker", "large", "sensitive"] as const).map(stopCopy)).size).toBe(6);
  });
});

describe("no polling: the chip asks on an event", () => {
  const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url).pathname, "utf8");
  const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
  const waiting = code(read("src/lib/flightPlanWaiting.ts"));
  test("flightPlanWaiting has no timer of its own", () => {
    expect(waiting).not.toMatch(/setInterval|pollWhileLooking|POLL_MS/);
  });
  test("it refreshes on the event, debounced, and when the window is looked at again", () => {
    expect(waiting).toContain("export function notifyFlightPlanChanged(");
    expect(waiting).toContain("}, 250)");
    expect(waiting).toContain('"visibilitychange"');
  });
  test("the live socket carries the flight-plan frame into it", () => {
    const live = code(read("src/lib/useLive.ts"));
    expect(live).toContain('"flight-plan") { notifyFlightPlanChanged(); return; }');
  });
});
