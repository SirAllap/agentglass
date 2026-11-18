/*
 * Guide mode's server half: which tabs are being guided, and the lock that
 * comes with it.
 *
 * A guide is an agent walking the person through a page step by step: it
 * points, says what to do, and waits for the person's own hand. The point is a
 * risky step on a production page done by the person, so while a tab is
 * guided NOTHING an agent sends may act on it — not the guiding agent, not
 * another one, named or not. Reads stay open to everybody; the guide verbs
 * (`point`, `guide next`, `guide end`) belong to the agent that started it.
 *
 * Held here, at the relay, because this is the one door every ask passes: a
 * lock in the panel would be one more thing a `do` list, a lane or a retry
 * could route around. A refused act never reaches the panel, so the person's
 * log and dock never hear of it; it goes to the guide's own audit list and to
 * the agent's error, and nowhere else.
 *
 * Kept on disk as well as in memory. The server restarts by itself (respawn,
 * an install), and a lock that lived only in memory would come back gone in
 * the middle of somebody's production step: the agent's next click would go
 * through and nothing would say so. So every change is written to
 * `browser-guides.json` in the state dir and read back on first use. Failing
 * that way round is the safe one: after a restart the person may see no bubble
 * while acts are still refused, until the agent's `guide end` or the idle clock.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { foldWorkerName } from "../../shared/workerContainer.ts";

/** What ended a step's wait: the person's buttons, their click on the target, or the page leaving. */
export type GuideEvent = "ok" | "back" | "stop" | "click" | "done" | "navigated" | "closed" | "takeover"
  | "input" | "submit" | "lost" | "run-done" | "resumed";
export const GUIDE_EVENTS: readonly GuideEvent[] = ["ok", "back", "stop", "click", "done", "navigated", "closed", "takeover", "input", "submit", "lost", "run-done", "resumed"];

export interface GuideStep {
  n: number;
  /** The selector the agent pointed with: a locator, never a value. */
  target: string;
  say: string;
  /** `--copy`: the exact text the card offered the person to copy. */
  copy?: string;
  /** `--suggest`: the draft the card offered to put in the field. */
  suggest?: string;
  /** `--summary`: what the page is about, shown before the person acts. */
  summary?: string;
  /** When the person put that draft in the field (it does not end the step). */
  suggestInsertedAt?: number;
  waitClick: boolean;
  /** `--step 2/4`, as given; absent means the bubble shows no step label. */
  label?: string;
  at: number;
  /** What the page calls the element (its label or short text) and its role. */
  name?: string;
  role?: string;
  /** False when the panel could not follow the element and drew the last rect. */
  followed?: boolean;
  event?: GuideEvent;
  eventAt?: number;
  /** The address the page moved to, for `navigated`. */
  url?: string;
}

export interface GuideRefusal { op: string; as?: string; at: number }

export interface Guide {
  tab: string;
  as: string;
  why: string;
  startedAt: number;
  lastAt: number;
  steps: GuideStep[];
  refused: GuideRefusal[];
  /* The lock, kept apart from `run`: a run ends (done, restart, overflow) and
     the tab stays locked until the person's End or the agent's guide end. */
  locked?: boolean;
  /** `guide run`: the plan the server walks on the panel's events. */
  run?: GuideRun;
  endedAt?: number;
  /** Who ended it: the agent (`guide end`), the person (Stop, Take over), the tab closing, or the idle clock. */
  endedBy?: "agent" | "stop" | "takeover" | "closed" | "idle" | "site";
}

/** A guide nobody has touched for this long is let go: an agent that died mid-guide must not lock a tab forever. */
export const GUIDE_IDLE_MS = 30 * 60_000;

const live = new Map<string, Guide>();

/* Where the lock survives a restart. Same state dir as the container ledger. */
function storeFile(): string {
  const dir = process.env.AGENTGLASS_STATE_DIR
    || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentglass");
  return join(dir, "browser-guides.json");
}
let loaded = false;
function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const rows = JSON.parse(readFileSync(storeFile(), "utf8")) as unknown;
    if (!Array.isArray(rows)) return;
    for (const g of rows as Guide[]) {
      if (g && typeof g.tab === "string" && typeof g.why === "string" && typeof g.lastAt === "number" && Array.isArray(g.steps)) {
        const back: Guide = { ...g, as: typeof g.as === "string" ? g.as : "", refused: Array.isArray(g.refused) ? g.refused : [], locked: true };
        /* A run does not survive a restart: nothing was watching the page
           meanwhile. It ends, the agent hears it, and the lock stays. */
        if (back.run && !back.run.endedAt) endRun(back, "restart", clock(), false);
        live.set(g.tab, back);
      }
    }
  } catch { /* no file: no guide was on */ }
}
/** Written after every change; a failed write keeps the lock in memory, never drops it. */
function save(): void {
  try {
    const f = storeFile();
    if (live.size === 0) { rmSync(f, { force: true }); return; }
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f + ".part", JSON.stringify([...live.values()]));
    renameSync(f + ".part", f);
  } catch { /* the memory copy still holds */ }
}
/* A guide the person ended (Stop, Take over, the tab closed), kept until its
   agent's `guide end` collects the audit — by name, because the tab is gone or
   no longer guided. One per name: a newer one replaces it. */
const ended = new Map<string, Guide>();

let clock: () => number = () => Date.now();
/** For tests: a clock of their own. */
export function setGuideClock(fn: (() => number) | null): void { clock = fn ?? (() => Date.now()); }
export const guideNow = () => clock();

function sweep(now: number): void {
  load();
  for (const g of [...live.values()]) if (now - g.lastAt > GUIDE_IDLE_MS) finishGuide(g, "idle", now);
}

/* The same caller: names compared folded, and two nameless callers are the
   same one (the MCP surface and hand-written clients send no name, and a
   guide they start must still be theirs to point, wait on and end). */
export const sameCaller = (a: string | undefined, b: string | undefined) =>
  foldWorkerName(a ?? "") === foldWorkerName(b ?? "");
const same = sameCaller;

export function guideOf(tab: string): Guide | undefined {
  sweep(clock());
  return live.get(tab);
}

/** The live guide this caller runs: on `tab` when given, else the only one under its name. */
export function guideFor(as: string | undefined, tab?: string): Guide | undefined {
  sweep(clock());
  if (tab) return live.get(tab);
  return [...live.values()].find((g) => same(g.as, as));
}

export function guideCount(): number {
  sweep(clock());
  return live.size;
}

export function startGuide(tab: string, as: string, why: string): { guide: Guide } | { error: string } {
  const now = clock();
  sweep(now);
  const cur = live.get(tab);
  if (cur) {
    return same(cur.as, as)
      ? { error: `this tab is already being guided by you (guide start "${cur.why}", ${hhmm(cur.startedAt)}): point at the next step, or guide end first` }
      : { error: othersRefusal(cur, "guide start") };
  }
  const guide: Guide = { tab, as, why, startedAt: now, lastAt: now, steps: [], refused: [], locked: true };
  live.set(tab, guide);
  ended.delete(foldWorkerName(as));
  save();
  return { guide };
}

export function addStep(g: Guide, s: Omit<GuideStep, "n" | "at">): GuideStep {
  const now = clock();
  const step: GuideStep = { ...s, n: g.steps.length + 1, at: now };
  g.steps.push(step);
  g.lastAt = now;
  save();
  return step;
}

/** The person answered (or the page moved): written on the step being waited on, and ends the guide when it was a way out. */
export function noteEvent(g: Guide, event: GuideEvent, url?: string): GuideStep | undefined {
  const now = clock();
  g.lastAt = now;
  const step = g.steps[g.steps.length - 1];
  if (step && !step.event) {
    step.event = event;
    step.eventAt = now;
    if (url) step.url = url;
  }
  if (event === "stop") finishGuide(g, "stop", now);
  else if (event === "takeover") finishGuide(g, "takeover", now);
  else if (event === "closed") finishGuide(g, "closed", now);
  save();
  return step;
}

export function touchGuide(g: Guide): void { g.lastAt = clock(); save(); }

export function finishGuide(g: Guide, by: NonNullable<Guide["endedBy"]>, now = clock()): Guide {
  if (live.get(g.tab) === g) live.delete(g.tab);
  if (g.run && !g.run.endedAt) endRun(g, by === "agent" ? "agent" : by === "stop" ? "stop" : "closed", now, false);
  if (!g.endedAt) { g.endedAt = now; g.endedBy = by; }
  if (by !== "agent") ended.set(foldWorkerName(g.as), g);
  else ended.delete(foldWorkerName(g.as));
  save();
  return g;
}

/** A guide the person ended, for its agent's `guide end` to collect. Taken once. */
export function takeEnded(as: string | undefined, keep = false): Guide | undefined {
  const k = foldWorkerName(as ?? "");
  const g = ended.get(k);
  if (!keep) ended.delete(k);
  return g;
}

/** Tests: forget every guide, on disk too. `reload` reads the file again, as a restarted server would. */
export function resetGuides(reload = false): void {
  live.clear(); ended.clear();
  for (const f of runWaiters.values()) f();
  runWaiters.clear();
  if (reload) { loaded = false; return; }
  loaded = true;
  save();
}

export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* Whoever started the guide, for a sentence. The person's own guide (the
   MCP surface, a hand-written client) carries no name, and "It is 's guide"
   tells a stuck caller nothing. */
const ownerName = (g: Guide): string | null => (g.as ?? "").trim() || null;
const whoseGuide = (g: Guide): string => { const n = ownerName(g); return n ? `${n}'s guide` : "the person's guide"; };

/**
 * The sentence an agent gets for an act on a guided tab: which layer refused,
 * under which rule, what to do instead, and how to lift it — the guiding agent
 * can end its own guide; anybody else is told whose it is.
 */
export function actRefusal(g: Guide, op: string, as: string | undefined): string {
  const head = `"${op}" refused by: browser server, guide mode (guide start "${g.why}", ${hhmm(g.startedAt)}). `
    + "This tab is in guide mode: the person clicks, agents only point and read. ";
  return same(g.as, as)
    ? head + `Do this instead: point <selector> --say "…", then guide next. To act again: guide end.`
    : head + `It is ${whoseGuide(g)}. Reading this tab still works; to act, use a tab of your own (open --as <you> <url>) or wait for ${whoseGuide(g)} to end.`;
}

/** For a guide verb from an agent that is not the guide's. */
export function othersRefusal(g: Guide, verb: string): string {
  const who = ownerName(g) ?? "the person";
  return `"${verb}" refused by: browser server, guide mode: this tab is being guided by ${who} `
    + `(guide start "${g.why}", ${hhmm(g.startedAt)}). Only ${who} may point, wait or end it; reading this tab still works.`;
}

/**
 * The lock, for one ask. `target` is the tab the ask names (its `page`, or
 * the id of a tab verb); with none, an ask aimed at a page goes to whichever
 * tab is in front, which may be the guided one, so it is refused while any
 * guide is on — the cost is an agent re-asking with its own `--page`, the
 * other way round is a click on the person's production page.
 * Returns the refusal, already written into the guide's audit, or null.
 */
export function guideLock(op: string, acting: boolean, target: string | undefined, pageBound: boolean, as: string | undefined): string | null {
  if (!acting) return null;
  const now = clock();
  sweep(now);
  if (live.size === 0) return null;
  let g: Guide | undefined;
  if (target) g = live.get(target);
  else if (pageBound) g = [...live.values()].find((x) => same(x.as, as)) ?? [...live.values()][0];
  if (!g || g.locked === false) return null;
  g.refused.push({ op, ...(as ? { as } : {}), at: now });
  save();
  return actRefusal(g, op, as);
}

/** What the person did on a step, in words, for the audit. A role and a name, never a value. */
export function stepDid(s: GuideStep): string {
  const what = [s.name, s.role].filter(Boolean).join(", ");
  switch (s.event) {
    case "ok": return "pressed OK";
    case "done": return "pressed Done";
    case "back": return "pressed Back";
    case "stop": return "pressed Stop";
    case "click": return what ? `clicked ${what}` : "clicked the target";
    case "navigated": return s.url ? `the page moved to ${s.url}` : "the page moved on";
    case "closed": return "closed the tab";
    case "takeover": return "took the tab over";
    default: return "no answer yet";
  }
}

/** Where the person ended up: the last address a step saw the page move to (a run's own, when it has one). */
function lastUrl(g: Guide): string | undefined {
  if (g.run?.url) return g.run.url;
  for (let i = g.steps.length - 1; i >= 0; i--) if (g.steps[i]!.url) return g.steps[i]!.url;
  return undefined;
}

/** `guide end`'s answer: every step with what the person did and when, plus what the agent tried and was refused. */
export function guideAudit(g: Guide): Record<string, unknown> {
  const end = g.endedAt ?? clock();
  return {
    why: g.why,
    tab: g.tab,
    as: g.as,
    startedAt: new Date(g.startedAt).toISOString(),
    endedAt: new Date(end).toISOString(),
    seconds: Math.round((end - g.startedAt) / 1000),
    endedBy: g.endedBy ?? "agent",
    ...(lastUrl(g) ? { url: lastUrl(g) } : {}),
    steps: g.steps.map((s, i) => ({
      n: s.n, target: s.target, say: s.say, waitClick: s.waitClick,
      ...(s.summary ? { summary: true } : {}),
      /* Until the person's answer, else until the next step was pointed, else until the end. */
      seconds: Math.round(((s.event ? s.eventAt ?? s.at : g.steps[i + 1]?.at ?? end) - s.at) / 1000),
      ...(s.label ? { label: s.label } : {}),
      ...(s.name ? { name: s.name } : {}), ...(s.role ? { role: s.role } : {}),
      ...(s.followed === false ? { followed: false } : {}),
      at: new Date(s.at).toISOString(),
      did: stepDid(s),
      ...(s.event ? { event: s.event, eventAt: new Date(s.eventAt ?? s.at).toISOString() } : {}),
      ...(s.url ? { url: s.url } : {}),
    })),
    ...(g.run ? { run: runSummary(g.run) } : {}),
    agentActs: 0,
    refusedCount: g.refused.length,
    refused: g.refused.map((r) => ({ op: r.op, ...(r.as ? { as: r.as } : {}), at: new Date(r.at).toISOString() })),
  };
}

/* ---------- guide run: a plan the server walks on the person's events ---------- */

/** What ends a step's wait. `ok` is the card's OK button; the rest are the person's own hand on the page. */
export type GuideWait = "ok" | "click" | "nav" | "input" | "submit";
export const GUIDE_WAITS: readonly GuideWait[] = ["ok", "click", "nav", "input", "submit"];

/** One step of a plan: where to point (a selector, never an observe id), what to say, what ends it. Data only: a plan never acts. */
export interface PlanStep { target?: string; text?: string; say: string; wait: GuideWait; copy?: string; summary?: string; suggest?: string }

/* A say the person can act on holds a word: "…", "''" or "-" is a failed --say
   (an empty shell variable, a lost quote), and the card would show no instruction. */
export function sayHasWords(say: string): boolean {
  return /[\p{L}\p{N}]/u.test(say);
}
export const SAY_NO_WORDS = "has no words: the person reads only the card, so say what to do there (a failed shell quote or an empty variable leaves only punctuation)";

/** The card's line on a summary step given no say: a real instruction, never a bare "Got it". */
export const SUMMARY_SAY = "Read what this page is about, then press OK.";

/** Why one visit of a step ended. */
export type VisitEnd = "target" | "ok" | "nav" | "input" | "submit" | "back" | "stop" | "lost" | "restart" | "overflow" | "agent" | "closed";

/** One visit of one step: Back makes a step visited twice, and each visit is its own row. */
export interface RunVisit {
  n: number; visit: number; waited: GuideWait; startedAt: number; endedAt?: number; endedBy?: VisitEnd;
  url?: string; clicks: number; lost?: boolean;
}

export type RunEnd = "done" | "stop" | "restart" | "overflow" | "agent" | "closed";

/** What `guide next` hands the agent, in order. */
export interface RunEvent { event: GuideEvent | "step" | "regenerate"; step?: number; of?: number; url?: string; [k: string]: unknown }

export interface GuideRun {
  steps: PlanStep[];
  /** 0-based: the step on the card. */
  index: number;
  visits: RunVisit[];
  queue: RunEvent[];
  /** Every event this run ever queued: the cap counts these, not what is still unread. */
  emitted: number;
  startedAt: number;
  endedAt?: number;
  endedBy?: RunEnd;
  /** The last address the panel reported for the guided tab. */
  url?: string;
  /** `guide run` was asked by a worker under a guide grant: a navigation off its site ends the guide. */
  worker?: string;
}

/** At most this many events per run; the one that reaches it ends the run with `overflow`, so nothing is dropped unsaid. */
export const RUN_EVENT_CAP = 200;
/** Resume is offered on the person's card this long after the run ended. */
export const RESUME_MS = 10 * 60_000;
export const PLAN_MAX_STEPS = 50;

const OBSERVE_ID = /^e\d+$/;

/** A plan as sent, checked: an array of steps, or `{steps: [...]}`. Plan text is kept as data. */
export function parsePlan(raw: unknown): { steps: PlanStep[] } | { error: string } {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { steps?: unknown }).steps) ? (raw as { steps: unknown[] }).steps : null;
  if (!list) return { error: "plan is a list of steps: [{target, say, wait}] or {steps: [...]}" };
  if (list.length === 0) return { error: "plan has no steps" };
  if (list.length > PLAN_MAX_STEPS) return { error: `plan has ${list.length} steps; at most ${PLAN_MAX_STEPS}` };
  const steps: PlanStep[] = [];
  for (const [i, s] of list.entries()) {
    const at = `plan step ${i + 1}`;
    if (!s || typeof s !== "object" || Array.isArray(s)) return { error: `${at} is not an object` };
    const o = s as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!["target", "text", "say", "wait", "copy", "summary", "suggest"].includes(k)) return { error: `${at}: unknown field "${k}" (target, text, say, wait, copy, summary, suggest)` };
    if (o.summary !== undefined && (typeof o.summary !== "string" || !o.summary.trim() || o.summary.length > 2000 || !sayHasWords(o.summary))) return { error: `${at}: summary is what the page is about, in words (1 to 2000 characters)` };
    const summary = typeof o.summary === "string" ? o.summary.trim() : undefined;
    const say = o.say === undefined && summary ? SUMMARY_SAY : o.say;
    if (typeof say !== "string" || !say.trim() || say.length > 2000) return { error: `${at}: say is what the person should do there (1 to 2000 characters)` };
    if (!sayHasWords(say)) return { error: `${at}: say ${SAY_NO_WORDS}` };
    let target: string | undefined;
    if (o.target !== undefined) {
      if (typeof o.target !== "string" || !o.target.trim() || o.target.length > 1000) return { error: `${at}: target is a selector` };
      target = o.target.trim();
      /* An id is good only for a page already observed; a plan is written before the pages exist. */
      if (OBSERVE_ID.test(target)) return { error: `${at}: target "${target}" is an observe id; a plan uses selectors (CSS or a locator like role=button[name="Save"]), with text to pick among matches` };
    }
    if (o.text !== undefined && (typeof o.text !== "string" || !o.text.trim() || o.text.length > 200)) return { error: `${at}: text is the label that picks one of several matches (at most 200 characters)` };
    if (o.text !== undefined && !target) return { error: `${at}: text goes with target` };
    const wait = o.wait === undefined ? (target && !summary ? "click" : "ok") : o.wait;
    if (!GUIDE_WAITS.includes(wait as GuideWait)) return { error: `${at}: wait is one of ${GUIDE_WAITS.join(", ")}` };
    if (summary && wait !== "ok") return { error: `${at}: a summary step ends on the person's OK, once they have read it: drop wait, or set it to ok` };
    if ((wait === "click" || wait === "input" || wait === "submit") && !target) return { error: `${at}: wait ${String(wait)} needs a target` };
    if (o.copy !== undefined && (typeof o.copy !== "string" || !o.copy.trim() || o.copy.length > 2000)) return { error: `${at}: copy is the text the person will paste (1 to 2000 characters)` };
    if (o.suggest !== undefined && (typeof o.suggest !== "string" || !o.suggest.trim() || o.suggest.length > 2000)) return { error: `${at}: suggest is the draft the person may put in the field (1 to 2000 characters)` };
    if (o.suggest !== undefined && !target) return { error: `${at}: suggest goes with target: the text field the draft is for` };
    steps.push({
      say: say.trim(), wait: wait as GuideWait,
      ...(target ? { target } : {}), ...(typeof o.text === "string" ? { text: o.text.trim() } : {}),
      ...(typeof o.copy === "string" ? { copy: o.copy } : {}),
      ...(summary ? { summary } : {}),
      ...(typeof o.suggest === "string" ? { suggest: o.suggest } : {}),
    });
  }
  return { steps };
}

const SAY_VERBS = new Set(["click", "open", "type", "press", "write", "read", "choose", "select", "scroll", "copy", "paste", "post", "search"]);
/* Words that point back at the chat instead of naming a thing on the page. */
const VAGUE = new Set(["it", "this", "that", "these", "those", "them", "one", "something", "anything", "everything", "here", "there", "what", "whatever", "like", "as", "accordingly", "away"]);
const FILLER = new Set(["the", "a", "an", "on", "in", "into", "at", "to", "for", "your", "my", "our", "its", "their", "of", "with"]);

/**
 * Whether a card can stand on its own: a literal in quotes (or after
 * "Type:" / "Open:" / "Click:"), or an imperative verb from the list followed
 * by a concrete object. "Search for it like you would" fails: no literal, and
 * its verb's object is "it". A warning in `guide run`'s answer, never a refusal.
 */
export function sayStandsAlone(say: string): boolean {
  const t = say.trim();
  if (/["“”'‘’`][^"“”'‘’`]+["“”'‘’`]/.test(t)) return true;
  if (/\b(type|open|click)\s*:\s*\S/i.test(t)) return true;
  /* The verb opens the sentence, or a clause after a colon or a full stop. */
  for (const clause of t.split(/[:.;!?]\s*/)) {
    const words = clause.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [];
    if (!words.length || !SAY_VERBS.has(words[0]!)) continue;
    const obj = words.slice(1).find((w) => !FILLER.has(w));
    if (obj && !VAGUE.has(obj)) return true;
  }
  return false;
}

/** The plan's cards that would not make sense without the chat, as warnings. */
export function lintPlan(steps: readonly PlanStep[]): string[] {
  return steps.flatMap((s, i) => sayStandsAlone(s.say) || s.say === SUMMARY_SAY ? [] : [`step ${i + 1}: say has no literal and no verb with a concrete object ("${s.say.slice(0, 80)}"): the person reads only the card, so name the thing ("Click the 'Reply' button") or quote what to type`]);
}

/* `guide next` on a run waits here: one waiter per tab, woken by a queued event. */
const runWaiters = new Map<string, () => void>();

function pushRun(g: Guide, ev: RunEvent): void {
  const run = g.run!;
  if (run.endedAt && ev.event !== "run-done" && ev.event !== "resumed") return;
  run.queue.push(ev);
  run.emitted++;
  /* The one before the cap is the last thing the run says: it ends, and run-done is the 200th. */
  if (run.emitted >= RUN_EVENT_CAP - 1 && !run.endedAt) endRun(g, "overflow", clock());
  const w = runWaiters.get(g.tab);
  if (w) { runWaiters.delete(g.tab); w(); }
}

function openVisit(run: GuideRun, now: number): RunVisit {
  const n = run.index + 1;
  const visit = run.visits.filter((v) => v.n === n).length + 1;
  const v: RunVisit = { n, visit, waited: run.steps[run.index]!.wait, startedAt: now, clicks: 0, ...(run.url ? { url: run.url } : {}) };
  run.visits.push(v);
  return v;
}

function closeVisit(run: GuideRun, by: VisitEnd, now: number): void {
  const v = run.visits[run.visits.length - 1];
  if (v && !v.endedAt) { v.endedAt = now; v.endedBy = by; if (run.url) v.url = run.url; }
}

/** The visit on the card now, if the run is going. Its number travels with the panel's events, so a late event of an older visit moves nothing. */
export function currentVisit(run: GuideRun): RunVisit | undefined {
  const v = run.visits[run.visits.length - 1];
  return v && !v.endedAt && !run.endedAt ? v : undefined;
}
/** The visit's id the panel echoes: its position in the list, 1-based. */
export const visitSeq = (run: GuideRun): number => run.visits.length;

export function startRun(g: Guide, steps: PlanStep[], worker?: string): GuideRun {
  const now = clock();
  const run: GuideRun = { steps, index: 0, visits: [], queue: [], emitted: 0, startedAt: now, ...(worker ? { worker } : {}) };
  g.run = run;
  g.locked = true;
  openVisit(run, now);
  pushRun(g, { event: "step", step: 1, of: steps.length });
  g.lastAt = now;
  save();
  return run;
}

/** The run ends: its visit closes, and the agent gets run-done with the summary. The lock is the caller's business. */
export function endRun(g: Guide, by: RunEnd, now = clock(), persist = true): void {
  const run = g.run;
  if (!run || run.endedAt) return;
  const visitBy: VisitEnd = by === "done" ? "target" : by;
  if (by !== "done") closeVisit(run, visitBy, now);
  run.endedAt = now;
  run.endedBy = by;
  pushRun(g, { event: "run-done", endedBy: by, steps: run.steps.length, ...(run.url ? { url: run.url } : {}), summary: runSummary(run).rows });
  if (persist) save();
}

/** What the panel reports, from the person's hand on the page or the card's buttons. */
export interface PanelEvent { event: "ok" | "back" | "stop" | "click" | "navigated" | "input" | "submit" | "lost" | "found" | "done"; visit?: number; url?: string }

/** How long a nav step with no target ignores navigations: the page's own redirect lands within it. */
export const NAV_SETTLE_MS = 1500;

/** What changed, so the relay knows what to draw: a new step, the lost sentence, or the end. */
export type RunChange = "step" | "lost" | "found" | "ended" | null;

/**
 * One event from the panel, applied to the run. Only the step's own wait moves
 * it on; Back goes one step back (never ends it); Stop ends it. An event of a
 * visit that is no longer on the card is dropped, except Stop.
 */
export function runInput(g: Guide, e: PanelEvent): RunChange {
  const run = g.run;
  if (!run || run.endedAt) return null;
  const now = clock();
  g.lastAt = now;
  if (e.url) run.url = e.url;
  const v = currentVisit(run);
  if (!v) return null;
  if (e.event !== "stop" && e.visit !== undefined && e.visit !== visitSeq(run)) return null;
  const step = run.steps[run.index]!;
  const next = (by: VisitEnd): RunChange => {
    closeVisit(run, by, now);
    if (run.index + 1 >= run.steps.length) { endRun(g, "done", now); return "ended"; }
    run.index++;
    openVisit(run, now);
    pushRun(g, { event: "step", step: run.index + 1, of: run.steps.length, ...(run.url ? { url: run.url } : {}) });
    return "step";
  };
  let out: RunChange = null;
  switch (e.event) {
    case "stop":
      endRun(g, "stop", now);
      out = "ended";
      break;
    case "back":
      closeVisit(run, "back", now);
      run.index = Math.max(0, run.index - 1);
      openVisit(run, now);
      pushRun(g, { event: "back", step: run.index + 1, of: run.steps.length });
      out = "step";
      break;
    case "click":
      v.clicks++;
      if (step.wait === "click") out = next("target");
      break;
    case "ok": case "done":
      /* OK is the card's own button: it ends an ok step, and a step whose
         target could not be followed (the card then offers Done). */
      if (step.wait === "ok" || v.lost || e.event === "done") out = next("ok");
      break;
    case "navigated":
      pushRun(g, { event: "navigated", step: v.n, ...(e.url ? { url: e.url } : {}) });
      /* Only a navigation that follows the person's own press on the target
         (or a form they sent) answers a nav step that has one: measured, Back
         onto a nav step was answered at once by the page's own redirect, and
         the person was bounced on, four times. A step with no target cannot
         be pressed: there, a navigation in the step's first NAV_SETTLE_MS is
         the page's own redirect (nobody reads the card and acts that fast),
         and a later one answers it. */
      if (step.wait === "nav" && (step.target ? v.clicks > 0 : now - v.startedAt >= NAV_SETTLE_MS)) out = next("nav");
      /* Sending a form usually unloads the page before the guest's submit
         report gets out. A navigation after the person's own press inside
         the target (the form, or its send button) is that submit. */
      else if (step.wait === "submit" && v.clicks > 0) out = next("submit");
      break;
    case "input":
      if (step.wait === "input") out = next("input");
      break;
    case "submit":
      if (step.wait === "submit") out = next("submit");
      /* A form the person sent from a nav step's target is their press: its navigation counts. */
      else if (step.wait === "nav") v.clicks++;
      break;
    case "lost":
      if (!v.lost) {
        v.lost = true;
        pushRun(g, { event: "lost", step: v.n, ...(run.url ? { url: run.url } : {}) });
        out = "lost";
      }
      break;
    case "found":
      if (v.lost) { v.lost = false; out = "found"; }
      break;
  }
  save();
  return out;
}

/** The next event of the run for `guide next`, or undefined when none is queued. */
export function takeRunEvent(g: Guide): RunEvent | undefined {
  const ev = g.run?.queue.shift();
  if (ev) save();
  return ev;
}

/** Waits up to `ms` for the run to queue an event. A newer wait on the tab ends the older one. */
export function waitRunEvent(g: Guide, ms: number): Promise<RunEvent | undefined> {
  const now = takeRunEvent(g);
  if (now || ms <= 0) return Promise.resolve(now);
  runWaiters.get(g.tab)?.();
  return new Promise((res) => {
    const done = () => { clearTimeout(t); if (runWaiters.get(g.tab) === done) runWaiters.delete(g.tab); res(takeRunEvent(g)); };
    const t = setTimeout(done, ms); // loop-ok: one deadline per guide next
    runWaiters.set(g.tab, done);
  });
}

/** `guide say`: the card on screen gets new words, a new draft, or both. Returns the step that changed. */
export function sayCurrent(g: Guide, say: string | undefined, suggest?: string): number | undefined {
  g.lastAt = clock();
  if (g.run && !g.run.endedAt) {
    const s = g.run.steps[g.run.index]!;
    if (say !== undefined) s.say = say;
    if (suggest !== undefined) s.suggest = suggest;
    save();
    return g.run.index + 1;
  }
  const last = g.steps[g.steps.length - 1];
  if (!last) return undefined;
  if (say !== undefined) last.say = say;
  if (suggest !== undefined) last.suggest = suggest;
  save();
  return last.n;
}

/** The person asked for another draft ("Suggest another"), with their optional
 *  one-line note: news for the agent on a run's `guide next`, never the step's answer. */
export function regenerateRun(g: Guide, note: string | undefined): void {
  const run = g.run;
  if (!run || run.endedAt) return;
  g.lastAt = clock();
  pushRun(g, { event: "regenerate", step: run.index + 1, of: run.steps.length, ...(note ? { note } : {}) });
}

/** The person's note on "Suggest another": one line, at most 200 characters, or none. */
export function regenerateNote(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.replace(/\s+/g, " ").trim().slice(0, 200);
  return t || undefined;
}

/**
 * The person pressed Resume on an ended run's card: within RESUME_MS of the
 * end, for the same owner, on a tab nobody else guides. The lock is taken
 * again for that owner and the run picks up on the step it ended on.
 */
export function resumeRun(tab: string): { guide: Guide } | { error: string } {
  const now = clock();
  sweep(now);
  const cur = live.get(tab);
  let g: Guide | undefined = cur;
  if (!g || !g.run?.endedAt) {
    if (cur && !cur.run?.endedAt) return { error: "a guide is running on this tab" };
    g = [...ended.values()].find((x) => x.tab === tab && x.run?.endedAt);
    if (!g) return { error: "no ended run to resume on this tab" };
  }
  const run = g.run!;
  if (now - run.endedAt! > RESUME_MS) return { error: "Resume is offered for 10 minutes after the end; start the guide again" };
  if (cur && cur !== g) return { error: othersRefusal(cur, "resume") };
  if (run.endedBy === "done") return { error: "the run finished: nothing to resume" };
  /* The queue is at its cap: a resumed run would end again on its first event. */
  if (run.endedBy === "overflow") return { error: "the run ended because it sent its 200 events; start the guide again" };
  delete run.endedAt; delete run.endedBy;
  delete g.endedAt; delete g.endedBy;
  g.locked = true;
  g.lastAt = now;
  live.set(tab, g);
  ended.delete(foldWorkerName(g.as));
  openVisit(run, now);
  pushRun(g, { event: "resumed", step: run.index + 1, of: run.steps.length });
  save();
  return { guide: g };
}

/** The end-of-guide summary: one row per step visit, in order. */
export function runSummary(run: GuideRun): { steps: number; endedBy?: RunEnd; url?: string; rows: Array<Record<string, unknown>> } {
  const now = run.endedAt ?? clock();
  return {
    steps: run.steps.length,
    ...(run.endedBy ? { endedBy: run.endedBy } : {}),
    ...(run.url ? { url: run.url } : {}),
    rows: run.visits.map((v) => ({
      n: v.n, visit: v.visit, waited: v.waited, endedBy: v.endedBy ?? null,
      seconds: Math.round(((v.endedAt ?? now) - v.startedAt) / 1000),
      url: v.url ?? null, clicks: v.clicks,
    })),
  };
}
