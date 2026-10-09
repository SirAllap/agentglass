/*
 * The way back from a view an agent switched to.
 *
 * `view.open`, `pane.open` and `workspace.toggle` replace the whole window, and
 * the person loses the chat where the agent keeps talking. Nothing about the
 * switch is wrong (they asked to be shown), but nothing marked the way back
 * either, so this holds one offer: where the person was, where the agent put
 * them, and who. The chip (components/AgentBackChip.tsx) shows it, and one click
 * is goView(from).
 *
 * The decisions are functions of their arguments so they can be tested alone;
 * the store at the bottom only holds the state they return.
 *
 * What it cannot do: tell an agent's switch from the person's own when both land
 * inside ARM_MS of a door that switches views, and it remembers one place, not a
 * history, so a second switch keeps the FIRST place the person was in.
 */
import type { ViewId } from "../../../shared/types.ts";
import type { UiActionId } from "../../../shared/uiActions.ts";

/** The doors that can replace the whole view. A guard test reads the handler
 *  table as text and fails when a handler that calls `goView(` is not here. */
export const VIEW_SWITCHERS: readonly UiActionId[] = [
  "view.open", "workspace.toggle", "pane.open", "chat.new",
  "git.modal", "git.compare", "git.blame", "git.rebase", "lantern.schedule", "terminal.resume",
];

/** A view change this soon after a switching door ran is the door's doing
 *  (`pane.open` lands through a worktree jump one render later). */
export const ARM_MS = 3_000;
/** The offer stays this long unless it is clicked or dismissed. */
export const BACK_MS = 60_000;

export interface Armed { from: ViewId; as?: string; at: number }
export interface Back { from: ViewId; to: ViewId; as?: string; at: number }
export interface BackState { armed: Armed | null; offer: Back | null }

export const EMPTY: BackState = { armed: null, offer: null };

/**
 * A switching door is about to run while the person is on `current`. If an offer
 * is still standing on the view the agent last sent them to, the place to go
 * back to stays the original one: a second switch must not make the way back
 * "back to the agent's first view".
 */
export function arm(s: BackState, current: ViewId, as: string | undefined, now: number): BackState {
  const from = s.offer && s.offer.to === current ? s.offer.from : current;
  return { ...s, armed: { from, ...(as ? { as } : {}), at: now } };
}

/** The window now shows `view`. */
export function noteView(s: BackState, view: ViewId, now: number): BackState {
  const a = s.armed;
  if (a && now - a.at <= ARM_MS) {
    if (view === a.from) return { armed: null, offer: null }; // went back to where they were: nothing to offer
    return { armed: null, offer: { from: a.from, to: view, ...(a.as ? { as: a.as } : {}), at: now } };
  }
  // Not an agent's switch. An offer whose view the person has already left is stale.
  const o = s.offer;
  return { armed: null, offer: o && o.to === view ? o : null };
}

/** The offer, or null once it is old. */
export const live = (o: Back | null, now: number): Back | null => (o && now - o.at < BACK_MS ? o : null);

/** The chip's words: the way back and who sent the person away. */
export const backText = (label: string, as: string | undefined): string => `Back to ${label} · ${as || "An agent"}`;

// ── the store ───────────────────────────────────────────────────────────────

let state: BackState = EMPTY;
const subs = new Set<() => void>();
const set = (s: BackState) => { state = s; for (const f of subs) f(); };

export const back = {
  offer: (): Back | null => state.offer,
  subscribe(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn); }; },
  arm: (current: ViewId, as?: string, now: number = Date.now()) => set(arm(state, current, as, now)),
  noteView: (view: ViewId, now: number = Date.now()) => {
    const next = noteView(state, view, now);
    if (next.armed !== state.armed || next.offer !== state.offer) set(next);
  },
  dismiss: () => { if (state.offer) set({ ...state, offer: null }); },
  /** For a test. */
  reset: () => set(EMPTY),
};
