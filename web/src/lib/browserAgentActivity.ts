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

export const LOG_MAX = 20;

/** The verbs that change a page, which is what a person wants to see written
 *  down. Reads (`observe`, `read`, `shot`) would fill twenty rows in a minute. */
const ACT_VERBS = new Set([
  "click", "dblclick", "rightclick", "check", "fill", "type", "press", "select",
  "drag", "upload", "back", "forward", "reload",
]);

/** Verbs that act ON an element, so there is somewhere to draw. */
const FLASH_VERBS = new Set(["click", "dblclick", "rightclick", "check", "fill", "type", "press", "select"]);
/** Verbs the drawn pointer follows: the flash's, plus the two that only move the eye (a scroll with no selector has no place to point). */
const POINT_VERBS = new Set([...FLASH_VERBS, "hover", "scroll"]);

export interface AgentAction { verb: string; target: string; ok: boolean; at: number }
export interface TabAgent { agent: string; working: number; paused: boolean; log: AgentAction[]; /** The agent said it is finished, until its next ask. */ done?: boolean; /** The verb of the last ask begun. */ op?: string; /** When the last ask ended, read or act: reads leave no log entry. */ lastAt?: number }
export type Activity = Record<string, TabAgent>;

export type ActivityEvent =
  | { type: "begin"; tab: string; agent: string; op?: string }
  | { type: "done"; tab: string }
  | { type: "end"; tab: string; action: AgentAction | null; at?: number }
  | { type: "pause"; tab: string; paused: boolean }
  | { type: "forget"; tab: string };

export function activityReducer(state: Activity, ev: ActivityEvent): Activity {
  const cur = state[ev.tab];
  switch (ev.type) {
    case "begin":
      return { ...state, [ev.tab]: { agent: ev.agent, working: (cur?.working ?? 0) + 1, paused: cur?.paused ?? false, log: cur?.log ?? [], op: ev.op } };
    case "done":
      // Still mid-ask: a `done` now would drop the glass over a page the agent is typing into.
      if (cur && cur.working > 0) return state;
      return { ...state, [ev.tab]: { agent: cur?.agent ?? "agent", working: 0, paused: cur?.paused ?? false, log: cur?.log ?? [], done: true, op: cur?.op } };
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
    case "forget": {
      if (!(ev.tab in state)) return state;
      const { [ev.tab]: _gone, ...rest } = state;
      return rest;
    }
  }
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
  return !!cur && typeof as === "string" && as.trim() !== "" && as.trim() === cur.agent;
}

/** What an agent is told when the person has the tab. */
export function pausedRefusal(agent: string): string {
  return `the person took this tab over: ask again later, or use your own tab with \`open --as ${agent || "<your name>"} <url>\``;
}

export function isActVerb(op: string): boolean {
  return ACT_VERBS.has(op);
}

/** A selector is a locator, never a value; clipped so a long CSS chain stays one line. */
const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * One row of the log for a finished ask, or null when it is not worth a row.
 * Only the selector (or the key name) is kept: what was typed or filled in is
 * never read here, so a secret cannot reach the log by way of this function.
 */
export function actionOf(ask: { op: string; args: Record<string, unknown> }, ok: boolean, now: number): AgentAction | null {
  if (!ACT_VERBS.has(ask.op)) return null;
  const a = ask.args;
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

export type AgentStateKey = "clicking" | "typing" | "navigating" | "scrolling" | "pointing" | "reading" | "scripting" | "thinking" | "yours" | "waiting" | "done" | "working";

const STATE_OF: Record<string, AgentStateKey> = {
  click: "clicking", dblclick: "clicking", rightclick: "clicking", check: "clicking", drag: "clicking", upload: "clicking",
  type: "typing", fill: "typing", press: "typing", select: "typing",
  open: "navigating", back: "navigating", forward: "navigating", reload: "navigating", newtab: "navigating",
  scroll: "scrolling", hover: "pointing", eval: "scripting",
};
const STATE_WORD: Record<AgentStateKey, string> = {
  clicking: "Clicking", typing: "Typing", navigating: "Navigating", scrolling: "Scrolling",
  pointing: "Pointing", reading: "Reading", scripting: "Scripting", thinking: "Thinking", yours: "You have it", waiting: "Waiting", done: "Done", working: "Working",
};

export const stateOf = (key: AgentStateKey) => ({ key, word: STATE_WORD[key] });

/** One word for what the agent is doing now: a state, not an account of it. Anything that is not an act is a read. */
export function agentState(a: Pick<TabAgent, "working" | "paused" | "op">): { key: AgentStateKey; word: string } {
  const key: AgentStateKey = a.paused ? "yours" : a.working > 0 ? STATE_OF[a.op ?? ""] ?? (a.op ? "reading" : "working") : "thinking";
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
export function tabState(a: TabAgent | undefined, kept: string | undefined, now: number): { key: AgentStateKey; word: string } | null {
  if (a && (a.paused || a.working > 0)) return agentState(a);
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
  const instant = raw === ("yours" as string) || s.shown === ("yours" as string);
  const due = instant ? now : Math.max(c.candAt + CANDIDATE_MS, s.shownAt + MIN_SHOW_MS);
  return now >= due ? { s: { shown: raw, shownAt: now, cand: null, candAt: 0 }, wait: 0 } : { s: c, wait: due - now };
}

/** The busiest of a container's tabs speaks for the box. */
const RANK: Record<AgentStateKey, number> = { yours: 5, clicking: 4, typing: 4, navigating: 4, scrolling: 4, pointing: 4, reading: 4, scripting: 4, working: 4, thinking: 3, waiting: 2, done: 1 };
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
