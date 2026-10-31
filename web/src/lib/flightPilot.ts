/*
 * FLIGHT PLAN, PILOT — the vocabulary the Flying view and the Settings tab share,
 * and the decisions the Pilot view makes from it as plain functions (there is no
 * renderer here, so what the strip says, who each station belongs to and what
 * waits on the person is decided and tested in this file; the view only lays it out).
 *
 * Pilot, StopReason and PilotState are the engine's own (shared/types.ts); the
 * rest, what the routes answer with, is named here, the one place the web side
 * names the new things.
 */
import { PILOTS, type Pilot, type PilotState, type StopReason } from "../../../shared/types.ts";
import { findingsOf, groupOf, openCount, projectName, usd, when, written, type Plan, type Run } from "./flightPlan.ts";

export { PILOTS };
export type { Pilot, PilotState, StopReason };

/** Who did a step of a flight. */
export type Actor = "person" | "coordinator" | "reviewer" | "builder";

/** The six stations of a flight, in order. Go is "ask" while a question waits. */
export type StationId = "write" | "review" | "go" | "build" | "check" | "merge";
export const STATIONS: readonly StationId[] = ["write", "review", "go", "build", "check", "merge"];

/** parked: the builder tab closed after a report (hatched); dead: it closed with nothing reported (dashed red); held: stopped by a hold or the budget (hatched grey). */
export type StationState = "done" | "current" | "waiting" | "skipped" | "todo" | "parked" | "dead" | "held";
export interface Station { id: StationId; state: StationState; actor: Actor | null; ask?: boolean }

/** The one question a coordinator raises when a finding is a product call. The engine keeps a choice as its text, so a choice's id is its place in the list. */
export interface PilotChoice { id: string; label: string; detail?: string; recommended?: boolean }
export interface PilotQuestion {
  id: string; planId: string; askedBy: string; askedAt: number;
  text: string; detail?: string; choices: PilotChoice[];
  answer: { by: string; text: string; at: number } | null;
}

/** The plan's question as the view holds it. One per plan; a question from before the engine gave it an id is named by plan and time. The recommended choice is the coordinator's pick. */
export function questionOf(plan: Plan): PilotQuestion | null {
  const q = plan.question;
  if (!q) return null;
  return {
    id: q.id ?? `${plan.id}@${q.at}`, planId: plan.id, askedBy: q.by, askedAt: q.at, text: q.text, ...(q.detail ? { detail: q.detail } : {}),
    choices: q.choices.map((label, i) => ({ id: String(i), label, ...(i === q.recommended ? { recommended: true } : {}) })),
    answer: q.answer ? { by: q.answer.by, text: q.answer.text, at: q.answer.at } : null,
  };
}

/** What the answer route takes: the words. A picked choice is sent as its text. */
export function answerText(q: PilotQuestion, a: { choiceId: string } | { text: string }): string {
  return "choiceId" in a ? q.choices.find((c) => c.id === a.choiceId)?.label ?? "" : a.text.trim();
}

/** What the coordinator already did with a plan's findings. */
export interface Handled { fixed: number; contested: number; dismissed: number }

/** What the engine says about a project's flying right now, assembled by `pilotSnapshot`. */
export interface PilotSnapshot {
  pilot: Pilot;
  /** Held by the person or the coordinator. */
  held: boolean;
  /** Who held ("you" or `coordinator:<seat>`) and when; null when the door did not say. */
  heldBy?: string | null; heldAt?: number | null;
  /** The seat's name, or null when nobody is seated: the mode then behaves as Manual. */
  seat: string | null;
  budget: { dailyUsd: number; weeklyUsd: number; todayUsd: number; weekUsd: number };
  /** "day" or "week" when Autopilot has dropped to Co-pilot for budget. */
  budgetReached: "day" | "week" | null;
  /** When the budget comes back (ms), if the engine said. */
  budgetUntil?: number | null;
  /** Builders in the air: launched plans not yet landed. */
  flying?: number;
}

/** What the plans routes call the budget: `budget` on GET /flight-plan/plans, `daily`/`weekly` the caps and what was spent. */
export interface BudgetWire { reached: "daily" | "weekly" | null; dayUsd: number; weekUsd: number; dailyCap: number; weeklyCap: number; until: number | null }

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** The budget as the strip reads it, or null when the engine sent something else. */
export function budgetOf(b: unknown): Pick<PilotSnapshot, "budget" | "budgetReached" | "budgetUntil"> | null {
  const w = b as Partial<BudgetWire> | null | undefined;
  if (!w || !fin(w.dayUsd) || !fin(w.weekUsd) || !fin(w.dailyCap) || !fin(w.weeklyCap)) return null;
  return {
    budget: { dailyUsd: w.dailyCap, weeklyUsd: w.weeklyCap, todayUsd: w.dayUsd, weekUsd: w.weekUsd },
    budgetReached: w.reached === "daily" ? "day" : w.reached === "weekly" ? "week" : null,
    budgetUntil: fin(w.until) ? w.until : null,
  };
}

/** The agent in the chair, null when nobody sits there; an unread answer assumes a seat (the empty name) rather than call the project seatless. */
export const seatName = (c: { ok: boolean; agent?: { name: string } | null } | null): string | null => (c?.ok ? c.agent?.name ?? null : "");

/** The mode, hold and seat of one project with the app's budget. A budget that was not read is all zero: `budgetOf` tells the caller it was unknown, so a meter can say "not read" instead of $0.00. */
export function pilotSnapshot(i: { pilot: unknown; held: unknown; budget: unknown; seat: string | null }): PilotSnapshot {
  const b = budgetOf(i.budget) ?? { budget: { dailyUsd: 0, weeklyUsd: 0, todayUsd: 0, weekUsd: 0 }, budgetReached: null };
  return { pilot: i.pilot === "manual" || i.pilot === "autopilot" ? i.pilot : "copilot", held: i.held === true, seat: i.seat, ...b };
}

/** The settings the Settings tab edits, as the engine stores them. */
export interface PilotSettings {
  pilot: Pilot;
  reviews: { plan: boolean; taskDone: boolean; pr: boolean };
  sizes: "L" | "ML";
  secondLooks: 0 | 1 | 2;
  /** Any model name the engine takes (one word); sonnet, opus and haiku are the ones the picker offers. */
  model: string;
  costCapUsd: number;
  dailyUsd: number; weeklyUsd: number;
  maxFlying: 1 | 2 | 3;
  askOnLarge: boolean; askOnSensitive: boolean;
  permissions: "default" | "auto" | "bypassPermissions";
  /** Where a builder worktree is cut from: the local trunk, or origin/<trunk>. */
  builderBase: "local" | "remote";
}

/* ---------------------------------------------------------------- decisions */

/** The mode that really applies: with nobody in the chair there is no one else to fly, so it is Manual. */
export const effectivePilot = (s: Pick<PilotSnapshot, "pilot" | "seat"> | null | undefined): Pilot => (!s || s.seat === null ? "manual" : s.pilot);

/** What the engine knows about one flight beyond the plan and its run. Every part may be missing: the row then says only what the plan says. */
export interface FlightFacts {
  stopReason?: StopReason | null;
  phase?: "building" | "checking" | "landed";
  landedAt?: number | null;
  handled?: Handled;
  /** The builder's last report, and how far along it says it is. */
  report?: { text: string; at: number } | null;
  steps?: { done: number; of: number } | null;
  builder?: { branch: string; tab?: string } | null;
}

/** What the plan and its run already say about a flight (the engine has no separate facts route): who must decide, what the coordinator handled, where the builder flies. */
export function factsOf(plan: Plan, run: Run | null): FlightFacts {
  const act = (a: string) => findingsOf(run).filter((f) => f.action === a).length;
  const l = plan.launched;
  return {
    stopReason: plan.stopReason,
    handled: { fixed: act("fix"), contested: act("contest"), dismissed: act("dismiss") },
    ...(plan.landedAt ? { phase: "landed" as const, landedAt: plan.landedAt } : {}),
    ...(plan.lastReport ? { report: { text: plan.lastReport.line, at: plan.lastReport.at }, steps: plan.lastReport.step !== null && plan.lastReport.of ? { done: plan.lastReport.step, of: plan.lastReport.of } : null } : {}),
    builder: plan.state === "launched" && l?.branch ? { branch: l.branch, ...(l.window ? { tab: l.window } : {}) } : null,
  };
}

/** One flight as the view holds it: the plan, its run, and what the engine says about it. */
export interface FlightItem {
  plan: Plan; run: Run | null;
  stopReason?: StopReason | null;
  questions?: PilotQuestion[];
  /** When the builder's work landed in main; absent while it flies. */
  landedAt?: number | null;
  facts?: FlightFacts;
}

/** Plans and their runs as flights: the facts and the question come from the plan itself. */
export function flightItems(details: { plan: Plan; run: Run | null }[]): FlightItem[] {
  return details.map(({ plan, run }) => {
    const q = questionOf(plan);
    return { plan, run, facts: factsOf(plan, run), stopReason: plan.stopReason, landedAt: plan.landedAt, ...(q ? { questions: [q] } : {}) };
  });
}
type ModeFacts = Pick<PilotSnapshot, "pilot" | "seat" | "held" | "budgetReached"> & Partial<Pick<PilotSnapshot, "heldBy" | "budgetUntil">>;

const unanswered = (it: FlightItem): number => (it.questions ?? []).filter((q) => q.answer === null).length;

/** Autopilot says Go itself; every other case (and Autopilot once a stop rule fired, it is held or the budget is spent) leaves Go to the person. */
function personSaysGo(it: FlightItem, s: ModeFacts | null | undefined): boolean {
  if (effectivePilot(s) !== "autopilot") return true;
  return !!it.stopReason || !!s!.held || !!s!.budgetReached;
}
const isGoCard = (it: FlightItem, s: ModeFacts | null | undefined): boolean => groupOf(it.plan, it.run) === "awaiting" && personSaysGo(it, s);

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export interface NeedsYou { questions: number; go: number; total: number; label: string }
/** "needs you · 1 question, 2 Go", or "" when nothing waits: the one sentence the chip and the popover share. */
export function needsLabel(questions: number, go: number): string {
  const bits = [questions ? plural(questions, "question") : "", go ? `${go} Go` : ""].filter(Boolean);
  return bits.length ? `needs you · ${bits.join(", ")}` : "";
}
/**
 * What waits on the person: questions raised and not answered, plus Go cards.
 * Findings, a plan started, a Preflight done and a landing never count: they are
 * quiet rows. Without a snapshot every Go card counts, as in Manual.
 */
export function needsYou(items: FlightItem[], s?: ModeFacts | null): NeedsYou {
  const questions = items.reduce((n, it) => n + unanswered(it), 0);
  const go = items.filter((it) => isGoCard(it, s) && !unanswered(it)).length;
  return { questions, go, total: questions + go, label: needsLabel(questions, go) };
}

export const stopCopy = (r: StopReason): string => ({
  "ask-finding": "A finding is a product call that only you can make.",
  budget: "The budget for today or this week is spent.",
  "builder-blocked": "The builder is blocked and needs a decision.",
  "open-blocker": "Preflight still has an open blocker after its second looks.",
  large: "This plan is large, so Autopilot asks before Go.",
  sensitive: "This plan touches auth, migrations, secrets, payments, CI or a dependency, so Autopilot asks before Go.",
  "sensitive-diff": "The builder's changes touch auth, migrations, secrets, payments, CI or a dependency, so it stops before Integrate.",
} satisfies Record<StopReason, string>)[r];

/** "4 handled · 3 fixed, 1 dismissed", or "0 findings". */
export function handledChip(h: Handled): string {
  const total = h.fixed + h.contested + h.dismissed;
  if (!total) return "0 findings";
  const parts = [h.fixed ? `${h.fixed} fixed` : "", h.contested ? `${h.contested} contested` : "", h.dismissed ? `${h.dismissed} dismissed` : ""].filter(Boolean);
  return `${total} handled · ${parts.join(", ")}`;
}

/* ------------------------------------------------------------------- states */

export type StateId = "writing" | "preflight" | "orchestrator" | "ask" | "go" | "queued" | "building" | "quiet" | "paused" | "stopped" | "checking" | "ready" | "landed" | "held" | "refused";
/** Who the state is waiting on, as a hue; refused is the person's (violet), only stopped is red. */
export type StateTone = "you" | "orchestrator" | "builder" | "preflight" | "nobody" | "landed" | "stopped";
export type StateIcon = "pen" | "eye" | "star" | "ask" | "flag" | "clock" | "plane" | "bell" | "pause" | "stop" | "check" | "merge" | "done" | "lock" | "shield";
export type GroupId = "waiting" | "flying" | "ground" | "landed";
export const GROUP_OF_STATE: Record<StateId, GroupId> = {
  ask: "waiting", go: "waiting", refused: "waiting",
  writing: "flying", preflight: "flying", orchestrator: "flying", building: "flying", quiet: "flying", checking: "flying", ready: "flying",
  paused: "ground", stopped: "ground", queued: "ground", held: "ground", landed: "landed",
};
/** A builder with no report for this long, tab still open, is Quiet. */
export const QUIET_MS = 20 * 60_000;

/** The one word of a flight's situation: short for the row (`word` with `sub` under it), long for the detail. Icon and word say it; colour only repeats it. */
export interface StateBadge {
  id: StateId; word: string; sub: string | null; long: string;
  icon: StateIcon; tone: StateTone;
  /** Solid and pulsing only while real work runs; every other state is hollow and dashed. */
  running: boolean;
  group: GroupId;
}
const BADGES: Record<StateId, Omit<StateBadge, "id" | "sub" | "long" | "group">> = {
  writing: { word: "Writing", icon: "pen", tone: "orchestrator", running: true },
  preflight: { word: "In Preflight", icon: "eye", tone: "preflight", running: true },
  orchestrator: { word: "Waiting for the orchestrator", icon: "star", tone: "orchestrator", running: false },
  ask: { word: "Waiting for you", icon: "ask", tone: "you", running: false },
  go: { word: "Waiting for you", icon: "flag", tone: "you", running: false },
  queued: { word: "Queued", icon: "clock", tone: "nobody", running: false },
  building: { word: "Building", icon: "plane", tone: "builder", running: true },
  quiet: { word: "Quiet", icon: "bell", tone: "builder", running: false },
  paused: { word: "Paused", icon: "pause", tone: "nobody", running: false },
  stopped: { word: "Stopped", icon: "stop", tone: "stopped", running: false },
  checking: { word: "Checking", icon: "check", tone: "orchestrator", running: true },
  ready: { word: "Ready to land", icon: "merge", tone: "orchestrator", running: false },
  landed: { word: "Landed", icon: "done", tone: "landed", running: false },
  held: { word: "Held", icon: "lock", tone: "you", running: false },
  refused: { word: "Refused", icon: "shield", tone: "you", running: false },
};
const badge = (id: StateId, sub: string | null = null, tone?: StateTone): StateBadge => {
  const b = BADGES[id];
  return { id, ...b, ...(tone ? { tone } : {}), sub, long: sub ? `${b.word} · ${sub}` : b.word, group: GROUP_OF_STATE[id] };
};
const REFUSING: readonly StopReason[] = ["sensitive-diff", "builder-blocked", "open-blocker"];
const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000));
export const stepsOf = (plan: Plan, f?: FlightFacts): { k: number; n: number } | null =>
  plan.lastReport && plan.lastReport.step !== null && plan.lastReport.of ? { k: plan.lastReport.step, n: plan.lastReport.of } : f?.steps ? { k: f.steps.done, n: f.steps.of } : null;

/**
 * The situation of a flight, one state, first match wins (decisions of the Flight plan states study):
 * Landed; Waiting for you (an open question, or the Go owed to the person); Refused (a launched plan
 * whose builder tripped a stop rule); Held (a hold or the budget, only for a plan past Go with no builder);
 * then, before launch, Writing / In Preflight / Waiting for the orchestrator / Queued; after launch it is the
 * builder tab that says: live is Building (Checking when its steps are all done, Quiet after 20 minutes of silence),
 * gone is Paused, Stopped or Ready to land, and a tab tmux could not read claims nothing: Building.
 */
export function stateOf(it: FlightItem, s: ModeFacts | null | undefined, now: number): StateBadge {
  const { plan, run } = it;
  if (it.facts?.phase === "landed" || it.landedAt != null) return badge("landed");
  if (unanswered(it)) return badge("ask", "a question");
  if (isGoCard(it, s)) return badge("go", "your Go");
  if (plan.state === "launched" && it.stopReason && REFUSING.includes(it.stopReason)) return badge("refused", "stop rule");
  if (plan.state === "go" && s?.held) return badge("held", s.heldBy && s.heldBy !== "you" ? "by the orchestrator's hold" : "by your hold");
  if (plan.state === "go" && s?.budgetReached) return badge("held", "budget reached");
  if (plan.state === "draft" || plan.state === "no-go") return badge("writing");
  if (plan.state === "ready" && run?.state === "running") return badge("preflight", `round ${Math.max(1, plan.reviewRounds)}`);
  if (plan.state === "ready") return badge("orchestrator");
  if (plan.state === "go") return badge("queued", "for a slot");
  const steps = stepsOf(plan, it.facts);
  const done = steps !== null && steps.k >= steps.n;
  const builder = plan.builder ?? "unknown";
  if (builder === "gone") {
    /* Only a report that named a step makes it Paused; the plan's own step counts and an unfinished `of` do not. */
    if (plan.lastReport?.step == null) return badge("stopped", "tab died mid-step");
    return done ? badge("ready") : badge("paused", "no builder tab");
  }
  if (it.facts?.phase === "checking" || (builder === "live" && done)) return badge("checking");
  const since = plan.lastReport?.at ?? plan.launched?.at;
  if (builder === "live" && since != null && now - since > QUIET_MS) return badge("quiet", `no report ${minutes(now - since)} min`);
  return badge("building", steps ? `${steps.k} of ${steps.n} steps` : null);
}

/**
 * Waiting on you / Flying / On the ground / Landed today. A plan said No-go to is in History, so it is in none.
 * On the ground (Paused, Stopped, Queued, Held) holds no builder and costs nothing.
 */
export function flightGroups(items: FlightItem[], now: number, s?: ModeFacts | null): Record<GroupId, FlightItem[]> {
  const g: Record<GroupId, FlightItem[]> = { waiting: [], flying: [], ground: [], landed: [] };
  for (const it of items) {
    if (groupOf(it.plan, it.run) === null) continue;
    const k = stateOf(it, s, now).group;
    if (k === "landed" && when(it.landedAt ?? it.facts?.landedAt ?? now, now) !== "today") continue;
    g[k].push(it);
  }
  return g;
}

/* ------------------------------------------------------------------ stations */

export interface StationFacts {
  pilot: Pilot;
  /** False when nobody is seated: the plan is flown as Manual. */
  seated?: boolean;
  stopReason?: StopReason | null;
  /** A question is waiting on the person: the Go station is the "ask". */
  asking?: boolean;
  /** How far the builder got once launched; a launched plan with none is still building. */
  phase?: "building" | "checking" | "landed";
}

/** The six stations of a flight with the actor of each and the one that is current. */
export function stationsFor(plan: Plan, run: Run | null, f: StationFacts): Station[] {
  const manual = f.pilot === "manual" || f.seated === false;
  const goActor: Actor = manual || f.pilot !== "autopilot" || f.stopReason || f.asking ? "person" : "coordinator";
  const decided = plan.state === "go" || plan.state === "no-go" || plan.state === "launched";
  const launched = plan.state === "launched";
  const phase = f.phase ?? (launched ? "building" : null);
  const reviewState: StationState | "pending" = plan.size === "S" || run?.state === "declined" ? "skipped" : run?.state === "done" ? "done" : "pending";
  const base: Record<StationId, StationState | "pending"> = {
    write: written(plan) ? "done" : "pending",
    review: decided && reviewState === "pending" ? "skipped" : reviewState,
    go: decided ? "done" : "pending",
    build: phase === "checking" || phase === "landed" ? "done" : plan.state === "no-go" ? "skipped" : "pending",
    check: phase === "landed" ? "done" : plan.state === "no-go" ? "skipped" : "pending",
    merge: phase === "landed" ? "done" : plan.state === "no-go" ? "skipped" : "pending",
  };
  /* Integrate is the person's own act in Manual (nobody else merges), the coordinator's otherwise; the check follows the same rule. */
  const actors: Record<StationId, Actor> = { write: manual ? "person" : "coordinator", review: "reviewer", go: goActor, build: "builder", check: manual ? "person" : "coordinator", merge: manual ? "person" : "coordinator" };
  let cur = false;
  return STATIONS.map((id): Station => {
    const b = base[id];
    if (b === "skipped") return { id, state: "skipped", actor: null };
    if (b === "done") return { id, state: "done", actor: actors[id] };
    const asks = id === "go" && f.asking === true;
    if (cur) return { id, state: "todo", actor: actors[id], ...(asks ? { ask: true } : {}) };
    cur = true;
    return { id, state: actors[id] === "person" ? "waiting" : "current", actor: actors[id], ...(asks ? { ask: true } : {}) };
  });
}

/* --------------------------------------------------------------------- strip */

export interface StripCounts {
  /** Rows in the Flying group, rows waiting on the person, builders whose tab is open, rows on the ground (they hold no builder and cost nothing). */
  flying: number; waiting: number; live: number; onGround: number;
  /** Findings the coordinator handled today, and how many times it asked the person. */
  handledToday: number; askedToday: number;
  /** Plans ready for the person's Go. */
  goReady: number;
  /** Manual: plans that need answers, and how many findings those hold. */
  needAnswers: number; findingsToAnswer: number;
}
export type StripButtonId = "hold" | "review-go" | "open-next" | "resume" | "raise";
export interface StripButton { id: StripButtonId; label: string; count?: number; tone: "danger" | "go" | "plain"; disabled?: boolean }
export interface Strip {
  mode: Pilot | "held" | "budget";
  badge: string;
  /** The bold opening of the sentence, then the whole sentence. */
  lead: string; sentence: string;
  meters: { today: { used: number; cap: number }; week: { used: number; cap: number } };
  button: StripButton;
  /** Held only: the quieter second way out. */
  secondary?: { id: "to-copilot"; label: string };
}

export const hhmm = (at: number): string => { const d = new Date(at); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const times = (n: number): string => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
const asked = (n: number): string => (n === 0 ? "has not asked you" : `asked you ${times(n)}`);

/** "Held by you at 10:44." with whatever the engine knows of who and when. */
const heldLead = (s: Pick<PilotSnapshot, "heldBy" | "heldAt">): string =>
  `Held${s.heldBy ? ` by ${s.heldBy === "you" ? "you" : "the orchestrator"}` : ""}${s.heldAt ? ` at ${hhmm(s.heldAt)}` : ""}.`;

/** "2 builders live, 3 on the ground." — only builders with an open tab count as live; the ground holds none and costs nothing. */
const fleet = (c: StripCounts): string => (c.live || c.onGround ? ` ${plural(c.live, "builder")} live, ${c.onGround} on the ground.` : "");

/** The status strip: same slots in every mode, so nothing jumps between them. */
export function stripFor(s: PilotSnapshot, c: StripCounts): Strip {
  const meters = { today: { used: s.budget.todayUsd, cap: s.budget.dailyUsd }, week: { used: s.budget.weekUsd, cap: s.budget.weeklyUsd } };
  const pilot = effectivePilot(s);
  if (s.held) {
    return {
      mode: "held", badge: "Autopilot held", lead: heldLead(s),
      sentence: `${heldLead(s)} No new Go. Builders were told to stop at their next safe point; their worktrees are kept.${fleet(c)}`,
      meters, button: { id: "resume", label: "Resume", tone: "go" }, secondary: { id: "to-copilot", label: "Hand to Co-pilot" },
    };
  }
  if (pilot === "autopilot" && s.budgetReached) {
    const day = s.budgetReached === "day";
    const used = usd(day ? s.budget.todayUsd : s.budget.weekUsd);
    return {
      mode: "budget", badge: day ? "Co-pilot until tomorrow" : "Co-pilot until next week", lead: `Budget reached: ${used} ${day ? "today" : "this week"}.`,
      sentence: `Budget reached: ${used} ${day ? "today" : "this week"}. Autopilot comes back ${day ? "at midnight" : "on Monday"}. Plans keep being written and reviewed; Go is yours until then.${fleet(c)}`,
      meters, button: { id: "raise", label: day ? "Raise for today" : "Raise for this week", tone: "plain" },
    };
  }
  if (pilot === "autopilot") {
    const lead = `${plural(c.live, "builder")} live, ${c.waiting} waiting on you, ${c.onGround} on the ground.`;
    return {
      mode: "autopilot", badge: "Autopilot", lead, sentence: `${lead} On the ground costs nothing. The orchestrator handled ${plural(c.handledToday, "finding")} today and ${asked(c.askedToday)}.`,
      meters, button: { id: "hold", label: "Hold", tone: "danger" },
    };
  }
  if (pilot === "copilot") {
    const lead = c.goReady ? `${c.goReady} ready for your Go.` : "Nothing waits for your Go.";
    return {
      mode: "copilot", badge: "Co-pilot", lead,
      sentence: c.goReady ? `${lead} Written, reviewed and answered by the orchestrator; nothing left but your word.${fleet(c)}` : `${lead} The orchestrator writes, reviews and answers.${fleet(c)}`,
      meters, button: { id: "review-go", label: "Review Go", count: c.goReady, tone: "go", ...(c.goReady ? {} : { disabled: true }) },
    };
  }
  const waits = c.needAnswers + c.goReady;
  const seatless = s.seat === null && s.pilot !== "manual";
  const detail = [c.needAnswers ? `${c.needAnswers} ${c.needAnswers === 1 ? "needs" : "need"} ${c.findingsToAnswer ? `answers to ${plural(c.findingsToAnswer, "finding")}` : "an answer"}` : "", c.goReady ? `${c.goReady} ${c.goReady === 1 ? "is" : "are"} ready for Go` : ""].filter(Boolean).join(", ");
  const lead = seatless ? "Nobody is seated in this project, so you fly." : "You fly.";
  return {
    mode: "manual", badge: "Manual", lead,
    sentence: `${lead}${waits ? ` ${plural(waits, "plan")} ${waits === 1 ? "waits" : "wait"} for you: ${detail}.` : " Nothing waits for you."}${seatless ? " Seat an orchestrator to use Co-pilot or Autopilot." : ""}${fleet(c)}`,
    meters, button: { id: "open-next", label: "Open next", tone: "plain", ...(waits ? {} : { disabled: true }) },
  };
}

/* ----------------------------------------------------------------------- rows */

/** "4 min ago", "just now", "2 h ago". */
export function ago(at: number, now: number): string {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

export interface RowNow {
  /** What is happening, and the line that explains it. */
  bold: string; sub: string;
  /** Who acts next, in words, and the builder's last report as "4 min ago · tests added" (null: none yet). */
  next: string; report: string | null;
  state: StateBadge;
}
/** What a flight is doing right now: what is happening, who acts next, when the builder last reported. */
export function flightNow(it: FlightItem, s: ModeFacts | null | undefined, now: number): RowNow {
  const { plan, run } = it;
  const f = it.facts;
  const state = stateOf(it, s, now);
  const rep = plan.lastReport ?? (f?.report ? { line: f.report.text, at: f.report.at } : null);
  const report = rep ? `${ago(rep.at, now)} · ${rep.line}` : null;
  const asks = (it.questions ?? []).filter((q) => q.answer === null);
  const row = (bold: string, sub: string, next: string): RowNow => ({ bold, sub, next, report, state });
  switch (state.id) {
    case "ask": return row(asks.length === 1 ? "One question for you" : `${asks.length} questions for you`, asks[0]!.text, "you answer the question");
    case "go": {
      const open = openCount(run);
      return row("Ready for your Go", it.stopReason && effectivePilot(s) === "autopilot" ? stopCopy(it.stopReason) : open ? `${plural(open, "finding")} still open, advisory.` : "Written and reviewed; nothing left but your word.", "you say Go or No-go");
    }
    case "landed": return row("Landed", "Merged into local main.", "nobody, it moves to History tomorrow");
    case "writing": return row(plan.state === "no-go" ? "Sent back to the author" : "Writing the plan", plan.state === "no-go" ? "The author is rewriting it after the No-go." : "The author is writing it.", "the author finishes the draft");
    case "queued": return row("Queued", "Go is said; it waits for a free slot.", "nobody, it starts by itself when a slot frees");
    case "preflight": return row("Preflight reading", plan.reviewRounds > 1 ? "Looking again after the fix, with no context." : "A reviewer with no context is reading the plan.", "the reviewer, with no context");
    case "orchestrator": return row(effectivePilot(s) === "autopilot" ? "Waiting for the orchestrator" : "Ready", "Preflight is done.", "the orchestrator says Go (Autopilot)");
    case "checking": return row("Orchestrator checking", rep ? `Builder done · ${rep.line}` : "The builder is done.", "the orchestrator runs the checks");
    case "ready": return row("Checked, waiting to merge", "The builder is done and the checks are green.", effectivePilot(s) === "manual" ? "you merge it into main" : "the orchestrator merges it into main");
    case "held": return row(s?.held ? "Held" : "Budget reached", s?.held ? "Go is said; no builder starts while the hold lasts." : "Go is said; nothing starts until the budget comes back.", s?.held ? "you lift the hold" : `nobody, it resumes when the budget does${s?.budgetUntil ? ` at ${hhmm(s.budgetUntil)}` : ""}`);
    case "refused": return row("Refused before landing", it.stopReason ? stopCopy(it.stopReason) : "A stop rule fired.", "you approve the landing or send it back");
    case "paused": return row("Builder tab closed", "Nothing runs and nothing is spent; the work is kept on its branch.", "nobody, waiting for a relaunch");
    case "stopped": return row("Tab died with work unfinished", "The builder tab closed before any report; the branch keeps what it wrote.", "nobody, waiting for a relaunch");
    case "quiet": return row(`Builder live, silent ${state.sub?.replace("no report ", "") ?? ""}`, "The tab is open but has not reported; it may be waiting on a permission prompt.", `the orchestrator looks at tab ${plan.launched?.window ?? ""}`.trim());
    default: {
      const steps = stepsOf(plan, f);
      return row(`Building${steps ? ` · ${steps.k} of ${steps.n} steps` : ""}`, rep ? `Last report ${ago(rep.at, now)}: ${rep.line}` : "Launched; the builder reports to the orchestrator.", "the builder, then the orchestrator checks");
    }
  }
}

/** The one sentence of the detail: what is happening, who acts next, when the builder last reported. */
export function stateSentence(n: RowNow): string {
  /* The tile already says the state word; the sentence says why, then who acts next and the last report. A building row's sub is that report again. */
  const why = n.sub.startsWith("Last report") ? "" : `${n.sub.replace(/\.$/, "")}. `;
  return `${why}Next: ${n.next}. ${n.report ? `Last report ${n.report}.` : "Last report: none yet."}`;
}

export type RowAction =
  | { kind: "answer"; label: string } | { kind: "go"; label: string } | { kind: "handled"; label: string }
  | { kind: "open-tab" | "open-branch" | "lift-hold" | "decide"; label: string };
/** The one thing on the right of a row: the button its state allows (Open tab, Open branch, Lift hold, Decide, Answer, Review Go), else what was handled. */
export function rowAction(it: FlightItem, s: ModeFacts | null | undefined, now = Date.now()): RowAction {
  const id = stateOf(it, s, now).id;
  if (id === "ask") return { kind: "answer", label: "Answer" };
  if (id === "go") return { kind: "go", label: "Review Go" };
  if (id === "building" || id === "quiet") return { kind: "open-tab", label: "Open tab" };
  if (id === "paused" || id === "stopped" || id === "ready") return { kind: "open-branch", label: "Open branch" };
  if (id === "held" && s?.held) return { kind: "lift-hold", label: "Lift hold" };
  if (id === "refused") return { kind: "decide", label: "Decide" };
  return { kind: "handled", label: handledChip(it.facts?.handled ?? { fixed: 0, contested: 0, dismissed: 0 }) };
}

/** Everything the strip's sentence is made of, counted from the flights. */
export function stripCounts(items: FlightItem[], now: number, s?: ModeFacts | null): StripCounts {
  const g = flightGroups(items, now, s);
  const startOfDay = new Date(now).setHours(0, 0, 0, 0);
  const qs = items.flatMap((it) => it.questions ?? []).filter((q) => q.askedAt >= startOfDay);
  const handled = items.reduce((n, it) => n + (it.facts?.handled ? it.facts.handled.fixed + it.facts.handled.contested + it.facts.handled.dismissed : 0), 0);
  const goCards = g.waiting.filter((it) => !unanswered(it));
  const open = (it: FlightItem) => openCount(it.run);
  const manualAnswers = g.waiting.filter((it) => unanswered(it) || open(it) > 0);
  return {
    flying: g.flying.filter((it) => it.plan.state === "launched").length, waiting: g.waiting.length,
    live: items.filter((it) => it.plan.state === "launched" && it.plan.builder === "live" && it.landedAt == null).length, onGround: g.ground.length,
    handledToday: handled, askedToday: qs.length,
    goReady: effectivePilot(s) === "manual" ? goCards.filter((it) => open(it) === 0).length : goCards.length,
    needAnswers: manualAnswers.length, findingsToAnswer: manualAnswers.reduce((n, it) => n + open(it), 0),
  };
}

/** Plans waiting on the person, first the ones with a question: the order "Open next" walks. */
export const nextWaiting = (items: FlightItem[], now: number, s?: ModeFacts | null): FlightItem | null =>
  flightGroups(items, now, s).waiting.sort((a, b) => unanswered(b) - unanswered(a))[0] ?? null;

/**
 * The six stations of one flight, as the engine's facts and the mode say. The state then marks the build
 * station of a flight that is not flying: parked (tab closed after a report), dead (closed with none), held.
 */
export function stationsOf(it: FlightItem, s: Pick<PilotSnapshot, "pilot" | "seat"> & Partial<ModeFacts>, now = Date.now()): Station[] {
  const st = stateOf(it, { held: false, budgetReached: null, ...s }, now).id;
  const phase = it.facts?.phase ?? (it.landedAt != null ? "landed" : st === "checking" || st === "ready" || st === "refused" ? "checking" : undefined);
  const out = stationsFor(it.plan, it.run, { pilot: s.pilot, seated: s.seat !== null, stopReason: it.stopReason ?? null, asking: unanswered(it) > 0, ...(phase ? { phase } : {}) });
  const mark = (id: StationId, state: StationState): void => { const x = out.find((y) => y.id === id); if (x) x.state = state; };
  if (st === "paused") mark("build", "parked");
  else if (st === "stopped") mark("build", "dead");
  else if (st === "held") mark("build", "held");
  else if (st === "queued") mark("build", "todo");
  else if (st === "refused" || st === "ready") {
    mark("check", "done");
    const m = out.find((y) => y.id === "merge");
    if (m) m.state = st === "refused" || m.actor === "person" ? "waiting" : "current";
  }
  return out;
}

export interface RowMeta { size: Plan["size"]; project: string; who: string; builder: { branch: string; tab?: string } | null }
/** The small line under a row's title: size, project, who started it, or which builder has it. */
export function rowMeta(it: FlightItem): RowMeta {
  const { plan, facts: f } = it;
  const launched = plan.state === "launched" && f?.builder;
  const by = plan.createdBy ? ` by ${plan.createdBy === "you" ? "you" : plan.createdBy.startsWith("coordinator:") ? "the orchestrator" : plan.createdBy}` : "";
  const who = plan.size === "S" && !plan.preflightRunId ? "no Preflight · small" : `started${by} ${hhmm(plan.createdAt)}${plan.decision?.by.startsWith("coordinator:") ? " · Go by the orchestrator" : ""}`;
  return { size: plan.size, project: projectName(plan.root), who, builder: launched ? f!.builder! : null };
}

/** "3 fixed, 1 dismissed as noise", or "" when the coordinator handled nothing. */
export function handledLine(h: Handled): string {
  return [h.fixed ? `${h.fixed} fixed` : "", h.contested ? `${h.contested} contested` : "", h.dismissed ? `${h.dismissed} dismissed as noise` : ""].filter(Boolean).join(", ");
}

/** The sentence under a Go card's title: what the plan is, what Preflight cost, and where the builder runs. */
export function goSentence(plan: Plan, run: Run | null): string {
  const c = run?.certificate;
  const files = c ? c.files.length + c.mockups.length : 0;
  const shots = plan.mockups.length;
  const what = [plan.size ?? "", files ? `${files} ${files === 1 ? "file" : "files"}` : "", shots ? (shots === 1 ? "one mockup" : `${shots} mockups`) : ""].filter(Boolean).join(" · ");
  return `${what ? `${what}. ` : ""}${c ? `Preflight ${usd(c.costUsd)}. ` : ""}The builder runs in your permission mode, in its own worktree, and reports to the orchestrator.`;
}

/** "you", "the orchestrator", or an agent's name: who a decision or an act belongs to. */
export const whoIs = (by: string): string => (by === "you" ? "you" : by.startsWith("coordinator:") ? "the orchestrator" : by);

/** "14 min", "2 h 5 min": how long a state has lasted. */
export function lasted(since: number, now: number): string {
  const m = minutes(now - since);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** The builder's facts for the detail's side column; every row is a fact the engine holds, so a missing one is left out. */
export function builderFacts(plan: Plan): { k: string; v: string; bad?: boolean }[] {
  const l = plan.launched;
  if (plan.state !== "launched" || !l) return [];
  const steps = stepsOf(plan);
  return [
    ...(l.branch ? [{ k: "Branch", v: l.branch }] : []),
    ...(plan.builder === "gone" ? [{ k: "Tab seen closed", v: plan.goneAt ? hhmm(plan.goneAt) : "just now", bad: true }] : l.window ? [{ k: "Tab", v: `${l.window}${plan.builder === "unknown" ? " · not read" : ""}` }] : []),
    ...(plan.decision ? [{ k: "Go", v: `by ${whoIs(plan.decision.by)} ${hhmm(plan.decision.at)}` }] : []),
    ...(steps ? [{ k: "Steps", v: `${steps.k} of ${steps.n}` }] : []),
  ];
}
