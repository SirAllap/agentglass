import { useSyncExternalStore } from "react";

/**
 * One width for every workspace view's left pane, and the user's to set.
 *
 * Each panel used to pick its own number — 236, 300, 340, 340 — so the list
 * column jumped as you moved between git, diff, docker and chat. Nobody chose
 * those values against each other; they were four independent guesses at the
 * same question, and the inconsistency is visible the moment you switch views.
 *
 * A single store rather than a shared constant, because the widths also need to
 * be draggable: one repo's container names want more room than another's file
 * list, and that is a judgement only the person looking at it can make.
 */

const KEY = "agentglass.sidebarWidth";
/** Narrow enough to get out of the way, wide enough for a ticket-length branch
 *  name; past the upper bound the list stops being a sidebar. */
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 680;
const DEFAULT = 300;

const clamp = (n: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(n)));

let width = (() => {
  try {
    const v = Number(localStorage.getItem(KEY));
    return v ? clamp(v) : DEFAULT;
  } catch { return DEFAULT; }
})();

const listeners = new Set<() => void>();

export const sidebarWidth = (): number => width;

export function setSidebarWidth(px: number) {
  const next = clamp(px);
  if (next === width) return;
  width = next;
  try { localStorage.setItem(KEY, String(next)); } catch { /* non-fatal */ }
  for (const fn of listeners) fn();
}

export function subscribeSidebarWidth(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The width, live. Every pane using this resizes together, which is the point. */
export function useSidebarWidth(): number {
  return useSyncExternalStore(subscribeSidebarWidth, sidebarWidth, () => DEFAULT);
}

/**
 * Begin a drag from a grip.
 *
 * Listens on the window rather than the handle: the pointer routinely leaves a
 * 5px strip mid-drag, and a handler bound to the strip stops receiving moves
 * the moment it does — which reads as the drag "sticking".
 */
export function beginSidebarDrag(e: { clientX: number; preventDefault: () => void }, startWidth: number) {
  e.preventDefault();
  const startX = e.clientX;
  const move = (ev: MouseEvent) => setSidebarWidth(startWidth + (ev.clientX - startX));
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };
  // While dragging, the cursor and the no-select belong to the whole document:
  // otherwise the pointer flickers between resize and text as it crosses the
  // panes, and the drag selects the file list it passes over.
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}
