/*
 * Where the card panel sits: docked right (the default), a floating window, or popped out over the board. The pop-out is
 * the "over the list" card choice (`jiraCardMode`), so the toolbar's pair and the panel's buttons agree; this store keeps
 * the other two and where the floating window sits. Per window: localStorage, and a window where it throws keeps the
 * choice for the visit only.
 */
import { useSyncExternalStore } from "react";
import { setCardMode, useCardMode } from "./jiraCardMode.ts";

export type DockMode = "dock" | "float" | "pop" | "bottom";
export type FloatBox = { x: number; y: number };

/** The floating window: 520 wide, two thirds of the screen tall, never less than 380 wide (the dock's minimum). */
export const FLOAT_W = 520;
export const FLOAT_H_PCT = 66;
export const FLOAT_MIN_W = 380;
/** The pop-out is wider than the dock, narrower than the screen. */
export const POP_W = 1100;
/** The bottom dock's height: fixed, like the mockup's default `dh`. */
export const BOTTOM_H = 320;

const KEY = "agentglass.jira.dock";
type Saved = { mode: "dock" | "float" | "bottom"; at: FloatBox | null };
const SERVER: Saved = { mode: "dock", at: null };
const subs = new Set<() => void>();
let snap: Saved | null = null;
let max = false;

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** What the window kept, read defensively: anything odd is the default. */
export function parseSaved(raw: string | null): Saved {
  try {
    const o = raw ? (JSON.parse(raw) as { mode?: unknown; at?: { x?: unknown; y?: unknown } | null }) : null;
    const at = o?.at && num(o.at.x) && num(o.at.y) ? { x: Math.round(o.at.x), y: Math.round(o.at.y) } : null;
    const mode = o?.mode === "float" ? "float" : o?.mode === "bottom" ? "bottom" : "dock";
    return { mode, at };
  } catch { return { mode: "dock", at: null }; }
}

function saved(): Saved {
  if (snap) return snap;
  let raw: string | null = null;
  try { raw = localStorage.getItem(KEY); } catch { /* blocked storage: the default */ }
  return (snap = parseSaved(raw));
}

function put(next: Saved): void {
  snap = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode: lasts this visit */ }
  subs.forEach((f) => f());
}

/** The window kept inside the screen: all four edges, and the top edge never above the screen. */
export function clampFloat(at: FloatBox, size: { w: number; h: number }, view: { w: number; h: number }): FloatBox {
  const x = Math.max(0, Math.min(at.x, Math.max(0, view.w - size.w)));
  const y = Math.max(0, Math.min(at.y, Math.max(0, view.h - size.h)));
  return { x: Math.round(x), y: Math.round(y) };
}

/** The floating window's size for a screen: 520 wide, two thirds tall, shrunk to fit a narrow screen. */
export function floatSize(view: { w: number; h: number }): { w: number; h: number } {
  return { w: Math.min(FLOAT_W, Math.max(FLOAT_MIN_W, view.w - 16)), h: Math.round((view.h * FLOAT_H_PCT) / 100) };
}

/** Where a floating window opens the first time: at the right, under the top bar. */
export const floatHome = (view: { w: number; h: number }): FloatBox => clampFloat({ x: view.w - FLOAT_W - 16, y: 90 }, floatSize(view), view);

/** Ctrl+Shift+D: dock, float, pop out, bottom, dock. */
export const nextMode = (m: DockMode): DockMode => (m === "dock" ? "float" : m === "float" ? "pop" : m === "pop" ? "bottom" : "dock");

/** What Esc does with the panel: undo the maximize, return a pop-out to where it came from, else close the card. */
export function escStep(mode: DockMode, maximized: boolean): "restore" | "return" | "close" {
  return maximized ? "restore" : mode === "pop" ? "return" : "close";
}

/** Ctrl+Shift+D, and `f` (no modifier) when focus is not in a field. */
export function dockKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "metaKey" | "altKey">): "cycle" | "max" | null {
  if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "d") return "cycle";
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key === "f") return "max";
  return null;
}

export interface DockState {
  mode: DockMode;
  maximized: boolean;
  at: FloatBox | null;
  setMode: (m: DockMode) => void;
  /** Leave the pop-out for the dock or float it came from. */
  back: () => void;
  cycle: () => void;
  toggleMax: () => void;
  setMax: (on: boolean) => void;
  moveTo: (at: FloatBox) => void;
}

const setMode = (m: DockMode): void => {
  max = false;
  if (m === "pop") { setCardMode("modal"); subs.forEach((f) => f()); return; }
  setCardMode("side");
  put({ ...saved(), mode: m });
};

/** The panel's mode, for the window. The pop-out is `jiraCardMode`'s "modal"; the rest is this store's. */
export function useDockState(): DockState {
  const card = useCardMode();
  const s = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, saved, () => SERVER);
  const m = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => max, () => false);
  const mode: DockMode = card === "modal" ? "pop" : s.mode;
  return {
    mode, maximized: m, at: s.at, setMode, back: () => { max = false; setCardMode("side"); subs.forEach((f) => f()); },
    cycle: () => setMode(nextMode(mode)),
    toggleMax: () => { max = !max; subs.forEach((f) => f()); },
    setMax: (on) => { max = on; subs.forEach((f) => f()); },
    moveTo: (at) => put({ ...saved(), at }),
  };
}

/** Test seam: forget what the window kept. */
export function __resetDockMode(): void { snap = null; max = false; subs.forEach((f) => f()); }
