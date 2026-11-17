/*
 * What an agent is doing in which tab, as plain data.
 *
 * The panel already knew who owns a tab (its container) and which tab an ask
 * lands on; nothing remembered it past the ask, so a person watching a tab move
 * could not tell whether it was an agent, which one, or whether it was still
 * going. Every decision lives here so it can be tested without a renderer; the
 * panel only feeds events in and draws what comes out.
 *
 * Ceiling: this is per window and in memory. A restart forgets it, and so does
 * a second window — the server's audit log is the record that survives.
 */

import { foldWorkerName } from "../../../shared/workerContainer.ts";
import { handoffRefusal } from "../../../shared/browserHandoff.ts";
import { ACT_VERB_SET, LOG_ACT_VERB_SET } from "../../../shared/browserActVerbs.ts";

export const LOG_MAX = 20;

/** The verbs that change a page: the guide lock refuses all of them. Reads
 *  (`observe`, `read`, `shot`) would fill twenty rows in a minute. One list,
 *  shared/browserActVerbs.ts; the log and the pill use its subset without the
 *  eye's verbs (hover, scroll, …), so a long read does not flush the clicks. */
const ACT_VERBS = ACT_VERB_SET;
const LOG_VERBS = LOG_ACT_VERB_SET;

/** Verbs that act ON an element, so there is somewhere to draw. */
const FLASH_VERBS = new Set(["click", "dblclick", "rightclick", "check", "fill", "type", "press", "select"]);
/** Verbs the drawn pointer follows: the flash's, plus the two that only move the eye (a scroll with no selector has no place to point). */
const POINT_VERBS = new Set([...FLASH_VERBS, "hover", "scroll"]);

export interface AgentAction { verb: string; target: string; ok: boolean; at: number }
/** Where the pointed element is now, in the PAGE's CSS px. `vw`, `vh` are the
 *  page's own viewport in those px; guideRectIn turns it into the panel's pixels. */
export interface GuideRect { x: number; y: number; w: number; h: number; vw?: number; vh?: number }

/** What the person did to end a step's wait, as the bubble and the dock send it. */
export type GuideAnswer = "ok" | "back" | "stop" | "done" | "resume";
/** How long after a run's Stop the card offers Resume (the server's RESUME_MS). */
export const GUIDE_RESUME_MS = 10 * 60_000;

/** One step of a guide, as the person lived it: what they were told, and what they did. */
export interface GuideStepUi {
  n: number; m?: number; say: string; waitClick: boolean; at: number;
  /** Text the card offers to copy (`--copy`); the chip shows only when set. */
  copy?: string;
  /** A draft for the target field (`--suggest`); the card offers to insert it. */
  suggest?: string;
  /** The field already had text when the step began: the button offers to replace it. */
  suggestFilled?: boolean;
  /** What the page is about (`--summary`): shown under the say line until the person's OK. */
  summary?: string;
  rect?: GuideRect;
  /** No rect could be followed for this step: the bubble says so, by step kind. */
  lost?: boolean;
  clicked?: boolean;
  navigated?: string;
  did?: GuideAnswer | "click" | "navigated";
  didAt?: number;
  /** A run's target is not on this page: the card says so and offers Back and Stop. */
  gone?: boolean;
  /** A gone step that only waits for OK: the card offers Skip, which is its OK. */
  skip?: boolean;
  /** The person's last key in the target field: the card is a dot until GUIDE_TYPING_IDLE_MS after it, or a blur. */
  typingAt?: number;
}

/** A tab being guided: the agent points and talks, the person clicks. Glass off, acts refused. */
export interface TabGuide {
  /** Between `start` and `end`. After `end` the audit card stays until the person closes it. */
  on: boolean;
  why?: string;
  startedAt: number;
  endedAt?: number;
  steps: GuideStepUi[];
  /** A `guide run`: the server walks the plan, and a Stop leaves Resume on the card. */
  run?: boolean;
  /** Until when the ended card offers Resume. */
  resumeUntil?: number;
}

export interface TabAgent { agent: string; working: number; paused: boolean; log: AgentAction[]; /** The agent said it is finished, until its next ask. */ done?: boolean; /** The verb of the last ask begun. */ op?: string; /** When the last ask ended, read or act: reads leave no log entry. */ lastAt?: number; /** A `handoff` is armed: the page is the person's for now, the agent stays on the tab. */ handoff?: boolean; /** Guide mode on this tab, or its audit card after the end. */ guide?: TabGuide }
export type Activity = Record<string, TabAgent>;

export type ActivityEvent =
  | { type: "begin"; tab: string; agent: string; op?: string }
  | { type: "done"; tab: string }
  | { type: "end"; tab: string; action: AgentAction | null; at?: number }
  | { type: "pause"; tab: string; paused: boolean }
  | { type: "handoff"; tab: string; on: boolean; /** From a panel that mounted mid-handoff: an agent armed it, so the tab is marked even with no ask seen yet. */ seed?: boolean }
  | { type: "forget"; tab: string }
  /* The person answered the bubble or the dock (OK, Back, Stop, Done); `close` puts the audit card away. */
  | { type: "guideAnswer"; tab: string; answer: GuideAnswer | "close"; at: number }
  | GuideEvent;

/**
 * What the relay (and the guest's observer) tell the panel about a guide.
 * The contract between the two halves: the observer sends further `point` and
 * `wait` events for the same step with a new `target.rect`, `clicked: true` or
 * `navigated`. A `point` with `say` is a new step; one without is a move.
 */
export interface GuideEvent {
  kind: "guide"; type?: undefined; tab: string; phase: "start" | "point" | "wait" | "say" | "end";
  step?: { n: number; m: number }; say?: string; copy?: string; suggest?: string; suggestFilled?: boolean; summary?: string; waitClick?: boolean;
  target?: { rect: GuideRect } | null; clicked?: boolean; navigated?: { url: string };
  at?: number; agent?: string;
  /** On `start`: a run. With `say`: the target is lost on this page. */
  run?: boolean; lost?: boolean;
  /** With `lost`: an OK step, whose lost card offers Skip. */
  skip?: boolean;
  /** The observer: the person typed in the target field (true) or left it (false). */
  typing?: boolean;
}

/** Is a guide on for this tab: the lock, the glass and every state readout go by it. */
export const guiding = (a: Pick<TabAgent, "guide"> | undefined): boolean => !!a?.guide?.on;

function guideReduce(cur: TabAgent | undefined, ev: GuideEvent): TabAgent {
  const now = ev.at ?? Date.now();
  const base: TabAgent = cur ?? { agent: ev.agent ?? "agent", working: 0, paused: false, log: [] };
  if (ev.phase === "start") {
    /* The guide's own name wins on start: a worker guiding the person's tab is named, not "agent". */
    return { ...base, ...(ev.agent ? { agent: ev.agent } : {}), done: false, guide: { on: true, startedAt: now, steps: [], ...(ev.say ? { why: ev.say } : {}), ...(ev.run ? { run: true } : {}) } };
  }
  const g = base.guide ?? { on: true, startedAt: now, steps: [] };
  /* The server's end after the card already ended it (the last OK) keeps that end's clock; an end
     for a card the person closed brings no empty card back. A run that ended on its own has no Resume. */
  if (ev.phase === "end") {
    if (!base.guide) return base;
    const ended: TabGuide = { ...g, on: false, endedAt: g.on ? now : (g.endedAt ?? now) };
    if (!personStopped(ended)) delete ended.resumeUntil;
    return { ...base, guide: ended };
  }
  if (!g.on) return base;
  const steps = g.steps.slice();
  const last = steps[steps.length - 1];
  /* guide say: the words on the card change in place; nothing else about the step does. */
  if (ev.phase === "say") {
    const say = typeof ev.say === "string" && ev.say ? ev.say : undefined;
    const draft = typeof ev.suggest === "string" && ev.suggest ? ev.suggest : undefined;
    if (!last || (!say && !draft)) return base;
    /* A new draft (the answer to "Suggest another") replaces the old one in place. */
    steps[steps.length - 1] = { ...last, ...(say ? { say, gone: ev.lost === true, skip: ev.lost === true && ev.skip === true } : {}), ...(draft ? { suggest: draft } : {}) };
    return { ...base, guide: { ...g, steps } };
  }
  const rect = ev.target === null ? null : ev.target?.rect;
  /* Only the relay's `point` (or `wait`, for a wait-click step) starts a step: it carries `say`. An
     observer report has no `say` (it moves the rect), and a press or a navigation never adds one. */
  const move = ev.clicked === true || ev.navigated !== undefined;
  const fresh = (ev.phase === "point" || ev.phase === "wait") && !move && typeof ev.say === "string" && ev.say !== "";
  if (fresh) {
    steps.push({
      n: ev.step?.n ?? (last?.n ?? 0) + 1, ...(ev.step ? { m: ev.step.m } : {}),
      say: ev.say!, waitClick: ev.waitClick === true, at: now,
      ...(typeof ev.copy === "string" && ev.copy ? { copy: ev.copy } : {}),
      ...(typeof ev.summary === "string" && ev.summary ? { summary: ev.summary } : {}),
      ...(typeof ev.suggest === "string" && ev.suggest ? { suggest: ev.suggest, ...(ev.suggestFilled === true ? { suggestFilled: true } : {}) } : {}),
      ...(rect ? { rect } : {}), ...(rect === null ? { lost: true } : {}),
    });
  } else if (last) {
    const s: GuideStepUi = { ...last };
    if (rect) { s.rect = rect; s.lost = false; }
    if (rect === null) s.lost = true;
    if (ev.waitClick !== undefined) s.waitClick = ev.waitClick;
    if (ev.clicked && !s.did) { s.clicked = true; s.did = "click"; s.didAt = now; }
    if (ev.navigated) { s.navigated = ev.navigated.url; if (!s.did) { s.did = "navigated"; s.didAt = now; } }
    if (ev.typing === true) s.typingAt = now;
    else if (ev.typing === false) delete s.typingAt;
    steps[steps.length - 1] = s;
  }
  return { ...base, guide: { ...g, steps } };
}

function answerReduce(cur: TabAgent, answer: GuideAnswer | "close", at: number): TabAgent {
  const g = cur.guide;
  if (!g) return cur;
  if (answer === "close") return g.on ? cur : { ...cur, guide: undefined };
  if (!g.on) return cur;
  const steps = g.steps.slice();
  const last = steps[steps.length - 1];
  if (last && !last.did) steps[steps.length - 1] = { ...last, did: answer, didAt: at };
  if (answer === "resume") return cur;
  /* OK (or Done) on a run's last step ends it on the card at once: the person sees the end, not a card that waits. */
  if (g.run && (answer === "ok" || answer === "done") && last?.m && last.n >= last.m) return { ...cur, guide: { ...g, steps, on: false, endedAt: at } };
  /* Stop ends it on the person's side at once: the agent hears it on its `guide next`. A run's card keeps Resume for a while. */
  return { ...cur, guide: { ...g, steps, ...(answer === "stop" ? { on: false, endedAt: at, ...(g.run ? { resumeUntil: at + GUIDE_RESUME_MS } : {}) } : {}) } };
}

export function activityReducer(state: Activity, ev: ActivityEvent): Activity {
  const cur = state[ev.tab];
  if ("kind" in ev && ev.kind === "guide") return { ...state, [ev.tab]: guideReduce(cur, ev) };
  switch (ev.type) {
    case "begin":
      return { ...state, [ev.tab]: { agent: ev.agent, working: (cur?.working ?? 0) + 1, paused: cur?.paused ?? false, log: cur?.log ?? [], op: ev.op, ...(cur?.handoff ? { handoff: true } : {}), ...(cur?.guide ? { guide: cur.guide } : {}) } };
    case "done":
      // Still mid-ask: a `done` now would drop the glass over a page the agent is typing into.
      if (cur && cur.working > 0) return state;
      // A handoff runs on its own clock, not the agent's: a `done` must not drop it and put the glass back over Done.
      return { ...state, [ev.tab]: { agent: cur?.agent ?? "agent", working: 0, paused: cur?.paused ?? false, log: cur?.log ?? [], done: true, op: cur?.op, ...(cur?.handoff ? { handoff: true } : {}), ...(cur?.guide ? { guide: cur.guide } : {}) } };
    case "end": {
      if (!cur) return state;
      const log = ev.action ? [...cur.log, ev.action].slice(-LOG_MAX) : cur.log;
      return { ...state, [ev.tab]: { ...cur, working: Math.max(0, cur.working - 1), log, lastAt: ev.at ?? ev.action?.at ?? cur.lastAt } };
    }
    case "pause": {
      // A tab no agent has touched has nothing to pause: the person's own tab stays unmarked.
      if (!cur) return state;
      return { ...state, [ev.tab]: { ...cur, paused: ev.paused } };
    }
    case "handoff": {
      /* The handoff's own clock (armed, then Done / until / timeout / cancel), not
         an ask's: the CLI's waits come and go around it. A tab no agent has
         touched has no glass to lift. */
      if (!cur && ev.seed && ev.on) return { ...state, [ev.tab]: { agent: "agent", working: 0, paused: false, log: [], handoff: true } };
      if (!cur || !!cur.handoff === ev.on) return state;
      return { ...state, [ev.tab]: { ...cur, handoff: ev.on } };
    }
    case "guideAnswer":
      return cur ? { ...state, [ev.tab]: answerReduce(cur, ev.answer, ev.at) } : state;
    case "forget": {
      if (!(ev.tab in state)) return state;
      const { [ev.tab]: _gone, ...rest } = state;
      return rest;
    }
  }
  return state;
}

/** The name on the badge: what the agent called itself, else its container, else a generic word. */
export function agentLabel(as: unknown, container: string): string {
  if (typeof as === "string" && as.trim()) return as.trim();
  return container && container !== "default" ? container : "agent";
}

/** Whether a `done` may mark the tab: only from the agent driving it, by name. `--page` and a caller
 *  with no `as` skip the container check, and the badge's fallback name is the container's, so a name
 *  that was never sent matches nothing here. The answer is ok either way. */
export function doneMayMark(cur: TabAgent | undefined, as: unknown): boolean {
  return !!cur && typeof as === "string" && as.trim() !== ""
    && foldWorkerName(as) === foldWorkerName(cur.agent);
}

/** What an agent is told when the person has the tab. */
export function pausedRefusal(agent: string): string {
  return `the person took this tab over: ask again later, or use your own tab with \`open --as ${agent || "<your name>"} <url>\``;
}

/**
 * Whether the panel refuses an agent's ask on this tab, and with what sentence.
 * Taken over: everything, except the check or cancel of a handoff — taking over
 * ends the handoff, and the waiting call has to hear that rather than be told to
 * try later until its timeout. In handoff: every verb but the reading ones and
 * the handoff's own (shared/browserHandoff.ts), from any caller. A refusal is
 * answered before the ask begins, so it leaves no row in the log and no badge.
 */
export function agentAskRefusal(cur: TabAgent | undefined, ask: { op: string; args: Record<string, unknown> }): string | null {
  if (!cur) return null;
  const endsHandoff = ask.op === "handoff" && ask.args.reason === undefined;
  if (cur.paused) return endsHandoff ? null : pausedRefusal(typeof ask.args.as === "string" ? ask.args.as : "");
  if (cur.handoff) return handoffRefusal(ask.op);
  /* The relay refuses first; this is the second door, for an act that reached the panel anyway. */
  if (guiding(cur) && ACT_VERBS.has(ask.op)) return guideRefusal(ask.op);
  return null;
}

/** What an agent is told when it acts on a guided tab. Never shown to the person. */
export function guideRefusal(op: string): string {
  return `refused by: browser panel, guide mode is on for this tab (${op} is an act). Do this instead: point <selector> --say "<what to do>", then guide next. To act again: guide end.`;
}

export function isActVerb(op: string): boolean {
  return LOG_VERBS.has(op);
}

/** A selector is a locator, never a value; clipped so a long CSS chain stays one line. */
const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * One row of the log for a finished ask, or null when it is not worth a row.
 * Only the selector (or the key name) is kept: what was typed or filled in is
 * never read here, so a secret cannot reach the log by way of this function.
 */
export function actionOf(ask: { op: string; args: Record<string, unknown> }, ok: boolean, now: number): AgentAction | null {
  if (!LOG_VERBS.has(ask.op)) return null;
  const a = ask.args;
  /* A refused act during a guide is the agent's business: the guide's audit and its error, never the person's log. */
  if (a.refused === "guide") return null;
  let target = "";
  if (ask.op === "fill" && a.fields && typeof a.fields === "object") {
    const names = Object.keys(a.fields as object);
    target = names.length > 1 ? `${names[0]} +${names.length - 1}` : (names[0] ?? "");
  } else if (ask.op === "press") {
    target = typeof a.key === "string" ? a.key : "";
  } else if (typeof a.selector === "string") {
    target = a.selector;
  }
  return { verb: ask.op, target: clip(target), ok, at: now };
}

/** Where to draw the flash: a selector, the focused element, or nowhere. */
export type FlashPlan = { kind: "selector"; selector: string } | { kind: "focus" } | null;

export function flashPlan(ask: { op: string; args: Record<string, unknown> }, pointer = false): FlashPlan {
  if (!(pointer ? POINT_VERBS : FLASH_VERBS).has(ask.op)) return null;
  const a = ask.args;
  if (ask.op === "fill" && a.fields && typeof a.fields === "object") {
    const first = Object.keys(a.fields as object)[0];
    return first ? { kind: "selector", selector: first } : null;
  }
  if (typeof a.selector === "string" && a.selector) return { kind: "selector", selector: a.selector };
  return ask.op === "press" ? { kind: "focus" } : null;
}

/** The address without its fragment: a #hash link moves within the document, and the page under the pointer is the same. */
export const pageOf = (url: string) => url.split("#")[0];

/** "3s", "2m": how long ago, for a row that is read once and not kept up to date. */
export function ago(now: number, at: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
}

/**
 * How long the presence layer stays up after the last ask ends. An agent works
 * in bursts with a model call between them; without this the rim would blink
 * off and on between every two clicks, which reads as nervous, not as held.
 */
/* How long after its last act a tab still reads as the agent's: the rim, the
   dock, the island's pill and the glass all go by this one clock. An agent
   thinks between two clicks, often for longer than ten seconds, and four
   seconds (the first value) left a pill saying "thinking" over a page with no
   rim and no Take over, then changed the island's shape on every think. */
export const PRESENCE_LINGER_MS = 30_000;

/**
 * Whether the agent is still working on a tab, for everything that shows it:
 * the glass over the page and the island's dot. Mid-ask, or within the quiet
 * window after one (`stilled` is that window run out), because an agent works
 * in bursts with a model call between them. Reading `working > 0` alone
 * blinked the dot grey between every two calls.
 */
/**
 * Whether the glass is over the page, taking the person's pointer, wheel and
 * keys. Only while the agent holds the tab AND has acted on it; never once the
 * person has it (Take over), and never during a `handoff`, which asks them to
 * use the page: the banner's Done sits under the glass, so a glass up through
 * a handoff left a call nobody could answer.
 */
export function glassBlocks(a: { held: boolean; acting: boolean; paused: boolean; handoff?: boolean; guiding?: boolean }): boolean {
  return a.held && a.acting && !a.paused && !a.handoff && !a.guiding;
}

export function glassHeld(a: { live: boolean; done?: boolean; paused: boolean; working: number }, stilled: boolean): boolean {
  return a.live && !a.done && !a.paused && (a.working > 0 || !stilled);
}

const DOING: Record<string, string> = {
  click: "Clicking", dblclick: "Double-clicking", rightclick: "Right-clicking", check: "Ticking",
  fill: "Filling", type: "Typing in", select: "Choosing in", press: "Pressing", hover: "Hovering", scroll: "Scrolling to",
};

/** The few words beside the drawn pointer: what the agent did, to what. A name the page gave the element, never a value. */
export function presenceLabel(verb: string, name: string, key = ""): string {
  const doing = DOING[verb] ?? verb;
  if (verb === "press") return key ? `${doing} ${clip(key, 16)}` : doing;
  const n = name.trim();
  return n ? `${doing} ${clip(n, 32)}` : doing;
}

export type AgentStateKey = "clicking" | "typing" | "navigating" | "scrolling" | "pointing" | "reading" | "scripting" | "thinking" | "yours" | "handoff" | "guiding" | "waiting" | "done" | "working";

const STATE_OF: Record<string, AgentStateKey> = {
  click: "clicking", dblclick: "clicking", rightclick: "clicking", check: "clicking", drag: "clicking", upload: "clicking",
  type: "typing", fill: "typing", press: "typing", select: "typing",
  open: "navigating", back: "navigating", forward: "navigating", reload: "navigating", newtab: "navigating",
  scroll: "scrolling", hover: "pointing", eval: "scripting",
};
const STATE_WORD: Record<AgentStateKey, string> = {
  clicking: "Clicking", typing: "Typing", navigating: "Navigating", scrolling: "Scrolling",
  pointing: "Pointing", reading: "Reading", scripting: "Scripting", thinking: "Thinking", yours: "You have it", handoff: "Needs you", guiding: "Guiding", waiting: "Waiting", done: "Done", working: "Working",
};

export const stateOf = (key: AgentStateKey) => ({ key, word: STATE_WORD[key] });

/** One word for what the agent is doing now: a state, not an account of it. Anything that is not an act is a read. */
export function agentState(a: Pick<TabAgent, "working" | "paused" | "op"> & { handoff?: boolean; guide?: TabGuide }): { key: AgentStateKey; word: string } {
  /* A guide is the person's hand on the page with the agent talking: Guiding, whatever the agent is reading meanwhile. */
  const key: AgentStateKey = a.paused ? "yours" : guiding(a) ? "guiding" : a.handoff ? "handoff" : a.working > 0 ? STATE_OF[a.op ?? ""] ?? (a.op ? "reading" : "working") : "thinking";
  return { key, word: STATE_WORD[key] };
}

/**
 * Where the drawn pointer's tip goes, in the panel's pixels, for an act that
 * landed on a rect in the guest's. The guest has a zoom of its own, so its CSS
 * pixel is not the panel's: placed unconverted, the pointer drifted further off
 * the lower the element sat (a row off mid-page, three rows near the bottom).
 * Converted through the two viewport widths; -3/-2 puts the arrow's tip, not
 * its box, on the point.
 */
export function pointerAt(l: { x: number; y: number; w: number; h: number; vw: number }, panelWidth: number): { x: number; y: number } {
  const k = l.vw > 0 && panelWidth > 0 ? panelWidth / l.vw : 1;
  return { x: Math.round((l.x + Math.min(34, l.w / 2)) * k) - 3, y: Math.round((l.y + l.h / 2) * k) - 2 };
}

/**
 * A guide rect in the panel's pixels. The page's px are not the pane's when
 * the page is zoomed or the pane is narrower than the page: scale by
 * panelWidth / vw, as pointerAt does. No vw (an older report): as it is.
 */
export function guideRectIn(r: GuideRect, panelWidth: number): GuideRect {
  const k = guideScale(panelWidth, r.vw);
  return { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k };
}

/** Page px to pane px: the pane's width NOW over the page's own viewport width
 *  in the same report. With the page filling the pane this is the guest's zoom
 *  (0.67, 1, 1.5...). 1 when either is unknown. */
export function guideScale(panelWidth: number, vw: number | undefined): number {
  return vw && vw > 0 && panelWidth > 0 ? panelWidth / vw : 1;
}

/** Which pane width to scale by: the one measured now, else the last one a
 *  ResizeObserver gave. The cached one alone went stale on a window resize (a
 *  host that is not painting runs no ResizeObserver callback), and the ring
 *  was drawn at old-width / new-width times the target's place. */
export function guidePaneWidth(live: number | undefined, cached: number): number {
  return live && live > 0 ? live : cached;
}

/** The element is scrolled out of the page's view: which way to scroll to see it. Null while any of it shows. */
export function guideOffscreen(r: GuideRect): "up" | "down" | null {
  if (r.y + r.h <= 0) return "up";
  if (r.vh && r.vh > 0 && r.y >= r.vh) return "down";
  return null;
}

/**
 * Where the pointer's label sits so it never leaves the page: to the right of and below the
 * arrow by default, flipped to its left or above it when that would run past an edge.
 * `x`,`y` are the arrow's place, `w`,`h` the label's size, `pw`,`ph` the panel's. A label wider
 * than the panel stays at its left edge and is cut by the panel, the one case nothing can fit.
 */
export function labelFit(x: number, y: number, w: number, h: number, pw: number, ph: number): { left: number; top: number } {
  let left = 18, top = 20;
  if (pw > 0 && x + left + w > pw - 4) left = Math.max(-x + 4, pw - 4 - w - x);
  if (ph > 0 && y + top + h > ph - 4) top = -h - 6;
  return { left, top };
}

/**
 * A tab's state for the overview, where there is no clock per tab: an ask in
 * flight is its act's word, a last act inside the presence's linger is
 * Thinking, a tab that has gone quiet is Waiting (silence proves nothing), and
 * Done only when the agent said so with the `done` verb. A name kept from a
 * restart with no live activity has no state.
 */
export const STATE_HOLD_MS = 4000;
/** An agent that has not asked anything of a tab for this long no longer holds it: a
 *  script that ended without saying `done` left its tab "Waiting" for good, and the
 *  count in Mission Control kept the agent. Ten minutes outlasts any model call. */
export const IDLE_RELEASE_MS = 10 * 60_000;
/** Does an agent's fixed viewport on this tab end now? It does once the agent
 *  has let go — `done`, the person's Take over, the tab forgotten, or ten
 *  minutes without an ask, which is also where a session that ended without
 *  saying so lands. Never mid-ask. */
export function viewportReleased(a: TabAgent | undefined, now: number): boolean {
  if (!a || a.paused) return true;
  if (a.working > 0) return false;
  if (a.done) return true;
  const last = a.lastAt ?? a.log[a.log.length - 1]?.at ?? 0;
  return !!last && now - last > IDLE_RELEASE_MS;
}
/**
 * Does a tab that is not in front stay painted BEHIND the front one, rather than
 * hidden? Only while an agent is mid-task on it: a hidden guest runs no rendering
 * steps, and a page that waits on a frame (GitHub's menus) never opens.
 *
 * Not for a page that is the person's for now. `yours` (taken over) and
 * `handoff` wait on the person, who has to bring the tab to the front to act on
 * it; a handoff's own checks read the URL and the DOM, which a hidden guest still
 * answers. A handoff has no idle clock (`tabState` returns it before
 * IDLE_RELEASE_MS), so a background one painted behind cost a full renderer's
 * frames for as long as nobody pressed Done.
 */
export function paintsBehind(key: AgentStateKey | undefined): boolean {
  return !!key && key !== "done" && key !== "waiting" && key !== "yours" && key !== "handoff";
}
export function tabState(a: TabAgent | undefined, kept: string | undefined, now: number): { key: AgentStateKey; word: string } | null {
  /* Guiding first, for the pill, the overview and the dock alike: one answer for the three. */
  if (a && !a.paused && guiding(a)) return { key: "guiding", word: STATE_WORD.guiding };
  if (a && (a.paused || a.handoff || a.working > 0)) return agentState(a);
  /* The last ask of any kind, not the last act: an agent reading between clicks
     flipped Reading/Waiting several times a second when only acts counted. */
  const last = a?.lastAt ?? a?.log[a.log.length - 1]?.at ?? 0;
  if (a && last && now - last > IDLE_RELEASE_MS) return null;
  if (a?.done) return { key: "done", word: STATE_WORD.done };
  // Back-to-back asks keep their word; a state that changes faster than it can be read is noise.
  if (a && now - last < STATE_HOLD_MS) return agentState({ working: 1, paused: false, op: a.op });
  if (a && now - last < PRESENCE_LINGER_MS) return { key: "thinking", word: STATE_WORD.thinking };
  return a ? { key: "waiting", word: STATE_WORD.waiting } : null;
}

/**
 * A state shown to a person must hold still: an agent driving a page by `eval`
 * and `tabs` (measured: 134 and 217 calls in a few minutes) flipped the chip
 * between two words several times a second. A new word is shown only once it
 * has been the raw answer for CANDIDATE_MS, and a shown word stays at least
 * MIN_SHOW_MS. "You have it" skips both: a person's click is answered at once.
 * Ceiling: a word that was raw for less than CANDIDATE_MS is never seen.
 */
export const CANDIDATE_MS = 700;
export const MIN_SHOW_MS = 1500;
export interface Steady<K extends string = AgentStateKey> { shown: K | null; shownAt: number; cand: K | null; candAt: number }
export const STEADY_INIT: Steady<never> = { shown: null, shownAt: 0, cand: null, candAt: 0 };
/** Next steady state for the raw one at `now`, and the ms until it could change (0 = nothing pending). */
export function steadyStep<K extends string>(s: Steady<K>, raw: K | null, now: number): { s: Steady<K>; wait: number } {
  if (raw === null) return { s: STEADY_INIT as Steady<K>, wait: 0 };
  if (s.shown === null) return { s: { shown: raw, shownAt: now, cand: null, candAt: 0 }, wait: 0 };
  if (raw === s.shown) return { s: s.cand === null ? s : { ...s, cand: null }, wait: 0 };
  const c = s.cand === raw ? s : { ...s, cand: raw, candAt: now };
  const instant = raw === ("yours" as string) || s.shown === ("yours" as string) || raw === ("guiding" as string) || s.shown === ("guiding" as string);
  const due = instant ? now : Math.max(c.candAt + CANDIDATE_MS, s.shownAt + MIN_SHOW_MS);
  return now >= due ? { s: { shown: raw, shownAt: now, cand: null, candAt: 0 }, wait: 0 } : { s: c, wait: due - now };
}

/** The busiest of a container's tabs speaks for the box. */
const RANK: Record<AgentStateKey, number> = { yours: 5, handoff: 5, guiding: 5, clicking: 4, typing: 4, navigating: 4, scrolling: 4, pointing: 4, reading: 4, scripting: 4, working: 4, thinking: 3, waiting: 2, done: 1 };
export function boxState(states: Array<{ key: AgentStateKey; word: string } | null>): { key: AgentStateKey; word: string } | null {
  return states.reduce<{ key: AgentStateKey; word: string } | null>((best, s) => (s && (!best || RANK[s.key] > RANK[best.key]) ? s : best), null);
}

/** The pointer's travel time: grows with the distance, clamped so a short hop stays quick and a long one never drags. */
export function travelMs(dx: number, dy: number): number {
  return Math.round(Math.min(240, Math.max(110, 90 + Math.hypot(dx, dy) * 0.25)));
}

/**
 * The satellite's lap round a W x H page, as transform keyframes: a rounded
 * rectangle `inset` px inside the edge with corners of radius `r`, speed even
 * all the way round, the contact turning WITH each corner's arc. Inset so the
 * whole contact and its halo stay on the page; a corner cut straight would
 * clip it against a rounded container. Starts top-right, where the mark parks
 * its contact, heading down.
 */
export function lapKeyframes(W: number, H: number, inset = 7, r = 10, arcSteps = 6): { offset: number; transform: string }[] {
  const L = inset, T = inset, R = W - inset, B = H - inset;
  if (R - L < 2 * r || B - T < 2 * r) return [];
  type P = { x: number; y: number; a: number };
  const pts: P[] = [];
  const line = (x0: number, y0: number, x1: number, y1: number, a: number) => { pts.push({ x: x0, y: y0, a }, { x: x1, y: y1, a }); };
  const arc = (cx: number, cy: number, from: number) => {
    for (let k = 1; k < arcSteps; k++) {
      const t = from + (90 * k) / arcSteps, rad = ((t - 90) * Math.PI) / 180;
      pts.push({ x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad), a: t });
    }
  };
  line(R, T + r, R, B - r, 90); arc(R - r, B - r, 90);
  line(R - r, B, L + r, B, 180); arc(L + r, B - r, 180);
  line(L, B - r, L, T + r, 270); arc(L + r, T + r, 270);
  line(L + r, T, R - r, T, 360); arc(R - r, T + r, 360);
  pts.push({ x: R, y: T + r, a: 450 });
  const d: number[] = [0];
  for (let k = 1; k < pts.length; k++) d.push(d[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y));
  const total = d[d.length - 1] || 1;
  return pts.map((p, k) => ({ offset: d[k] / total, transform: `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) rotate(${p.a.toFixed(1)}deg)` }));
}

export const LOOK_PX = 1.5, TILT_DEG = 6;
/** Pupil offset and head tilt for a pointer (dx, dy) px away: full strength from ~90px, none on top of it. */
export function lookAt(dx: number, dy: number): { lx: number; ly: number; tilt: number } {
  const d = Math.hypot(dx, dy);
  if (d < 1) return { lx: 0, ly: 0, tilt: 0 };
  const k = Math.min(1, d / 90) * LOOK_PX / d;
  return { lx: dx * k, ly: dy * k, tilt: Math.max(-1, Math.min(1, dx / 160)) * TILT_DEG };
}

/* ---------- guide mode: the bubble ---------- */

/** The bubble's width: a short line of reading, never wider than the pane allows. */
export const BUBBLE_MAX_W = 300;
const BUBBLE_GAP = 10, BUBBLE_EDGE = 8, BUBBLE_MIN_TEXT = 40;

/** A box in the panel's pixels. */
export type PaneBox = { x: number; y: number; w: number; h: number };

/** What must stay clear round the target: the ring is drawn 3px out with a glow to 9px, plus room to aim. */
export const GUIDE_CLEAR = 12;

/** The two boxes share any pixel once `a` is grown by `margin` on every side. */
export function boxesMeet(a: PaneBox, b: PaneBox, margin = 0): boolean {
  return a.x - margin < b.x + b.w && b.x < a.x + a.w + margin && a.y - margin < b.y + b.h && b.y < a.y + a.h + margin;
}

const DOCK_EDGE = 16;
/** How far above and below the ring the dock keeps out of the bubble's way. A taller bubble is held off the dock by bubblePlace. */
const BUBBLE_RESERVE_H = 200;

/**
 * Where the dock (who is driving, End guide) goes during a guide, in the
 * panel's pixels: its usual place, bottom centre, unless that covers the
 * ring; then the top centre, then the four corners, then the middle of the
 * sides. First choice is a place also clear of the bubble's column (the
 * strip BUBBLE_RESERVE_H above and below the ring the bubble is drawn in),
 * so the two never meet; else one clear of the ring alone. `avoid` are other
 * overlays drawn over the pane (the island's pill at top centre): every
 * choice stays off them too while any place can. None clear (a target as big as
 * the pane): bottom centre, and `through` lets the person's clicks pass to
 * the page. No ring: bottom centre.
 */
export function dockPlace(ring: PaneBox | null, pane: { w: number; h: number }, dock: { w: number; h: number }, avoid: PaneBox[] = []): { left: number; top: number; through: boolean } {
  const w = Math.min(dock.w, Math.max(0, pane.w - 2 * DOCK_EDGE)), h = dock.h;
  const cx = Math.round((pane.w - w) / 2), lo = pane.w - DOCK_EDGE - w;
  const bottom = Math.max(0, pane.h - DOCK_EDGE - h), midY = Math.round((pane.h - h) / 2);
  const home = { left: cx, top: bottom };
  if (!ring) return { ...home, through: false };
  const tries = [home, { left: cx, top: DOCK_EDGE },
    { left: DOCK_EDGE, top: bottom }, { left: lo, top: bottom }, { left: DOCK_EDGE, top: DOCK_EDGE }, { left: lo, top: DOCK_EDGE },
    { left: lo, top: midY }, { left: DOCK_EDGE, top: midY }];
  const bw = bubbleWidth(pane.w), bl = bubbleLeft(ring, pane.w, bw);
  const column = { x: bl, y: ring.y - BUBBLE_RESERVE_H, w: bw, h: ring.h + 2 * BUBBLE_RESERVE_H };
  const clear = (p: { left: number; top: number }) => p.left >= 0 && p.top >= 0 && !boxesMeet(ring, { x: p.left, y: p.top, w, h }, GUIDE_CLEAR);
  const free = (p: { left: number; top: number }) => !avoid.some((a) => boxesMeet(a, { x: p.left, y: p.top, w, h }, GUIDE_CLEAR));
  const offColumn = (p: { left: number; top: number }) => !boxesMeet(column, { x: p.left, y: p.top, w, h }, BUBBLE_EDGE);
  const fit = tries.find((p) => clear(p) && free(p) && offColumn(p)) ?? tries.find((p) => clear(p) && free(p)) ?? tries.find(clear);
  return fit ? { ...fit, through: false } : { ...home, through: true };
}

const bubbleWidth = (paneW: number) => Math.max(120, Math.min(BUBBLE_MAX_W, paneW - 2 * BUBBLE_EDGE));
/** The bubble's left edge above or below a target: centred on it, kept inside the pane. */
function bubbleLeft(rect: PaneBox, paneW: number, width: number): number {
  return Math.round(Math.max(BUBBLE_EDGE, Math.min(paneW - BUBBLE_EDGE - width, rect.x + rect.w / 2 - width / 2)));
}

/**
 * Where the guide's bubble goes for a target rect, all in the panel's pixels.
 * Below the target first, above it when below is short, then to its right
 * or left, so it never covers the target while any side has room. None has:
 * the taller of below and above with the text scrolled (`maxText`): the
 * buttons (`chrome`, padding and the button row) always stay in view and the
 * bubble never runs under the dock (`dockTop`, or the placed `dock` box, at
 * the bottom or at the top). The text wraps at `width`; `text.h` is its
 * height measured at that width. `through`: the bubble still meets the
 * target (a pane too short for the chrome and BUBBLE_MIN_TEXT of text), so
 * its body lets the person's clicks pass. For left/right, `tailY` is where
 * its tail meets the bubble's side.
 */
export function bubblePlace(
  rect: GuideRect,
  pane: { w: number; h: number; dockTop?: number; dock?: PaneBox },
  text: { h: number },
  chrome = 52,
): { left: number; top: number; width: number; side: "below" | "above" | "left" | "right"; maxText: number; scroll: boolean; tailX: number; tailY?: number; through: boolean } {
  const width = bubbleWidth(pane.w);
  const d = pane.dock;
  const dockLow = d && d.y + d.h / 2 >= pane.h / 2;
  const floor = Math.min(pane.h, pane.dockTop ?? pane.h, d && dockLow ? d.y : pane.h) - BUBBLE_EDGE;
  const ceil = (d && !dockLow ? d.y + d.h : 0) + BUBBLE_EDGE;
  const below = floor - (rect.y + rect.h + BUBBLE_GAP);
  const above = rect.y - BUBBLE_GAP - ceil;
  const need = text.h + chrome;
  const anchor = rect.x + rect.w / 2;
  const meets = (b: PaneBox) => rect.w > 0 && rect.h > 0 && boxesMeet(rect, b, GUIDE_CLEAR - BUBBLE_GAP);
  if (need > below && need > above && need <= floor - ceil) {
    const right = pane.w - BUBBLE_EDGE - (rect.x + rect.w + BUBBLE_GAP), left = rect.x - BUBBLE_GAP - BUBBLE_EDGE;
    const side = right >= width ? "right" : left >= width ? "left" : null;
    if (side) {
      const x = side === "right" ? rect.x + rect.w + BUBBLE_GAP : rect.x - BUBBLE_GAP - width;
      const top = Math.round(Math.max(ceil, Math.min(floor - need, rect.y + rect.h / 2 - need / 2)));
      const tailY = Math.round(Math.max(14, Math.min(need - 14, rect.y + rect.h / 2 - top)));
      return { left: Math.round(x), top, width, side, maxText: Math.ceil(text.h), scroll: false, tailX: 14, tailY, through: false };
    }
  }
  let side: "below" | "above";
  /* Both fit: the side with the most room, so the card sits clear of what the person reads round the target. */
  if (need <= below && need <= above) side = below >= above ? "below" : "above";
  else if (need <= below) side = "below";
  else if (need <= above) side = "above";
  else side = below >= above ? "below" : "above";
  const room = side === "below" ? below : above;
  const scroll = need > room;
  const maxText = scroll ? Math.max(BUBBLE_MIN_TEXT, Math.floor(room - chrome)) : Math.ceil(text.h);
  const h = Math.min(need, maxText + chrome);
  /* Kept inside the pane: a target bigger than it gets the bubble on top of it, passing clicks through. */
  const top = Math.max(BUBBLE_EDGE, Math.min(pane.h - BUBBLE_EDGE - h, side === "below" ? rect.y + rect.h + BUBBLE_GAP : rect.y - BUBBLE_GAP - h));
  const left = bubbleLeft(rect, pane.w, width);
  const tailX = Math.round(Math.max(14, Math.min(width - 14, anchor - left)));
  return { left, top: Math.round(top), width, side, maxText, scroll, tailX, through: meets({ x: left, y: Math.round(top), w: width, h }) };
}

/* ---------- guide mode: the pill, the card's motion, the typing dot ---------- */

/** How long the pill keeps the ended guide ("✓ 5/5", "■ 3/5") before it is Idle again. */
export const GUIDE_PILL_END_MS = 2400;

/** The step as the pill's 30 px slot says it: "3/5", or "Step 3" with no total. */
export function guideStepText(n: number, m?: number): string {
  return m ? `${n}/${m}` : `Step ${n}`;
}

export type GuidePill = { kind: "on" | "done" | "stopped"; step: string; agent: string; label: string };

/**
 * What the top pill says about a guide: on (the guide glyph and the step),
 * then for GUIDE_PILL_END_MS after the end done (every step reached and not
 * stopped) or stopped. Null otherwise: the pill is its usual self.
 */
export function guidePill(a: Pick<TabAgent, "agent" | "guide"> | undefined, now: number): GuidePill | null {
  const g = a?.guide;
  if (!g || !a) return null;
  const last = g.steps[g.steps.length - 1];
  const of = last ? (last.m ? `step ${last.n} of ${last.m}` : `step ${last.n}`) : "";
  if (g.on) {
    return { kind: "on", step: last ? guideStepText(last.n, last.m) : "", agent: a.agent, label: `${a.agent} is guiding you${of ? `, ${of}` : ""}. Hover for End guide.` };
  }
  if (!g.endedAt || now - g.endedAt >= GUIDE_PILL_END_MS || !last) return null;
  const stopped = last.did === "stop" || (!!last.m && last.n < last.m);
  return stopped
    ? { kind: "stopped", step: guideStepText(last.n, last.m), agent: a.agent, label: `Guide stopped at ${of}` }
    : { kind: "done", step: guideStepText(last.n, last.m), agent: a.agent, label: `Guide done${last.m ? `, ${last.n} of ${last.m}` : ""}` };
}

/** One card per step visit: a `guide say` edit keeps the card (same key), a Back to step 2 is a new one. */
export const guideCardKey = (s: Pick<GuideStepUi, "n" | "at">): string => `${s.n}|${s.at}`;

/** The card's motion (mockup "New · standard"): it leaves in place, the next arrives at its anchor. Never travels. */
export const CARD_LEAVE_MS = 150, CARD_ARRIVE_MS = 200, CARD_LEAVE_CALM_MS = 100, CARD_ARRIVE_CALM_MS = 120;
/** The longest the next card waits for its target's rect before it shows anyway. */
export const CARD_WAIT_CAP_MS = 1000;
const CARD_EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

/** Web Animations keyframes, so the reduce-motion fades keep their 100/120 ms (the CSS rule ends every CSS one at once). */
export function cardMotion(kind: "leave" | "arrive", calm: boolean): { keyframes: Keyframe[]; options: KeyframeAnimationOptions } {
  if (kind === "leave") {
    return calm
      ? { keyframes: [{ opacity: 1 }, { opacity: 0 }], options: { duration: CARD_LEAVE_CALM_MS, easing: "linear", fill: "forwards" } }
      : { keyframes: [{ opacity: 1, scale: "1" }, { opacity: 0, scale: ".96" }], options: { duration: CARD_LEAVE_MS, easing: CARD_EASE, fill: "forwards" } };
  }
  return calm
    ? { keyframes: [{ opacity: 0 }, { opacity: 1 }], options: { duration: CARD_ARRIVE_CALM_MS, easing: "linear" } }
    : { keyframes: [{ opacity: 0, scale: ".96", transform: "translateY(-4px)" }, { opacity: 1, scale: "1", transform: "none" }], options: { duration: CARD_ARRIVE_MS, easing: CARD_EASE } };
}

/** The next card may arrive: its anchor is known (a rect, or a state that has no rect to wait for). */
export const cardReady = (s: Pick<GuideStepUi, "rect" | "lost" | "gone" | "navigated">): boolean => !!s.rect || !!s.lost || !!s.gone || !!s.navigated;

/**
 * The cards on screen: `shown` at its anchor, `leaving` frozen where it was,
 * `next` waiting. A new step sends the shown card out; the next one comes in
 * only once nothing is leaving AND it is ready (or CARD_WAIT_CAP_MS passed).
 */
export type CardFlow = { shown: string | null; leaving: string | null; next: string | null; since: number };
export const CARD_FLOW_INIT: CardFlow = { shown: null, leaving: null, next: null, since: 0 };
export type CardFlowEvent = { type: "step"; key: string; at: number } | { type: "left"; key: string } | { type: "tick"; at: number; ready: boolean };
export function cardFlow(f: CardFlow, ev: CardFlowEvent): CardFlow {
  if (ev.type === "step") {
    if (ev.key === f.shown || ev.key === f.next) return f;
    return { shown: null, leaving: f.shown ?? f.leaving, next: ev.key, since: ev.at };
  }
  if (ev.type === "left") return f.leaving === ev.key ? { ...f, leaving: null } : f;
  if (!f.next || f.leaving || (!ev.ready && ev.at - f.since < CARD_WAIT_CAP_MS)) return f;
  return { ...f, shown: f.next, next: null };
}

/** While the person types in the target field the card is a dot; it comes back GUIDE_TYPING_IDLE_MS after the last key, or on blur. */
export const GUIDE_TYPING_IDLE_MS = 1500;
export const cardDotted = (s: Pick<GuideStepUi, "typingAt">, now: number): boolean => s.typingAt !== undefined && now - s.typingAt < GUIDE_TYPING_IDLE_MS;

/** The dot's box, beside the field and never on it: right of it, else left, else just under it. */
export function guideDotAt(rect: PaneBox, pane: { w: number; h: number }, size: number): PaneBox {
  const gap = 6;
  const y = Math.round(Math.max(BUBBLE_EDGE, Math.min(pane.h - BUBBLE_EDGE - size, rect.y + rect.h / 2 - size / 2)));
  if (rect.x + rect.w + gap + size <= pane.w - BUBBLE_EDGE) return { x: Math.round(rect.x + rect.w + gap), y, w: size, h: size };
  if (rect.x - gap - size >= BUBBLE_EDGE) return { x: Math.round(rect.x - gap - size), y, w: size, h: size };
  return { x: Math.round(Math.max(BUBBLE_EDGE, Math.min(pane.w - BUBBLE_EDGE - size, rect.x + rect.w - size))), y: Math.round(Math.min(pane.h - BUBBLE_EDGE - size, rect.y + rect.h + gap)), w: size, h: size };
}

/** After the pointer leaves the record card, it stays at least this long before it fades. */
export const GUIDE_AUDIT_GRACE_MS = 2000;
/** The record card's wait before it fades: what is left of GUIDE_AUDIT_MS, or a fresh grace once the pointer left it. */
export const auditWait = (left: number, graced: boolean): number => (graced ? Math.max(left, GUIDE_AUDIT_GRACE_MS) : left);
/** The person ended the guide with Stop (not the run reaching its end, not the agent). */
export const personStopped = (g: Pick<TabGuide, "steps">): boolean => g.steps[g.steps.length - 1]?.did === "stop";
/** How an ended guide ended: done (every step reached, not stopped) or stopped. Null while on or with no steps. */
export function guideEndKind(g: Pick<TabGuide, "on" | "steps">): "done" | "stopped" | null {
  const last = g.steps[g.steps.length - 1];
  if (g.on || !last) return null;
  return last.did === "stop" || (!!last.m && last.n < last.m) ? "stopped" : "done";
}
/** Resume is offered only after the person's own Stop on a run, and only for GUIDE_RESUME_MS. */
export const guideResumable = (g: Pick<TabGuide, "run" | "steps" | "resumeUntil">, now: number): boolean =>
  !!g.run && personStopped(g) && !!g.resumeUntil && g.resumeUntil > now;
/** After the fade: a small card that keeps Resume while it can be used, else the card goes. */
export const auditAfterFade = (g: Pick<TabGuide, "run" | "steps" | "resumeUntil">, now: number): "small" | "gone" => (guideResumable(g, now) ? "small" : "gone");

/** How long the caption takes to type in: at most 600 ms, none with reduced motion. */
export function typingMs(len: number, calm: boolean): number {
  return calm ? 0 : Math.min(600, Math.max(0, len) * 12);
}

/**
 * What the bubble says and which buttons it has, for a step. The agent's words
 * first; when the page moved or the element could not be followed, the sentence
 * for that, by step kind. Back is hidden on step 1. A wait-click step has no OK:
 * the click on the target is the answer, unless the element is lost, when Done
 * stands in for it.
 */
export const GUIDE_CLICK_HINT = "Click the highlighted spot to continue";
export const GUIDE_GOT_IT = "Got it";
export const GUIDE_LEAVE_ASK = "Go back a step? This one is not done yet";
export const GUIDE_LEAVE_YES = "Go back";

/** The OK button's word on an OK step's lost card. */
export const GUIDE_SKIP = "Skip";

type Bubble = { text: string; note?: string; buttons: Array<"ok" | "back" | "stop" | "done">; waiting: boolean; label?: string; okWord?: string; confirmBack?: boolean; copy?: string; suggest?: string; suggestFilled?: boolean; summary?: string };

/** The small heading over a summary step's text on the card. */
export const GUIDE_SUMMARY_HEAD = "About this page";

/** The bubble for a step. `copy` and `suggest` ride along while the step's own words show;
 *  once the person has clicked ("Got it") there is nothing left to paste. */
export function bubbleOf(step: GuideStepUi, first: boolean, off: "up" | "down" | null = null): Bubble {
  const b = bubbleBase(step, first, off);
  if (b.text !== step.say) return b;
  return {
    ...b,
    ...(step.copy && !(step.waitClick && step.clicked) ? { copy: step.copy } : {}),
    ...(step.summary ? { summary: step.summary } : {}),
    ...(step.suggest ? { suggest: step.suggest, ...(step.suggestFilled ? { suggestFilled: true } : {}) } : {}),
  };
}

function bubbleBase(step: GuideStepUi, first: boolean, off: "up" | "down" | null): Bubble {
  const back = first ? [] : ["back" as const];
  /* A run's target is not on this page: the sentence says so, and Back is the way out. */
  /* An OK step lost on this page can be skipped: its OK, worded Skip, moves the run on. */
  if (step.gone) return { text: step.say, buttons: step.skip ? ["back", "stop", "ok"] : ["back", "stop"], waiting: false, label: step.m ? `Step ${step.n} of ${step.m}` : undefined, ...(step.skip ? { okWord: GUIDE_SKIP } : {}) };
  const label = step.m ? `Step ${step.n} of ${step.m}` : undefined;
  /* The person clicked, but the step may ask for more (click the box, then type and press Enter):
     its words stay until the agent points the next one, and "Got it" is only the small state line. */
  if (step.waitClick && step.clicked) return { text: step.say, note: GUIDE_GOT_IT, buttons: ["stop"], waiting: false, label };
  if (step.navigated) return { text: step.say, note: "The page changed", buttons: [...back, "stop"], waiting: false, label };
  if (step.lost) {
    return step.waitClick
      ? { text: step.say, note: "Can't follow this element. Click it, then press Done.", buttons: [...back, "stop", "done"], waiting: false, label }
      : { text: step.say, note: "Can't follow this element. Press OK when done.", buttons: [...back, "stop", "ok"], waiting: false, label };
  }
  /* Scrolled out of view: say which way; the usual note comes back when it shows again. */
  if (off) {
    const note = off === "down" ? "Scroll down to see it \u2193" : "Scroll up to see it \u2191";
    return { text: step.say, note, buttons: step.waitClick ? [...back, "stop"] : [...back, "stop", "ok"], waiting: false, label, ...(step.waitClick && back.length ? { confirmBack: true } : {}) };
  }
  /* A wait-click step has no OK, so the bubble says what moves it on, and
     Back asks first: the click it was waiting for is lost. */
  if (step.waitClick) return { text: step.say, note: GUIDE_CLICK_HINT, buttons: [...back, "stop"], waiting: true, label, ...(back.length ? { confirmBack: true } : {}) };
  return { text: step.say, buttons: [...back, "stop", "ok"], waiting: false, label };
}

/** How long the audit card stays after the guide ends before it fades: it is a record, not a
 *  question, and it sits in the middle of the page. A new guide on the tab replaces it at once. */
export const GUIDE_AUDIT_MS = 6000;
/** A guide that reached its end shows "Done · N steps" this long, then fades by itself. */
export const GUIDE_DONE_MS = 2000;

/** Milliseconds left before the audit card fades; 0 once it should go. None while the guide is on. */
export function auditLeft(g: TabGuide | undefined, now: number): number | undefined {
  if (!g || g.on) return undefined;
  return Math.max(0, (g.endedAt ?? now) + (guideEndKind(g) === "done" ? GUIDE_DONE_MS : GUIDE_AUDIT_MS) - now);
}

/** The person's audit card: only their own steps, what they did, and when. The agent's refusals never appear here. */
export function guideCard(g: TabGuide): { title: string; done: boolean; why?: string; rows: Array<{ n: number; say: string; did: string; at: string }> } {
  const did = (s: GuideStepUi) => {
    switch (s.did) {
      case "ok": return "You pressed OK";
      case "done": return "You pressed Done";
      case "back": return "You pressed Back";
      case "stop": return "You pressed Stop";
      case "click": return "You clicked it";
      case "navigated": return "The page changed";
      default: return "Not answered";
    }
  };
  const hms = (t?: number) => {
    if (!t) return "";
    const d = new Date(t);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  };
  /* Reached the end: one clear line. Stopped: the record, and Resume if it was the person's Stop. */
  const done = guideEndKind(g) === "done";
  const n = g.steps.length;
  const title = done ? `Done \u00b7 ${n} ${n === 1 ? "step" : "steps"}` : guideEndKind(g) === "stopped" ? "Guide stopped" : "Guide done";
  return { title, done, ...(g.why ? { why: g.why } : {}), rows: g.steps.map((s) => ({ n: s.n, say: s.say, did: did(s), at: hms(s.didAt) })) };
}
