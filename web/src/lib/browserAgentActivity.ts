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
