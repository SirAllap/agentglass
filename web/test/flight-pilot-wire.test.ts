/*
 * The web side against the engine's real wire: one test per mapping that used to
 * be an assumption (plan fields, the question, the budget, the setting scopes,
 * the refusals). Fixtures are the shape of server/src/flightPlanStore.ts and
 * serverSettings.ts, with invented names.
 */
import { describe, expect, test } from "bun:test";
import { answerText, budgetOf, factsOf, flightItems, flightNow, needsYou, pilotSnapshot, questionOf, rowMeta, seatName, stripCounts, stripFor } from "../src/lib/flightPilot.ts";
import { goOutcome, groupOf, toPlan, type Plan, type Run } from "../src/lib/flightPlan.ts";
import { PILOT_KEYS, decode, noteFor, parseUsd } from "../src/lib/pilotSettings.ts";

const NOW = new Date(2026, 9, 28, 12, 0).getTime();
const wire = (o: Record<string, unknown> = {}) => ({
  id: "fp_0123456789abcdef", root: "/work/acme/orbit", title: "Retry webhooks on 502", request: "r", visual: 0, size: "M", planBytes: 40, mockups: [], state: "ready",
  decision: null, preflightRunId: "pf_1", taskId: null, autoRuns: 1, reviewRounds: 2, stopReason: "ask-finding", queued: false, question: null, launched: null,
  createdAt: NOW - 9e5, updatedAt: NOW - 6e5, pilot: "autopilot", held: true, ...o,
});
const asked = { text: "Where does the retry count show?", choices: ["card", "row"], by: "coordinator:orbit", at: NOW };
const runWith = (actions: (string | null)[]): Run => ({
  id: "pf_1", createdAt: NOW, root: "/work/acme/orbit", moment: "before-launch", state: "done", requestedBy: "x", input: {}, error: null, taskId: null,
  certificate: { findings: actions.map((action, i) => ({ id: `F${i + 1}`, severity: "major", action })) },
} as unknown as Run);

describe("a plan off the wire", () => {
  test("keeps the review rounds, the stop reason, the queue flag, the question and the mode the list carries", () => {
    const p = toPlan(wire({ question: asked }));
    expect(p).toMatchObject({ reviewRounds: 2, stopReason: "ask-finding", queued: false, pilot: "autopilot", held: true, question: asked });
  });
  test("the builder's branch and tab survive in launched; a plan with none of it reads as the defaults", () => {
    expect(toPlan(wire({ state: "launched", launched: { at: NOW, title: "t", branch: "flight-plan/retry", window: "@7" } })).launched).toMatchObject({ branch: "flight-plan/retry", window: "@7" });
    expect(toPlan({ id: "x" })).toMatchObject({ reviewRounds: 0, stopReason: null, question: null, queued: false });
  });
  test("Go said and queued behind the builders in the air is in progress, not a Go card", () => {
    expect(groupOf(toPlan(wire({ state: "go", queued: true })), null)).toBe("progress");
    expect(groupOf(toPlan(wire({ state: "go", queued: false })), null)).toBe("awaiting");
    const p = toPlan(wire({ state: "go", queued: true }));
    expect(flightNow({ plan: p, run: null }, null, NOW)).toMatchObject({ bold: "Queued" });
  });
  test("a second look is said as such while the reviewer reads", () => {
    const running = { ...runWith([]), state: "running" } as Run;
    expect(flightNow({ plan: toPlan(wire()), run: running }, null, NOW).sub).toContain("again");
  });
});

describe("the question", () => {
  const plan = toPlan(wire({ question: asked })) as Plan;
  test("has no id of its own: plan and time name it; choices are their text in order", () => {
    expect(questionOf(plan)).toEqual({
      id: `fp_0123456789abcdef@${NOW}`, planId: "fp_0123456789abcdef", askedBy: "coordinator:orbit", askedAt: NOW, text: asked.text,
      choices: [{ id: "0", label: "card" }, { id: "1", label: "row" }], answer: null,
    });
    expect(questionOf(toPlan(wire()))).toBeNull();
  });
  test("an answered question stays on the plan with its answer", () => {
    const q = questionOf(toPlan(wire({ question: { ...asked, answer: { text: "card", by: "you", at: NOW + 1 } } })))!;
    expect(q.answer).toEqual({ by: "you", text: "card", at: NOW + 1 });
    expect(flightItems([{ plan: toPlan(wire({ question: { ...asked, answer: { text: "card", by: "you", at: NOW + 1 } } })), run: null }])[0]!.questions![0]!.answer).not.toBeNull();
  });
  test("the answer route takes the words: a picked choice is sent as its text", () => {
    const q = questionOf(plan)!;
    expect(answerText(q, { choiceId: "1" })).toBe("row");
    expect(answerText(q, { choiceId: "9" })).toBe("");
    expect(answerText(q, { text: "  on the card, small  " })).toBe("on the card, small");
  });
});

describe("the facts of a flight come from its plan and run", () => {
  test("handled counts are the findings the orchestrator answered; Ask and unanswered are not handled", () => {
    const f = factsOf(toPlan(wire()), runWith(["fix", "fix", "contest", "dismiss", "ask", null]));
    expect(f.handled).toEqual({ fixed: 2, contested: 1, dismissed: 1 });
    expect(f.stopReason).toBe("ask-finding");
    expect(f.builder).toBeNull();
  });
  test("a launched plan names its builder; nothing invents a report, steps or a landing", () => {
    const p = toPlan(wire({ state: "launched", stopReason: null, launched: { at: NOW, title: "t", branch: "flight-plan/retry", window: "@7" } }));
    const f = factsOf(p, null);
    expect(f.builder).toEqual({ branch: "flight-plan/retry", tab: "@7" });
    expect(f.report).toBeUndefined();
    expect(f.steps).toBeUndefined();
    expect(f.landedAt).toBeUndefined();
    expect(flightNow({ plan: p, run: null, facts: f }, null, NOW)).toMatchObject({ bold: "Building", sub: "Launched; the builder reports to the orchestrator." });
  });
});

describe("the snapshot", () => {
  const budget = { reached: "daily", dayUsd: 5.2, weekUsd: 9, dailyCap: 5, weeklyCap: 20, until: NOW + 1 };
  test("maps the engine's budget names to the strip's, and daily/weekly to day/week", () => {
    expect(budgetOf(budget)).toMatchObject({ budget: { dailyUsd: 5, weeklyUsd: 20, todayUsd: 5.2, weekUsd: 9 }, budgetReached: "day" });
    expect(budgetOf({ ...budget, reached: "weekly" })!.budgetReached).toBe("week");
    expect(budgetOf({ ...budget, reached: null })!.budgetReached).toBeNull();
    expect(budgetOf(undefined)).toBeNull();
    expect(budgetOf({ dayUsd: "1" })).toBeNull();
  });
  test("assembles mode, hold and seat; an unknown mode is the engine's default", () => {
    expect(pilotSnapshot({ pilot: "autopilot", held: true, budget, seat: "orbit" })).toMatchObject({ pilot: "autopilot", held: true, seat: "orbit", budgetReached: "day" });
    expect(pilotSnapshot({ pilot: "nonsense", held: undefined, budget, seat: null })).toMatchObject({ pilot: "copilot", held: false, seat: null });
  });
  test("the seat is the agent in the chair; a failed read assumes one rather than say there is none", () => {
    expect(seatName({ ok: true, agent: { name: "orbit" } })).toBe("orbit");
    expect(seatName({ ok: true, agent: null })).toBeNull();
    expect(seatName(null)).toBe("");
    expect(seatName({ ok: false })).toBe("");
  });
});

describe("the settings are the engine's", () => {
  test("scopes: the mode, the reviews, the model, the per-run cap and the two ask rules are per project; the rest is the machine's", () => {
    const project = Object.entries(PILOT_KEYS).filter(([, k]) => k.scope === "project").map(([f]) => f).sort();
    expect(project).toEqual(["askOnLarge", "askOnSensitive", "costCapUsd", "model", "pilot", "reviews"]);
  });
  test("a model is any one word the engine takes, not only the three the picker offers", () => {
    expect(decode("model", "opus")).toBe("opus");
    expect(decode("model", "claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(decode("model", "two words")).toBeUndefined();
    expect(decode("model", 3)).toBeUndefined();
  });
  test("the weekly cap stops where the engine's does", () => {
    expect(parseUsd("weeklyUsd", "1000").ok).toBe(true);
    expect(parseUsd("weeklyUsd", "1001").ok).toBe(false);
  });
});

describe("refusals", () => {
  test("the door's wait arrives as ok:false with applied:false (the client reads its 202 that way): a wait, not an error", () => {
    expect(noteFor({ ok: false, applied: false, error: "not saved: this window is not the desktop app, so the change waits as a request for the app's Approve" })?.kind).toBe("wait");
  });
  test("each sentence the engine gives a refusal is the lock note", () => {
    for (const error of [
      "Resume is the person's: an orchestrator may hold itself, never release itself",
      "Go, No-go and Launch are the person's: an agent asks, the person decides",
      "The question is the person's to answer",
      "flightPlan.pilot: autopilot lets the orchestrator say Go without asking: only the person turns it on, from Settings. An agent cannot change it, not even by asking",
    ]) expect(noteFor({ ok: false, error })?.kind).toBe("lock");
  });
});

describe("what the engine added to the wire", () => {
  const report = { line: "tests for cursor added", step: 3, of: 5, by: "agent", at: NOW - 4 * 60_000 };
  test("a landed plan leaves Flying and says Landed; a report becomes the row's line and steps", () => {
    const flying = flightItems([{ plan: toPlan(wire({ state: "launched", stopReason: null, lastReport: report, createdBy: "you" })), run: null }])[0]!;
    expect(flightNow(flying, null, NOW)).toMatchObject({ bold: "Building · 3 of 5 steps", sub: "Last report 4 min ago: tests for cursor added" });
    const landed = flightItems([{ plan: toPlan(wire({ state: "launched", stopReason: null, landedAt: NOW - 60_000 })), run: null }])[0]!;
    expect(flightNow(landed, null, NOW).bold).toBe("Landed");
  });
  test("who held and who started read as words", () => {
    expect(stripFor(pilotSnapshot({ pilot: "autopilot", held: true, budget: null, seat: "orbit" }), { flying: 0, waiting: 0, live: 0, onGround: 0, handledToday: 0, askedToday: 0, goReady: 0, needAnswers: 0, findingsToAnswer: 0 }).sentence).toStartWith("Held.");
    const s = { ...pilotSnapshot({ pilot: "autopilot", held: true, budget: null, seat: "orbit" }), heldBy: "you", heldAt: NOW };
    expect(stripFor(s, { flying: 0, waiting: 0, live: 0, onGround: 0, handledToday: 0, askedToday: 0, goReady: 0, needAnswers: 0, findingsToAnswer: 0 }).lead).toBe("Held by you at 12:00.");
    expect(rowMeta(flightItems([{ plan: toPlan(wire({ createdBy: "coordinator:orbit" })), run: null }])[0]!).who).toStartWith("started by the orchestrator ");
  });
  test("the question keeps its id, detail and the orchestrator's pick", () => {
    const q = questionOf(toPlan(wire({ question: { ...asked, id: "q_ab12cd34", detail: "The mockup shows a badge.", recommended: 1 } })))!;
    expect(q).toMatchObject({ id: "q_ab12cd34", detail: "The mockup shows a badge." });
    expect(q.choices.map((c) => !!c.recommended)).toEqual([false, true]);
  });
});

describe("the Go answer", () => {
  test("a launched Go, a queued Go, a launch that could not start and a refusal are four different outcomes", () => {
    expect(goOutcome({ ok: true })).toEqual({ kind: "launched" });
    expect(goOutcome({ ok: true, queued: false })).toEqual({ kind: "launched" });
    expect(goOutcome({ ok: true, queued: true })).toEqual({ kind: "queued" });
    expect(goOutcome({ ok: true, queued: false, launchError: "no free worktree" })).toEqual({ kind: "retry", error: "no free worktree" });
    expect(goOutcome({ ok: false, error: "a launched plan cannot be told Go" })).toEqual({ kind: "refused", error: "a launched plan cannot be told Go" });
    expect(goOutcome({ ok: false })).toEqual({ kind: "refused", error: "Go was refused" });
  });
  test("a Go that waits for a slot says so on the row", () => {
    const p = toPlan(wire({ state: "go", queued: true, stopReason: null }));
    expect(flightNow({ plan: p, run: null }, null, NOW).sub).toContain("waits for a free slot");
  });
  test("the Go card has one line for the launch error, always there, and Launch as the retry", async () => {
    const src = await Bun.file(new URL("../src/components/flightPlan/GoPoll.tsx", import.meta.url)).text();
    expect(src).toContain('<p className="gc-err" role="alert">{error}</p>');
    expect(src).toContain('plan.state === "go" ? "Launch" : "Go"');
  });
});

describe("The builder never", () => {
  test("Leaves its worktree carries its note on the chip and in a visible line", async () => {
    const src = await Bun.file(new URL("../src/components/flightPlan/SettingsTab.tsx", import.meta.url)).text();
    expect(src).toContain('["Leaves its worktree", "File edits enforced, shell checked, scripts by brief."]');
    expect(src).toContain("title={note ?");
    expect(src).toContain('className="ps-never-note"');
  });
});

describe("counts the owner reads", () => {
  test("a plan that waits on a question and is also at Go is one thing waiting, not two", () => {
    const [it] = flightItems([{ plan: toPlan(wire({ question: asked })), run: null }]);
    const auto = pilotSnapshot({ pilot: "autopilot", held: false, budget: null, seat: "orbit" });
    expect(needsYou([it!], auto)).toMatchObject({ questions: 1, go: 0, label: "needs you · 1 question" });
  });
  test("the strip's flying counts builders in the air, not drafts or plans waiting for the orchestrator", () => {
    const rows = flightItems([
      { plan: toPlan(wire({ id: "fp_1111111111111111", state: "launched", stopReason: null })), run: null },
      { plan: toPlan(wire({ id: "fp_2222222222222222", state: "draft", stopReason: null })), run: null },
      { plan: toPlan(wire({ id: "fp_3333333333333333", state: "ready", stopReason: null })), run: null },
    ]);
    const auto = pilotSnapshot({ pilot: "autopilot", held: false, budget: null, seat: "orbit" });
    expect(stripCounts(rows, NOW, auto).flying).toBe(1);
  });
});

describe("the strip says what is true", () => {
  test("an Autopilot that has asked nothing says so, not '0 times'", () => {
    const auto = pilotSnapshot({ pilot: "autopilot", held: false, budget: null, seat: "orbit" });
    const c = { flying: 0, waiting: 0, live: 0, onGround: 0, handledToday: 3, askedToday: 0, goReady: 0, needAnswers: 0, findingsToAnswer: 0 };
    expect(stripFor(auto, c).sentence).toBe("0 builders live, 0 waiting on you, 0 on the ground. On the ground costs nothing. The orchestrator handled 3 findings today and has not asked you.");
    expect(stripFor(auto, { ...c, askedToday: 2 }).sentence).toContain("and asked you twice.");
  });
});

describe("a stop rule is only spoken of where Autopilot is flying", () => {
  test("in Manual and Co-pilot a large plan reads as plain Go, not 'Autopilot asks'", () => {
    const [it] = flightItems([{ plan: toPlan(wire({ stopReason: "large", state: "ready" })), run: null }]);
    const mode = (pilot: "manual" | "copilot" | "autopilot") => pilotSnapshot({ pilot, held: false, budget: null, seat: "orbit" });
    expect(flightNow(it!, mode("manual"), NOW).sub).not.toContain("Autopilot");
    expect(flightNow(it!, mode("copilot"), NOW).sub).not.toContain("Autopilot");
    expect(flightNow(it!, mode("autopilot"), NOW).sub).toContain("large");
  });
});

describe("the Flight plan view does not borrow a global class", () => {
  // The badge icon used the class `tile`, which index.css also defines (padding,
  // column flex, a gradient): the icon sat at the bottom of a wide square.
  test("no className in the view is a class index.css defines as a component", async () => {
    const globals = new Set([...(await Bun.file(new URL("../src/index.css", import.meta.url)).text()).matchAll(/^ {2}\.(tile|panel)\b/gm)].map((m) => m[1]));
    for (const f of ["PilotStrip", "FlightGroups", "ProjectsCard"]) {
      const src = await Bun.file(new URL(`../src/components/flightPlan/${f}.tsx`, import.meta.url)).text();
      for (const c of globals) expect(src).not.toMatch(new RegExp(`className="${c}"`));
    }
    expect(globals.has("tile")).toBe(true);
  });
});
