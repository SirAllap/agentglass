// Desktop DND, as the web sees it — plus the two other facts whereItShows
// needs: is the window on screen, and may an agent that waits break through.
//
// On Omarchy the switch IS the desktop's Do Not Disturb (server/src/desktopDnd.ts
// asks `omarchy-shell notifications isDnd`). Anywhere else there is no portable
// way to read it, so the switch is agentglass's own setting, stored here: on,
// agentglass shows cards for other apps' notes; off, it trusts the desktop to
// draw them. Either way the bell and the Settings row say which it is.
//
// Read when the module loads and whenever the window comes back to the front —
// events, not a timer.
import { api } from "./api.ts";
import type { Screen } from "./notePolicy.ts";

export type DndState = { supported: boolean; on: boolean };

const LOCAL_KEY = "agentglass.notes.dnd";
const BREAK_KEY = "agentglass.notes.breakThrough";

const readLocal = (): boolean => { try { return localStorage.getItem(LOCAL_KEY) === "1"; } catch { return false; } };

let state: DndState = { supported: false, on: readLocal() };
const listeners = new Set<() => void>();
const changed = () => { for (const fn of listeners) fn(); };

/** The same object until it changes, for useSyncExternalStore. */
export const desktopDnd = (): DndState => state;

export function subscribeDesktopDnd(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** What the server said (a read, a write, or another tab's write). Unsupported falls back to the local switch. */
export function receiveDesktopDnd(d: DndState): void {
  const next = d.supported ? { supported: true, on: d.on } : { supported: false, on: readLocal() };
  if (next.supported === state.supported && next.on === state.on) return;
  state = next;
  changed();
}

export async function refreshDesktopDnd(): Promise<void> {
  try {
    const r = await api.desktopDnd();
    if (r?.ok) receiveDesktopDnd(r);
  } catch { /* the server is away; keep what we had */ }
}

export async function setDesktopDnd(on: boolean): Promise<void> {
  if (!state.supported) {
    try { localStorage.setItem(LOCAL_KEY, on ? "1" : "0"); } catch { /* private mode */ }
    state = { supported: false, on };
    changed();
    return;
  }
  state = { supported: true, on };
  changed();
  try {
    const r = await api.setDesktopDnd(on);
    if (r?.ok) receiveDesktopDnd(r);
  } catch { void refreshDesktopDnd(); }
}

/** "Agents waiting on you break through DND". On unless turned off (decided: option A). */
export function breakThrough(): boolean {
  try { return localStorage.getItem(BREAK_KEY) !== "0"; } catch { return true; }
}

export function setBreakThrough(on: boolean): void {
  try { localStorage.setItem(BREAK_KEY, on ? "1" : "0"); } catch { /* private mode */ }
  changed();
}

/** The window is on screen: not a background tab, not minimised or hidden. */
export const windowVisible = (): boolean => typeof document === "undefined" || document.visibilityState !== "hidden";

/** Everything whereItShows needs, read now. */
export const screenNow = (): Screen => ({ dnd: state.on, visible: windowVisible(), breakThrough: breakThrough() });

/**
 * The same, for agentglass's own notes, where "on screen" means "has the
 * person's focus". A window that is not hidden can still be on another
 * workspace, behind another window: there a card is drawn nobody sees and the
 * popup it replaced never goes out. fireWatchAlert asked document.hasFocus()
 * for this reason; own notes and gate popups now ask the same.
 */
export const attentionNow = (): Screen => ({
  ...screenNow(),
  visible: windowVisible() && (typeof document === "undefined" || typeof document.hasFocus !== "function" || document.hasFocus()),
});

if (typeof window !== "undefined" && typeof document !== "undefined") {
  void refreshDesktopDnd();
  window.addEventListener?.("focus", () => { void refreshDesktopDnd(); });
  document.addEventListener?.("visibilitychange", () => { if (!document.hidden) void refreshDesktopDnd(); });
}
