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

export interface AgentAction { verb: string; target: string; ok: boolean; at: number }
export interface TabAgent { agent: string; working: number; paused: boolean; log: AgentAction[] }
export type Activity = Record<string, TabAgent>;

export type ActivityEvent =
  | { type: "begin"; tab: string; agent: string }
  | { type: "end"; tab: string; action: AgentAction | null }
  | { type: "pause"; tab: string; paused: boolean }
  | { type: "forget"; tab: string };

export function activityReducer(state: Activity, ev: ActivityEvent): Activity {
  const cur = state[ev.tab];
  switch (ev.type) {
    case "begin":
      return { ...state, [ev.tab]: { agent: ev.agent, working: (cur?.working ?? 0) + 1, paused: cur?.paused ?? false, log: cur?.log ?? [] } };
    case "end": {
      if (!cur) return state;
      const log = ev.action ? [...cur.log, ev.action].slice(-LOG_MAX) : cur.log;
      return { ...state, [ev.tab]: { ...cur, working: Math.max(0, cur.working - 1), log } };
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

export function flashPlan(ask: { op: string; args: Record<string, unknown> }): FlashPlan {
  if (!FLASH_VERBS.has(ask.op)) return null;
  const a = ask.args;
  if (ask.op === "fill" && a.fields && typeof a.fields === "object") {
    const first = Object.keys(a.fields as object)[0];
    return first ? { kind: "selector", selector: first } : null;
  }
  if (typeof a.selector === "string" && a.selector) return { kind: "selector", selector: a.selector };
  return ask.op === "press" ? { kind: "focus" } : null;
}

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
export const PRESENCE_LINGER_MS = 4000;
/* The island's shape changes with the driver (the agent's pill is narrower than
   the person's bar), so it waits out a whole model call before handing the bar
   back: a think between two clicks often runs past the rim's four seconds, and
   a pill that changes shape on every one of them reads as broken. */
export const ISLAND_LINGER_MS = 30_000;

const DOING: Record<string, string> = {
  click: "Clicking", dblclick: "Double-clicking", rightclick: "Right-clicking", check: "Ticking",
  fill: "Filling", type: "Typing in", select: "Choosing in", press: "Pressing",
};

/** The few words beside the drawn pointer: what the agent did, to what. A name the page gave the element, never a value. */
export function presenceLabel(verb: string, name: string, key = ""): string {
  const doing = DOING[verb] ?? verb;
  if (verb === "press") return key ? `${doing} ${clip(key, 16)}` : doing;
  const n = name.trim();
  return n ? `${doing} ${clip(n, 32)}` : doing;
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
