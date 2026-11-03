/*
 * Where a Jira card opens: beside the list (the dock) or over it. The body kept this as a React state under
 * `agentglass.jira.cardMode`; the list pane reads the same key so a choice made before still stands. One store, so the
 * toolbar's pair and the dock agree without a prop between them.
 */
import { useSyncExternalStore } from "react";

export type CardMode = "side" | "modal";
const KEY = "agentglass.jira.cardMode";
const subs = new Set<() => void>();
let mode: CardMode | null = null;

export function readCardMode(): CardMode {
  if (mode) return mode;
  try { mode = localStorage.getItem(KEY) === "modal" ? "modal" : "side"; } catch { mode = "side"; }
  return mode;
}

export function setCardMode(next: CardMode): void {
  mode = next;
  try { localStorage.setItem(KEY, next); } catch { /* private mode: the choice lasts this visit */ }
  subs.forEach((f) => f());
}

export const useCardMode = (): CardMode =>
  useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, readCardMode, () => "side");
