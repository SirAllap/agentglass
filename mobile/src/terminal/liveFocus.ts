/*
 * Opening the keyboard for a field nobody can see.
 *
 * ── what this is for ─────────────────────────────────────────────────────
 * In `keys` mode the composer is not a field. It is a button that reports the
 * line and, when pressed, hands the keyboard to a 1×1 transparent TextInput
 * sitting behind it — every keystroke goes to the pane as bytes and nothing on
 * screen grows. Orca's mobile client is built the same way and calls it live
 * input; the two problems below are the ones that arrangement creates, and
 * both of them fail silently, which is why they are here with tests rather
 * than inline with a comment.
 *
 * ── one: the WebView has not let go yet ──────────────────────────────────
 * The tap that should open the keyboard lands on the terminal, which is a
 * WebView, and the WebView still owns the keyboard at the moment it tells us
 * the touch ended. Focusing inside that notification is a no-op — the tap does
 * nothing at all, which reads as the app being broken rather than as a race.
 * So a focus is scheduled rather than performed, and a pending one is replaced
 * rather than queued: two quick taps during a route change would otherwise
 * focus a field that has since been unmounted.
 *
 * ── two: Android keeps a hidden field focused after the IME is gone ───────
 * Dismiss the keyboard with the back gesture and the field is still, as far as
 * it is concerned, focused. `focus()` on an already-focused field does
 * nothing, so the keyboard never comes back and the only way out is to leave
 * the screen. The fix is to notice the disagreement — the keyboard is down and
 * the field says it is focused — and force a new focus session by blurring
 * first. That is the whole reason this takes `keyboardShown`: it is not
 * decoration, it is the only evidence that the two disagree.
 */

/** What the module needs from a TextInput. Narrow on purpose: this is unit
 *  tested with plain objects, and a full ref would drag react-native into a
 *  suite that has no phone to render on. */
export interface FocusTarget {
  focus: () => void;
  blur: () => void;
  isFocused?: () => boolean;
}

/** A mutable box holding the pending timer, owned by the caller's `useRef`. */
export interface FocusTimer { current: ReturnType<typeof setTimeout> | null }

/** Drop a pending focus. Called on unmount and before scheduling another. */
export function clearFocusTimer(timer: FocusTimer): void {
  if (timer.current === null) return;
  clearTimeout(timer.current);
  timer.current = null;
}

/**
 * Focus, but not yet.
 *
 * 50ms is Orca's number and it is a settling time rather than a guess at how
 * long the WebView takes: it has to outlast the touch notification and stay
 * under what a person reads as lag. Replacing a pending call rather than
 * queueing another is the load-bearing half — see the note above about a route
 * change between the tap and the timer.
 */
export function scheduleFocus(timer: FocusTimer, focus: () => void, delayMs = 50): void {
  clearFocusTimer(timer);
  timer.current = setTimeout(() => {
    timer.current = null;
    focus();
  }, delayMs);
}

/**
 * Ask for the keyboard, and notice when asking is not enough.
 *
 * `keyboardShown` false with `isFocused()` true is the Android state described
 * above. Blurring makes the next focus a new session, and the retry goes
 * through the caller's scheduler so it is subject to the same cancellation as
 * every other pending focus.
 */
export function focusCapture(
  target: FocusTarget | null | undefined,
  { keyboardShown, retry }: { keyboardShown: boolean; retry: () => void },
): void {
  if (!target) return;
  if (!keyboardShown && target.isFocused?.()) {
    target.blur();
    retry();
    return;
  }
  target.focus();
}

/**
 * What the bar says under its title.
 *
 * The captured line, or an instruction when there is none. `ellipsizeMode`
 * cannot be expressed here — the caller sets it to `head`, so a long line
 * shows its END, which is the part being typed. Truncating the other way would
 * hide the cursor's own neighbourhood, which is the only part anybody is
 * looking at.
 */
export function liveDetail(captured: string, idle = "Tap to show keyboard"): string {
  return captured.length > 0 ? captured : idle;
}
