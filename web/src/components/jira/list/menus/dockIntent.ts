/*
 * "Move to", "Assign to" and "Comment" in a right-click menu open the card in the dock and ask it to land on the
 * control: the state chip's menu, the people picker, the Activity tab's composer. The menu cannot reach into the card
 * pane, so it leaves a request here and the pane takes it once.
 *
 *   askDock(cardId, "move")        the menu host, after it has opened the card
 *   useDockIntent(id, act)         the card pane: calls `act(what)` once for a request about the card it shows
 *
 * The pane takes a request (it is cleared the moment it is taken), so a card opened again later is not sent to a control
 * by an old menu pick; a request nobody took in 5 s is dropped for the same reason.
 *
 * Ceiling: one request at a time.
 */
import { useEffect, useSyncExternalStore } from "react";

export type DockWhat = "move" | "assign" | "comment";
export interface DockIntent { seq: number; id: string; what: DockWhat; at: number }
export const INTENT_MS = 5000;

let current: DockIntent | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const subscribe = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function askDock(id: string, what: DockWhat): void {
  current = { seq: ++seq, id, what, at: Date.now() };
  for (const l of listeners) l();
}

export const getDockIntent = (): DockIntent | null => current;

/** Take the request if it is for this card and still fresh; it is gone for everybody after that. */
export function takeDockIntent(id: string, now = Date.now()): DockWhat | null {
  const i = current;
  if (!i || i.id !== id) return null;
  current = null;
  return now - i.at <= INTENT_MS ? i.what : null;
}

export function useDockIntent(id: string, act: (what: DockWhat) => void): void {
  const seen = useSyncExternalStore(subscribe, getDockIntent, getDockIntent);
  useEffect(() => {
    if (!seen) return;
    const what = takeDockIntent(id);
    if (what) act(what);
  }, [seen, id]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Test seam. */
export function __resetDockIntent(): void { current = null; seq = 0; listeners.clear(); }
