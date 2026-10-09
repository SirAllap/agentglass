import { useEffect, useState } from "react";

/**
 * How long a prepared dialog keeps its confirm button dead after it opens.
 *
 * A dialog an agent filled in can appear under a hand that was heading for the
 * keyboard anyway (a held, quiet open is applied when the person goes idle, and
 * they come back to it), and Enter or a click on reflex would then complete
 * something nobody read. One second is long enough for the eye to land on the
 * "prepared by" line and short enough that a person who did read it never
 * notices the wait.
 */
export const STAGE_HOLD_MS = 1000;

/**
 * True from the first render of a prepared dialog until STAGE_HOLD_MS later (a new
 * `key` starts it again), false for ever when it is not a prepared dialog.
 *
 * The answer is worked out on the render itself, from the key whose hold has
 * finished, and not from a flag an effect sets after paint: the dialogs are
 * always mounted with nothing pending, so a flag would read false on the very
 * frame the dialog first appears, and that frame is the one a reflex lands on.
 */
export function useStageHold(active: boolean, key?: unknown): boolean {
  const [finished, setFinished] = useState<unknown>(undefined);
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setFinished(key), STAGE_HOLD_MS);
    return () => clearTimeout(t);
  }, [active, key]);
  return active && finished !== key;
}

/** The line every prepared dialog carries. `by` is the name the sender gave
 *  itself, so it is shown as a label and never as a fact about who it is. */
export const preparedLine = (by: string): string =>
  `Prepared by "${by}", an agent. Read it and edit it: nothing is sent until you press the button yourself.`;
