import type { MouseEvent } from "react";

/**
 * Keep the terminal focused when the panel's own chrome is clicked.
 *
 * A mousedown on a button, a tab or a menu's own padding blurs whatever held
 * focus — here the xterm textarea — and nothing puts it back, so the next
 * keystroke lands nowhere until you click into the terminal a second time. It
 * is the same annoyance a text editor's toolbar has, and the same fix:
 * preventDefault on the *mousedown* stops the browser moving focus, while the
 * click still fires, so the button does its job and the shell keeps the cursor.
 *
 * The one thing it must not swallow is a real text field — the rename box, a
 * filter input — which is asking for the focus on purpose. Those are left
 * alone so they can be clicked into and their cursor placed; when they close
 * again the caller hands the focus back to the terminal itself.
 */
export function keepTermFocus(e: MouseEvent) {
  const t = e.target as HTMLElement;
  if (t.closest("input, textarea, select, [contenteditable='true']")) return;
  e.preventDefault();
}
