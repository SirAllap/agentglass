/*
 * "Confirm board moves": whether dropping a card on another column waits for a yes (the inline Enter/Esc bar) or
 * moves it at once. A preference of this window (localStorage, like Sync with Jira filters), default on so a drag
 * never writes to Jira by accident; a window that never chose follows the default if it ever moves.
 */
import { useSyncExternalStore } from "react";

const KEY = "agentglass.jira.confirmBoardMoves";
export const DEFAULT_CONFIRM_BOARD_MOVES = true;

const listeners = new Set<() => void>();
const read = (): string | null => { try { return localStorage.getItem(KEY); } catch { return null; } };

export const confirmBoardMovesNow = (): boolean => (read() === null ? DEFAULT_CONFIRM_BOARD_MOVES : read() === "1");

export function setConfirmBoardMoves(on: boolean): void {
  try { if (on === DEFAULT_CONFIRM_BOARD_MOVES) localStorage.removeItem(KEY); else localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* private mode */ }
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY || e.key === null) l(); };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => { listeners.delete(l); if (typeof window !== "undefined") window.removeEventListener("storage", onStorage); };
}

export function useConfirmBoardMoves(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, confirmBoardMovesNow, () => DEFAULT_CONFIRM_BOARD_MOVES);
  return [on, setConfirmBoardMoves];
}
