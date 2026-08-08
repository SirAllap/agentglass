/**
 * Work that must not land while the user is dragging.
 *
 * The case this exists for is refitting a terminal. A refit is `term.resize()`,
 * which reaches the shell as a SIGWINCH, and tmux drops whatever drag it was in
 * the middle of when its client changes size — measured against a real tmux over
 * a real pty: a selection dragged up 25 rows keeps 11 of them if a resize lands
 * at row 12, and a divider dragged 30 columns moves 13. Neither the button nor
 * the pointer did anything; the gesture simply stops, and the only way on is to
 * let go and grab again.
 *
 * So the work waits for the button instead of being cancelled: `hold` answers
 * "not now" and remembers what was asked for, `end` runs it. Deliberately a Set
 * rather than a queue — fifty fits asked for during one drag are one fit owed at
 * the end of it, and replaying all fifty would be fifty reflows of the
 * scrollback for a size that only ever had one answer.
 */
export type DragHold<T> = {
  /** The pointer went down on something whose work should wait. */
  begin(): void;
  /** It came back up (or the window lost it). Runs what was held, once each. */
  end(): void;
  /** True when the caller should do nothing — the item is remembered for `end`. */
  hold(item: T): boolean;
  /** Whether a drag is in flight, for callers that only need to ask. */
  active(): boolean;
};

export function dragHold<T>(replay: (item: T) => void): DragHold<T> {
  let dragging = false;
  const held = new Set<T>();
  return {
    begin() { dragging = true; },
    end() {
      // Guarded, because the release listener is armed on the window and a
      // mouseup can arrive with no drag of ours behind it.
      if (!dragging) return;
      dragging = false;
      const waiting = [...held];
      held.clear();
      // One item throwing must not swallow the rest: these are independent
      // terminals, and the one that went away while the button was down is
      // exactly the case where the others still need their fit.
      for (const item of waiting) {
        try { replay(item); } catch { /* whatever owned it is gone */ }
      }
    },
    hold(item: T) {
      if (!dragging) return false;
      held.add(item);
      return true;
    },
    active() { return dragging; },
  };
}
