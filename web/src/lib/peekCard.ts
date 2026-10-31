/*
 * The peek card's timing, as a state machine with no clock in it.
 *
 * Hover a tab and, after a breath, a small card says what the window is. The
 * breath is 450 ms so sweeping the pointer across the strip opens nothing; but
 * once one card has been up, the next tab's card opens at once and without its
 * entrance ("warm"), because a card that makes you wait every time you move one
 * tab over is a strip that feels slow. Warm lasts 300 ms from the close.
 *
 * The caller owns the one setTimeout: it asks `peekEnter` how long to wait, and
 * calls `peekFire` when that timer ends. Nothing here reads the time or polls.
 */

export const PEEK_DELAY_MS = 450;
export const PEEK_WARM_MS = 300;

export interface PeekState {
  /** The tab the pointer is on and a card is wanted for. */
  id: string | null;
  /** The card is on screen. */
  shown: boolean;
  /** When the last card closed (ms), for the warm window. */
  closedAt: number | null;
  /** The card on screen opened warm: no entrance animation. */
  warm: boolean;
}

export const PEEK_IDLE: PeekState = { id: null, shown: false, closedAt: null, warm: false };

/** Everything that puts the card away at once. */
export const PEEK_HIDE_EVENTS = ["click", "contextmenu", "dragstart", "wheel", "keydown"] as const;

/** 0 when a card closed less than PEEK_WARM_MS ago, else the full delay. */
export function peekDelay(closedAt: number | null, now: number): number {
  return closedAt !== null && now - closedAt < PEEK_WARM_MS ? 0 : PEEK_DELAY_MS;
}

/** The pointer reached a tab. `wait` is how long the caller's timer should run; 0 = open now. */
export function peekEnter(s: PeekState, id: string, now: number): { state: PeekState; wait: number } {
  if (s.shown && s.id === id) return { state: s, wait: 0 };
  // Moving from one shown card to the next tab is the warm case too: nothing closed in between.
  const wait = s.shown ? 0 : peekDelay(s.closedAt, now);
  const warm = s.shown || wait === 0;
  if (wait === 0) return { state: { id, shown: true, closedAt: s.closedAt, warm }, wait };
  return { state: { id, shown: false, closedAt: s.closedAt, warm: false }, wait };
}

/** The caller's timer ended for `id`. A pointer that has left since does not open it. */
export function peekFire(s: PeekState, id: string): PeekState {
  if (s.id !== id || s.shown) return s;
  return { ...s, shown: true, warm: false };
}

/** The pointer left the tab, or a hide event arrived. */
export function peekHide(s: PeekState, now: number): PeekState {
  if (!s.shown && s.id === null) return s;
  return { id: null, shown: false, closedAt: s.shown ? now : s.closedAt, warm: false };
}

/**
 * What the window is doing, as one sentence for the card.
 *
 * `title` is the strip mark's own wording ("needs you", "was running Claude
 * Code"); the status adds the two states the strip stays quiet about. A window
 * with neither is a plain shell and says so.
 */
export function peekSentence(status: string | null | undefined, markTitle: string): string {
  if (markTitle === "needs you") return "Needs you: it is waiting for an answer.";
  if (markTitle === "failed") return "It hit an error.";
  if (markTitle.startsWith("exited")) return `The process ${markTitle}.`;
  if (markTitle.startsWith("was running")) return `Restored; ${markTitle}, nothing is running yet.`;
  if (markTitle === "restored") return "Restored; nothing is running yet.";
  if (markTitle === "working") return "Working.";
  if (status === "done") return "Finished its turn; you have not looked yet.";
  if (status === "idle") return "Idle; nothing to do.";
  return "A shell.";
}

/** "#318 open", "#318 draft", "#318 merged". */
export function prText(pr: { number: number; state: string; isDraft?: boolean }): string {
  return `#${pr.number} ${pr.isDraft && pr.state === "OPEN" ? "draft" : pr.state.toLowerCase()}`;
}
