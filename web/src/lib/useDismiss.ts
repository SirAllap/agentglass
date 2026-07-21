import { useEffect, type RefObject } from "react";

/**
 * Close an open menu the way every other menu on the machine closes.
 *
 * Pickers used to stay open until you picked something or toggled the same
 * button again, so one opened by accident sat over the thing you were trying to
 * read. This was written once in the terminal and not in Source control, which
 * is exactly how a fixed bug stays half-fixed — so it lives here now and both
 * call it.
 *
 * `mousedown`, not `click`: closing on press rather than release means the menu
 * is gone before the thing underneath reacts, which is what makes it feel like
 * a dismissal instead of a delayed one. Capture phase for the same reason.
 *
 * Escape stops propagating, because the workspace listens for it too and one
 * press would otherwise dismiss the menu *and* the panel behind it.
 */
export function useDismiss(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  close: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
    // `close` is called, never compared — a caller passing an inline arrow must
    // not resubscribe this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ref]);
}
