/*
 * Which panes type straight through, and which ones were asked.
 *
 * ── the default, and why it is not just `useState(true)` ─────────────────
 * A pane opens in direct mode: what you type reaches it as you type it. That
 * is the mode a shell, a REPL, an editor and an agent's prompt all expect, and
 * composing a line first is the special case rather than the normal one. Orca
 * reached the same conclusion and wrote down the reason it is worth the
 * bookkeeping: the default has to be applied ONCE per pane, not on every
 * render and not on every refresh of the tab list.
 *
 * Because the tab list refreshes constantly. It refreshes when a pane is
 * opened, when tmux is polled, when the desk takes a window back. A default
 * re-applied on any of those would undo the choice somebody made ten seconds
 * ago, silently, and the only symptom would be a mode that "keeps changing
 * back" — which reads as a bug in the toggle rather than as a default being
 * re-run.
 *
 * So two sets rather than one. `live` is which panes are in direct mode.
 * `defaulted` is which panes have already had the question answered for them,
 * and it is what makes the default one-shot: a pane that has been turned OFF
 * stays in `defaulted`, so nothing puts it back.
 *
 * ── why a module and not three useStates ─────────────────────────────────
 * The whole of the difficulty is in the merge, and a merge is a function. The
 * screen it belongs to cannot be rendered on a machine with no phone, so the
 * rule that says "seen before" would otherwise be the one part of this with no
 * way to check it.
 */

export interface LiveModes {
  /** Panes whose keystrokes go straight to the pty. */
  readonly live: ReadonlySet<string>;
  /** Panes the default has already been applied to, whatever the answer was. */
  readonly defaulted: ReadonlySet<string>;
}

export const NO_MODES: LiveModes = { live: new Set(), defaulted: new Set() };

/**
 * Turn direct mode on for panes that have never been asked about.
 *
 * Everything already in `defaulted` is left exactly as it is — that is the
 * one-shot rule, and it is the whole reason this takes a second set. Returns
 * the SAME object when nothing changed, so a caller storing this in state does
 * not re-render on every poll that found the same tabs.
 */
export function applyDefault(state: LiveModes, panes: readonly string[]): LiveModes {
  const fresh = panes.filter((id) => id && !state.defaulted.has(id));
  if (!fresh.length) return state;
  const live = new Set(state.live);
  const defaulted = new Set(state.defaulted);
  for (const id of fresh) { live.add(id); defaulted.add(id); }
  return { live, defaulted };
}

/**
 * Somebody answered for themselves.
 *
 * The pane is marked `defaulted` either way, including when it is turned ON by
 * hand: the question has been answered, and a later refresh must not treat it
 * as new. Turning it on by hand and having the default turn it on again is
 * harmless today and would stop being harmless the day the default flips.
 */
export function setLive(state: LiveModes, pane: string, on: boolean): LiveModes {
  if (!pane) return state;
  const live = new Set(state.live);
  if (on) live.add(pane); else live.delete(pane);
  const defaulted = new Set(state.defaulted);
  defaulted.add(pane);
  return { live, defaulted };
}

/** Is this pane typing straight through? An absent pane is not, which is the
 *  safe answer: line mode cannot send anything nobody pressed Return on. */
export const isLive = (state: LiveModes, pane: string | null | undefined): boolean =>
  !!pane && state.live.has(pane);

/**
 * Forget panes that no longer exist.
 *
 * Driven by the authoritative list of panes and by nothing else. A tab
 * snapshot can lag a pane that was just created or just closed, and pruning
 * from a lagging list would drop a live pane's mode and then hand it back as
 * "never seen" on the next poll — the default re-applying under a different
 * name. So this is called with what tmux actually reported, or not at all.
 */
export function prune(state: LiveModes, alive: readonly string[]): LiveModes {
  const keep = new Set(alive);
  const live = new Set([...state.live].filter((id) => keep.has(id)));
  const defaulted = new Set([...state.defaulted].filter((id) => keep.has(id)));
  if (live.size === state.live.size && defaulted.size === state.defaulted.size) return state;
  return { live, defaulted };
}
