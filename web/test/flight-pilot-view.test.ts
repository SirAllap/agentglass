/*
 * FLIGHT PLAN, THE FLYING VIEW: what its rows say and who answers what are plain
 * functions (tested here); how it is laid out and moves is read from source and
 * stylesheet, since there is no renderer in this project.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  flightGroups, flightItems, flightNow, goSentence, stateOf, stateSentence, handledLine, hhmm, needsLabel, nextWaiting, rowAction, rowMeta, stationsFor, stationsOf, stripCounts, stripFor,
  type FlightItem, type GroupId, type PilotQuestion, type PilotSnapshot, type StateId, type StateTone,
} from "../src/lib/flightPilot.ts";
import type { Plan, Run } from "../src/lib/flightPlan.ts";
import { trackLabel } from "../src/components/flightPlan/Trajectory.tsx";

const NOW = new Date(2026, 9, 28, 12, 0).getTime();
const plan = (o: Partial<Plan> = {}): Plan => ({
  id: "p1", root: "/work/acme/orbit", title: "Retry webhooks on 502", request: "", visual: false, planMd: "# Plan", planBytes: 6, mockups: [], state: "ready",
  decision: null, preflightRunId: "r1", taskId: null, autoRuns: 0, launched: null, reviewRounds: 0, stopReason: null, question: null, queued: false, createdBy: null, landedAt: null, lastReport: null, size: "M", createdAt: NOW - 9e5, updatedAt: NOW - 6e5, ...o,
});
const run = (findings: unknown[] = []): Run => ({
  id: "r1", createdAt: NOW - 8e5, root: "/work/acme/orbit", moment: "plan", state: "done", requestedBy: "coordinator", input: {}, error: null, taskId: null,
  certificate: { createdAt: NOW, model: "sonnet", costUsd: 0.18, files: [{ path: "a", sha256: "ab", bytes: 1 }, { path: "b", sha256: "cd", bytes: 1 }], mockups: [], skipped: [], sawConversation: false, isolation: "x", findings },
} as unknown as Run);
const q = (o: Partial<PilotQuestion> = {}): PilotQuestion => ({ id: "q1", planId: "p1", askedBy: "coordinator", askedAt: NOW, text: "Where does the retry count show?", choices: [], answer: null, ...o });
const snap = (o: Partial<PilotSnapshot> = {}): PilotSnapshot => ({
  pilot: "copilot", held: false, seat: "orbit seat", budget: { dailyUsd: 5, weeklyUsd: 20, todayUsd: 1.2, weekUsd: 6.8 }, flying: 1, budgetReached: null, ...o,
});
const item = (o: Partial<FlightItem> = {}): FlightItem => ({ plan: plan(), run: run(), ...o });

describe("stations", () => {
  test("a waiting question makes the person the actor of Go in Autopilot, with no stop reason", () => {
    const s = stationsFor(plan(), run(), { pilot: "autopilot", asking: true });
    expect(s[2]).toMatchObject({ actor: "person", state: "waiting", ask: true });
  });
  test("Manual: the check and the integrate are the person's too", () => {
    const s = stationsFor(plan({ state: "launched" }), run(), { pilot: "manual", phase: "checking" });
    expect(s.map((x) => x.actor)).toEqual(["person", "reviewer", "person", "builder", "person", "person"]);
    expect(s[4]).toMatchObject({ state: "waiting" });
  });
  test("stationsOf reads the phase from the engine's facts, or from a landing", () => {
    const flying = item({ plan: plan({ state: "launched" }), facts: { phase: "checking" } });
    expect(stationsOf(flying, snap()).map((x) => x.state)).toEqual(["done", "done", "done", "done", "current", "todo"]);
    const landed = item({ plan: plan({ state: "launched" }), landedAt: NOW });
    expect(stationsOf(landed, snap()).every((x) => x.state === "done")).toBe(true);
  });
  test("a text alternative names each station and who did it", () => {
    const label = trackLabel(stationsFor(plan(), run(), { pilot: "copilot", asking: true }));
    expect(label).toBe("Write done by orchestrator, Review done by reviewer, Question waiting on you, Build not yet, Check not yet, Merge not yet");
  });
});

describe("the row", () => {
  test("a question first, then Go, then what was handled", () => {
    expect(flightNow(item({ questions: [q()] }), snap(), NOW)).toMatchObject({ bold: "One question for you", sub: "Where does the retry count show?", next: "you answer the question" });
    expect(rowAction(item({ questions: [q()] }), snap())).toEqual({ kind: "answer", label: "Answer" });
    expect(rowAction(item(), snap())).toEqual({ kind: "go", label: "Review Go" });
    expect(rowAction(item({ plan: plan({ state: "draft" }), run: null, facts: { handled: { fixed: 3, contested: 0, dismissed: 1 } } }), snap())).toEqual({ kind: "handled", label: "4 handled · 3 fixed, 1 dismissed" });
  });
  test("a builder's last report is the now line, with its age", () => {
    const it = item({ plan: plan({ state: "launched" }), facts: { phase: "building", steps: { done: 3, of: 5 }, report: { text: "tests for cursor added", at: NOW - 4 * 60_000 } } });
    expect(flightNow(it, snap(), NOW)).toMatchObject({ bold: "Building · 3 of 5 steps", sub: "Last report 4 min ago: tests for cursor added" });
  });
  test("a stop reason is the sentence of a Go that Autopilot handed back", () => {
    expect(flightNow(item({ stopReason: "large" }), snap({ pilot: "autopilot" }), NOW).sub).toContain("large");
  });
  test("without the engine's facts a row still says what the plan says", () => {
    expect(flightNow(item({ plan: plan({ state: "draft" }), run: null }), snap(), NOW).bold).toBe("Writing the plan");
    expect(flightNow(item({ plan: plan({ state: "launched" }) }), snap(), NOW).bold).toBe("Building");
  });
  test("the meta line: who started it, or which builder has it; S plans say they skip Preflight", () => {
    expect(rowMeta(item({ plan: plan({ decision: { by: "coordinator:orbit", at: NOW } }) }))).toMatchObject({ who: `started ${hhmm(NOW - 9e5)} · Go by the orchestrator`, project: "acme/orbit", builder: null });
    expect(rowMeta(item()).who).toBe(`started ${hhmm(NOW - 9e5)}`);
    expect(rowMeta(item({ plan: plan({ size: "S", preflightRunId: null }) })).who).toBe("no Preflight · small");
    expect(rowMeta(item({ plan: plan({ state: "launched" }), facts: { builder: { branch: "orbit-paginate", tab: "@4" } } })).builder).toEqual({ branch: "orbit-paginate", tab: "@4" });
  });
});

describe("the strip's counts", () => {
  test("flying, waiting, what was handled and asked today", () => {
    const items = [
      item({ questions: [q()] }),
      item({ plan: plan({ id: "p2", state: "launched" }), facts: { handled: { fixed: 3, contested: 0, dismissed: 1 } } }),
      item({ plan: plan({ id: "p3", state: "launched" }), landedAt: NOW }),
    ];
    expect(stripCounts(items, NOW, snap({ pilot: "autopilot" }))).toMatchObject({ flying: 1, waiting: 1, handledToday: 4, askedToday: 1 });
  });
  test("Manual counts plans with open findings as needing answers, the rest as ready for Go", () => {
    const open = run([{ id: "F1", action: null }, { id: "F2", action: "ask" }, { id: "F3", action: "fix" }]);
    const c = stripCounts([item({ run: open }), item({ plan: plan({ id: "p2" }), run: run() })], NOW, snap({ pilot: "manual" }));
    expect(c).toMatchObject({ needAnswers: 1, findingsToAnswer: 2, goReady: 1 });
    expect(stripFor(snap({ pilot: "manual" }), c).sentence).toContain("1 needs answers to 2 findings, 1 is ready for Go");
  });
  test("Manual with a question and no open findings does not say \"0 findings\"", () => {
    const c = stripCounts([item({ questions: [q()] })], NOW, snap({ pilot: "manual" }));
    expect(stripFor(snap({ pilot: "manual" }), c).sentence).toContain("1 needs an answer");
  });
  test("Open next walks the questions before the Go cards", () => {
    const items = [item({ plan: plan({ id: "go" }) }), item({ plan: plan({ id: "ask" }), questions: [q({ planId: "ask" })] })];
    expect(nextWaiting(items, NOW, snap())?.plan.id).toBe("ask");
    expect(nextWaiting([], NOW, snap())).toBeNull();
  });
});

describe("the data of a flight", () => {
  test("flightItems reads the stop reason, the question and the facts off the plan itself", () => {
    const asked = { text: "Where does the retry count show?", choices: ["card", "row"], by: "coordinator:orbit", at: NOW };
    const d = [{ plan: plan({ stopReason: "budget", question: asked }), run: run() }, { plan: plan({ id: "p2" }), run: null }];
    const items = flightItems(d);
    expect(items[0]).toMatchObject({ stopReason: "budget" });
    expect(items[0]!.questions).toHaveLength(1);
    expect(items[1]!.questions).toBeUndefined();
    expect(items[1]!.stopReason).toBeNull();
  });
  test("the chip's sentence is shared", () => {
    expect(needsLabel(0, 0)).toBe("");
    expect(needsLabel(1, 0)).toBe("needs you · 1 question");
    expect(needsLabel(2, 1)).toBe("needs you · 2 questions, 1 Go");
  });
  test("the card's lines", () => {
    expect(handledLine({ fixed: 3, contested: 0, dismissed: 1 })).toBe("3 fixed, 1 dismissed as noise");
    expect(handledLine({ fixed: 0, contested: 0, dismissed: 0 })).toBe("");
    expect(goSentence(plan(), run())).toBe("M · 2 files. Preflight $0.18. The builder runs in your permission mode, in its own worktree, and reports to the orchestrator.");
    expect(goSentence(plan({ size: null, mockups: [{ path: "m.png", kind: "image" }] }), null)).toMatch(/^one mockup\. The builder/);
  });
});

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url).pathname, "utf8");
const code = (t: string) => t.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
const dir = "src/components/flightPlan/";

describe("the stylesheet", () => {
  const css = read(dir + "pilotView.css");
  test("moves only with transform and opacity, never a keyframe, and stops for reduced motion", () => {
    expect(css).not.toContain("@keyframes");
    expect(read(dir + "flightPlanView.css")).not.toMatch(/@keyframes pv-ring[^}]*\b(width|height|top|left|margin|padding|box-shadow)\b/);
    expect(css).not.toMatch(/transition:[^;{]*\b(width|height|top|left|margin|padding)\b/);
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toMatch(/:active[^{]*\{ transform: scale\(\.97\)/);
  });
  test("reduced motion: the running ring only exists under no-preference, and moves transform and opacity", () => {
    const all = read(dir + "flightPlanView.css");
    const ring = all.slice(all.indexOf("@keyframes pv-ring"));
    expect(ring).toMatch(/@keyframes pv-ring \{[^}]*transform[^}]*\}[^}]*opacity/);
    const media = all.slice(all.indexOf("@media (prefers-reduced-motion: no-preference) {\n  .fpv .pv-state[data-running]"));
    expect(media).toContain("animation: pv-ring");
    expect(all.replace(media.slice(0, media.indexOf("\n}\n") + 3), "")).not.toContain("animation: pv-ring");
    expect(read(dir + "pilotView.css")).not.toMatch(/\.pv-state[^{]*\{[^}]*animation/);
  });
  test("the four hues are the Settings tab's, not defined again", () => {
    expect(css).not.toMatch(/#7a4fb5|#2f7d8a|#3b66b0|#c27a2c/i);
    expect(css).toContain("var(--ps-you)");
  });
  // Measured in the built bundle: the orrery registered `@property --a` as an <angle>, and a registered property turns a
  // colour set on it into its initial 90deg, so every `background: var(--a)` was invalid and the done and current
  // stations had no colour at all (only the todo ones, which do not read --a, showed). A name registered with a syntax
  // is never also the actor colour.
  test("the actor colour --a is not a registered property, so a station keeps its hue", () => {
    const registered = ["flightPlanView.css", "pilotView.css", "pilotSettings.css"].flatMap((f) =>
      [...read(dir + f).matchAll(/@property\s+(--[\w-]+)/g)].map((m) => m[1]));
    expect(registered).not.toContain("--a");
    expect(registered).toContain("--ang");
    expect(css).toMatch(/\.pv-st \{[^}]*--a: var\(--ps-coord\)/);
  });
  test("the strip has one fixed height wide and one narrow, in every mode", () => {
    expect(css).toMatch(/\.fpv \.pv-strip \{[^}]*block-size: 66px/);
    expect(css).toMatch(/@container ps \(max-width: 760px\) \{[^}]*block-size: 128px/);
  });
  test("choices stack and Take over / Stop move under the line in a narrow card", () => {
    const narrow = css.slice(css.indexOf("@container gc (max-width: 520px)"));
    expect(narrow).toContain(".gc-choices { grid-template-columns: minmax(0, 1fr)");
    expect(narrow).toContain(".gc-f .sp { margin-left: 0; flex-basis: 100%");
  });
  test("the old list's rules are gone", () => {
    const old = read(dir + "flightPlanView.css");
    expect(old).not.toMatch(/\.fpv \.(pl|lfilter|lnone|grp|fp-mini)\b/);
  });
});

describe("the card", () => {
  const card = code(read(dir + "GoPoll.tsx"));
  test("choices are one radio group, the orchestrator's pick is chosen first, and a pointer click sends", () => {
    expect(card).toContain('type="radio"');
    expect(card).toContain("c.recommended)?.id");
    expect(card).toContain("onPointerDown");
  });
  test("Enter sends the chosen one, or the text from the text line", () => {
    expect(card).toContain("document.activeElement === textRef.current && t");
  });
  test("No-go takes an optional reason; Go is disabled only by the plan, never by a finding", () => {
    expect(card).toContain("onNoGo(t)");
    expect(card).toContain("disabled={busy || !canGo(plan)}");
  });
  test("the popover closes on Escape, keeps Tab inside and gives focus back", () => {
    const p = code(read(dir + "CardPopover.tsx"));
    expect(p).toContain('e.key === "Escape"');
    expect(p).toContain('e.key !== "Tab"');
    expect(p).toContain("opener.current?.focus");
    // The opener is read once: an effect that depends on onClose re-ran on every parent render and took the card's own input for it.
    expect(p).toContain("useEffect(() => {");
    expect(p).not.toMatch(/\}, \[onClose\]\);/);
    expect(p).toContain('aria-modal="true"');
  });
});

describe("the findings the orchestrator handled", () => {
  const f = code(read(dir + "FindingsCard.tsx"));
  test("collapse to a count unless the person flies the plan; read-only until Take over", () => {
    expect(f).toContain('pilot !== "manual" && fs.length > 0 && <Handled');
    expect(f).toContain('pilot === "manual" && fs.map(');
    expect(f).toContain("{!ro && <div className=\"acts\"");
  });
});

describe("the web speaks the engine's routes", () => {
  const api = read("src/lib/api.ts");
  test("every call of the block is typed and has a demo stub; the routes that do not exist are gone", () => {
    for (const m of ["flightHold", "flightResume", "flightAnswer"]) {
      expect(api).toContain(`  ${m}: `);
      expect(api.split(`  ${m}: `).length).toBe(3);
    }
    for (const gone of ["flightPilot:", "flightQuestions:", "flightTakeOver:", "fpQuiet", "/flight-plan/pilot", "/flight-plan/questions", "take-over"]) expect(code(api)).not.toContain(gone);
    expect(api).toContain("/flight-plan/plans/${encodeURIComponent(planId)}/answer`, { answer }");
    expect(api).toContain('post<{ ok: boolean; held?: boolean; told?: number; error?: string }>("/flight-plan/hold", { root })');
  });
  test("the snapshot is read from settings, the seat and the plans' budget, never from a pilot route", () => {
    const feed = code(read(dir + "usePilotFeed.ts"));
    expect(feed).toContain("pilotSnapshot(");
    expect(feed).toContain('api.settingAt("flightPlan.held", root)');
    expect(feed).not.toContain("snapshotFromSettings");
  });
  test("the top bar's chip speaks needsLabel and never counts a finding", () => {
    const app = code(read("src/App.tsx"));
    expect(app).toContain("needsLabel(waiting.questions, waiting.go)");
    expect(code(read("src/components/TopBar.tsx"))).toContain("openFlightPlan({ card: needs!.plan })");
  });
});

/* ------------------------------------------------------------- the 14 states */
describe("the state of a flight, one word", () => {
  const MIN = 60_000;
  const rep = (minAgo: number, step: number | null = 2, of: number | null = 4) => ({ line: "index migration", step, of, by: "builder", at: NOW - minAgo * MIN });
  const flown = (o: Partial<Plan> = {}, extra: Partial<FlightItem> = {}): FlightItem =>
    item({ plan: plan({ state: "launched", launched: { at: NOW - 40 * MIN, title: "t", branch: "orbit-search", window: "@6", session: "orbit" }, builder: "live", lastReport: rep(4), ...o }), run: null, ...extra });
  const auto = snap({ pilot: "autopilot" });
  const id = (it: FlightItem, s: PilotSnapshot = snap()) => stateOf(it, s, NOW).id;

  test("every state, with its word, group and tone", () => {
    const cases: [string, FlightItem, PilotSnapshot, StateId, string, GroupId, StateTone][] = [
      ["writing", item({ plan: plan({ state: "draft" }), run: null }), snap(), "writing", "Writing", "flying", "orchestrator"],
      ["preflight", item({ plan: plan({ reviewRounds: 2 }), run: { ...run(), state: "running" } as Run }), snap(), "preflight", "In Preflight", "flying", "preflight"],
      ["orchestrator", item(), auto, "orchestrator", "Waiting for the orchestrator", "flying", "orchestrator"],
      ["question", item({ questions: [q()] }), snap(), "ask", "Waiting for you", "waiting", "you"],
      ["go", item(), snap(), "go", "Waiting for you", "waiting", "you"],
      ["queued", item({ plan: plan({ state: "go", queued: true }) }), snap(), "queued", "Queued", "ground", "nobody"],
      ["building", flown(), snap(), "building", "Building", "flying", "builder"],
      ["quiet", flown({ lastReport: rep(21) }), snap(), "quiet", "Quiet", "flying", "builder"],
      ["paused", flown({ builder: "gone", lastReport: rep(14, 3, 9) }), snap(), "paused", "Paused", "ground", "nobody"],
      ["stopped", flown({ builder: "gone", lastReport: null }), snap(), "stopped", "Stopped", "ground", "stopped"],
      ["checking", flown({ lastReport: rep(1, 5, 5) }), snap(), "checking", "Checking", "flying", "orchestrator"],
      ["ready", flown({ builder: "gone", lastReport: rep(2, 5, 5) }), snap(), "ready", "Ready to land", "flying", "orchestrator"],
      ["landed", flown({}, { landedAt: NOW - 3 * MIN }), snap(), "landed", "Landed", "landed", "landed"],
      ["held by a hold", item({ plan: plan({ state: "go", queued: true }) }), snap({ held: true }), "held", "Held", "ground", "you"],
      ["held by the budget", item({ plan: plan({ state: "go", queued: true }) }), snap({ pilot: "autopilot", budgetReached: "day", budgetUntil: NOW + 12 * 60 * MIN }), "held", "Held", "ground", "you"],
      ["refused", flown({}, { stopReason: "sensitive-diff" }), snap(), "refused", "Refused", "waiting", "you"],
    ];
    for (const [name, it, s, sid, word, group, tone] of cases) {
      const b = stateOf(it, s, NOW);
      expect({ name, id: b.id, word: b.word, group: b.group, tone: b.tone }).toEqual({ name, id: sid, word, group, tone });
      expect(flightNow(it, s, NOW).state.id).toBe(sid);
    }
  });
  test("Quiet: 21 minutes of silence is Quiet, 19 is Building; with no report the clock starts at launch", () => {
    expect(id(flown({ lastReport: rep(19) }))).toBe("building");
    expect(stateOf(flown({ lastReport: rep(21) }), snap(), NOW).sub).toBe("no report 21 min");
    expect(id(flown({ lastReport: null }))).toBe("quiet");
    expect(id(flown({ lastReport: null, launched: { at: NOW - 5 * MIN, title: "t", window: "@6", session: "orbit" } }))).toBe("building");
  });
  test("a dead tab never reads Building: a report decides Paused, none Stopped, all steps done Ready to land", () => {
    expect(id(flown({ builder: "gone", lastReport: rep(14, 3, 9) }))).toBe("paused");
    expect(id(flown({ builder: "gone", lastReport: rep(14, null, null) }))).toBe("stopped");
    expect(id(flown({ builder: "gone", lastReport: null }))).toBe("stopped");
    expect(id(flown({ builder: "gone", lastReport: rep(14, 9, 9) }))).toBe("ready");
  });
  test("tmux unreadable, or no tab on record, claims nothing: Building", () => {
    expect(id(flown({ builder: "unknown", lastReport: rep(90) }))).toBe("building");
    expect(id(flown({ builder: "none", lastReport: null }))).toBe("building");
    expect(id(flown({ builder: undefined }))).toBe("building");
  });
  test("a stop reason before Go is a Go for you, never Refused; only a launched plan is Refused", () => {
    expect(id(item({ stopReason: "sensitive" }), auto)).toBe("go");
    expect(id(item({ stopReason: "large" }), auto)).toBe("go");
    expect(id(flown({}, { stopReason: "builder-blocked" }))).toBe("refused");
    expect(id(flown({}, { stopReason: "open-blocker" }))).toBe("refused");
    expect(id(flown({}, { stopReason: "budget" }))).toBe("building");
  });
  test("an open question beats Refused; Landed beats everything", () => {
    expect(id(flown({}, { stopReason: "sensitive-diff", questions: [q()] }))).toBe("ask");
    expect(id(flown({}, { stopReason: "sensitive-diff", landedAt: NOW }))).toBe("landed");
  });
  test("a hold or the budget never moves a live builder or a plan before Go: it keeps its state", () => {
    expect(id(flown(), snap({ held: true }))).toBe("building");
    expect(id(flown({ builder: "gone", lastReport: rep(3, 1, 9) }), snap({ held: true }))).toBe("paused");
    expect(id(item({ plan: plan({ state: "draft" }), run: null }), snap({ held: true }))).toBe("writing");
    expect(id(item({ plan: plan({ state: "go", queued: true }) }), snap({ pilot: "autopilot", budgetReached: "week" }))).toBe("held");
  });
  test("only real work is solid and pulsing", () => {
    const running = ["writing", "preflight", "building", "checking"];
    const states = ["writing", "preflight", "orchestrator", "ask", "go", "queued", "building", "quiet", "paused", "stopped", "checking", "ready", "landed", "held", "refused"] as const;
    const live = new Set<string>();
    const all: FlightItem[] = [
      item({ plan: plan({ state: "draft" }), run: null }), item({ run: { ...run(), state: "running" } as Run }), item(), item({ questions: [q()] }), item({ plan: plan({ state: "go", queued: true }) }),
      flown(), flown({ lastReport: rep(30) }), flown({ builder: "gone" }), flown({ builder: "gone", lastReport: null }), flown({ lastReport: rep(1, 4, 4) }), flown({ builder: "gone", lastReport: rep(1, 4, 4) }),
      flown({}, { landedAt: NOW }), flown({}, { stopReason: "sensitive-diff" }),
    ];
    for (const it of all) { const b = stateOf(it, auto, NOW); if (b.running) live.add(b.id); }
    expect([...live].sort()).toEqual(running.sort());
    expect(states.length).toBe(15);
  });
  test("only Stopped is red, only Refused and the waiting states are violet", () => {
    const b = (it: FlightItem, s = snap()) => stateOf(it, s, NOW);
    expect(b(flown({ builder: "gone", lastReport: null })).tone).toBe("stopped");
    expect(b(flown({}, { stopReason: "sensitive-diff" })).tone).toBe("you");
    expect(b(flown({ builder: "gone", lastReport: rep(1) })).tone).not.toBe("stopped");
  });
  test("the long word carries the detail, the short word does not", () => {
    const b = stateOf(flown({ lastReport: rep(4, 3, 5) }), snap(), NOW);
    expect([b.word, b.sub, b.long]).toEqual(["Building", "3 of 5 steps", "Building · 3 of 5 steps"]);
    expect(stateOf(item({ plan: plan({ reviewRounds: 2 }), run: { ...run(), state: "running" } as Run }), snap(), NOW).long).toBe("In Preflight · round 2");
  });
  test("a closed tab is Paused or Stopped by the last report's step alone", () => {
    expect(id(flown({ builder: "gone", lastReport: null }, { facts: { phase: "building", steps: { done: 3, of: 5 } } as never }))).toBe("stopped");
    expect(id(flown({ builder: "gone", lastReport: rep(14, null, 4) }))).toBe("stopped");
    expect(id(flown({ builder: "gone", lastReport: rep(14, 3, null) }))).toBe("paused");
  });
  test("a parked plan says nobody acts, never 'Relaunch now'", () => {
    const n = flightNow(flown({ builder: "gone", lastReport: rep(14, 3, 9) }), snap(), NOW);
    expect(n.next).toBe("nobody, waiting for a relaunch");
    expect(n.report).toBe("14 min ago · index migration");
    expect(stateSentence(n)).toMatch(/^Nothing runs and nothing is spent; the work is kept on its branch\. Next: nobody, waiting for a relaunch\. Last report 14 min ago · index migration\.$/);
    expect(rowAction(flown({ builder: "gone", lastReport: rep(14, 3, 9) }), snap(), NOW)).toEqual({ kind: "open-branch", label: "Open branch" });
    expect(JSON.stringify([n, rowAction(flown({ builder: "gone" }), snap(), NOW)])).not.toMatch(/Relaunch now|Can't land/);
  });
  test("a missing report is null, not an invented line", () => {
    expect(flightNow(flown({ lastReport: null }), snap(), NOW).report).toBeNull();
    expect(stateSentence(flightNow(item({ plan: plan({ state: "draft" }), run: null }), snap(), NOW))).toContain("Last report: none yet.");
  });
  test("row buttons follow the state: Open tab, Open branch, Lift hold, Decide", () => {
    const k = (it: FlightItem, s = snap()) => rowAction(it, s, NOW).kind;
    expect(k(flown())).toBe("open-tab");
    expect(k(flown({ lastReport: rep(30) }))).toBe("open-tab");
    expect(k(flown({ builder: "gone" }))).toBe("open-branch");
    expect(k(flown({ builder: "gone", lastReport: rep(1, 4, 4) }))).toBe("open-branch");
    expect(k(item({ plan: plan({ state: "go", queued: true }) }), snap({ held: true }))).toBe("lift-hold");
    expect(k(item({ plan: plan({ state: "go", queued: true }) }), snap({ pilot: "autopilot", budgetReached: "day" }))).toBe("handled");
    expect(k(flown({}, { stopReason: "sensitive-diff" }))).toBe("decide");
  });
});

describe("the four groups and what is counted", () => {
  const MIN = 60_000;
  const gone = (id: string, o: Partial<Plan> = {}): FlightItem => item({ plan: plan({ id, state: "launched", builder: "gone", lastReport: { line: "x", step: 3, of: 9, by: "b", at: NOW - MIN }, launched: { at: NOW - 30 * MIN, title: "t", window: "@1", session: "orbit" }, ...o }), run: null });
  const live = (id: string): FlightItem => gone(id, { builder: "live" });
  const rows = [
    live("a"), live("b"), gone("c"), gone("d", { lastReport: null }),
    item({ plan: plan({ id: "e", state: "go", queued: true }) }), item({ plan: plan({ id: "f", state: "draft" }), run: null }),
    item({ plan: plan({ id: "g" }), questions: [{ id: "q", planId: "g", askedBy: "c", askedAt: NOW, text: "?", choices: [], answer: null }] }),
    item({ plan: plan({ id: "h", state: "launched" }), run: null, landedAt: NOW - MIN }),
    item({ plan: plan({ id: "i", state: "launched" }), run: null, landedAt: NOW - 3 * 86_400_000 }),
    item({ plan: plan({ id: "j", state: "no-go" }), run: null }),
  ];
  const ids = (xs: FlightItem[]) => xs.map((x) => x.plan.id).sort();
  test("Waiting on you / Flying / On the ground (Paused, Stopped, Queued, Held) / Landed today", () => {
    const g = flightGroups(rows, NOW, snap({ pilot: "autopilot" }));
    expect(ids(g.waiting)).toEqual(["g"]);
    expect(ids(g.flying)).toEqual(["a", "b", "f"]);
    expect(ids(g.ground)).toEqual(["c", "d", "e"]);
    expect(ids(g.landed)).toEqual(["h"]);
  });
  test("the header counts builders with a live tab only; a parked plan is not flying", () => {
    const c = stripCounts(rows, NOW, snap({ pilot: "autopilot" }));
    expect(c).toMatchObject({ live: 2, onGround: 3, flying: 2, waiting: 1 });
    const list = readFileSync(new URL("../src/components/flightPlan/FlightList.tsx", import.meta.url), "utf8");
    expect(list).not.toContain("flyingLine");
    expect(list).toContain("stripCounts(");
  });
  test("the strip sentence of every mode says live and ground", () => {
    const c = stripCounts(rows, NOW, snap({ pilot: "autopilot" }));
    expect(stripFor(snap({ pilot: "autopilot" }), c).sentence).toStartWith("2 builders live, 1 waiting on you, 3 on the ground. On the ground costs nothing.");
    for (const s of [snap({ pilot: "copilot" }), snap({ pilot: "manual" }), snap({ held: true }), snap({ pilot: "autopilot", budgetReached: "day" })]) {
      expect(stripFor(s, c).sentence).toContain("2 builders live, 3 on the ground.");
    }
  });
  test("a parked build station is hatched, a dead one dashed, a held one hatched; none reads as current", () => {
    const st = (it: FlightItem, s = snap()) => stationsOf(it, s, NOW).find((x) => x.id === "build")!.state;
    expect(st(gone("c"))).toBe("parked");
    expect(st(gone("d", { lastReport: null }))).toBe("dead");
    expect(st(item({ plan: plan({ state: "go", queued: true }) }), snap({ held: true }))).toBe("held");
    expect(st(live("a"))).toBe("current");
  });
});
