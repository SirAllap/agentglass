// The one "Saved · Undo" toast. A store, not a component, so any setting can
// raise it and the host (SaveToastHost.tsx) only draws it. One toast at a
// time: a newer save replaces the older one, whose Undo is gone with it
// (it can no longer be what "Undo" means).
import { realClock, UNDO_MS, type Clock } from "./clock.ts";

export type SaveToast = { id: number; message: string; undo: () => void };

let current: SaveToast | null = null;
let nextId = 1;
let timer: unknown = null;
let clock: Clock = realClock;
const subs = new Set<() => void>();

const emit = () => subs.forEach((f) => f());

export const getSaveToast = () => current;
export function subscribeSaveToast(f: () => void): () => void {
  subs.add(f);
  return () => { subs.delete(f); };
}

export function dismissSaveToast(): void {
  if (timer != null) clock.clear(timer);
  timer = null;
  if (current) { current = null; emit(); }
}

/** Show "<message> · Undo" for 6 s. */
export function pushSaveToast(message: string, undo: () => void): void {
  if (timer != null) clock.clear(timer);
  current = { id: nextId++, message, undo };
  const mine = current.id;
  timer = clock.set(() => { if (current?.id === mine) dismissSaveToast(); }, UNDO_MS);
  emit();
}

/** Press Undo: run the stored undo once, then close the toast. */
export function undoSaveToast(): void {
  const t = current;
  if (!t) return;
  dismissSaveToast();
  t.undo();
}

/** Tests only. */
export function _resetSaveToast(c: Clock = realClock): void {
  if (timer != null) clock.clear(timer);
  timer = null; current = null; clock = c; subs.clear();
}
