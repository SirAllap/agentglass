// Switch, select, stepper: apply at once, then offer Undo for 6 s.
// Undo goes back through the SAME setter, so whatever the setter does on
// the way in (write the store, tell open panes) it does on the way out.
import { useCallback, useRef } from "react";
import { pushSaveToast } from "./saveToasts.ts";

export type InstantOpts = {
  /** Toast text, default "Saved". E.g. "Saved · applied to open panes". */
  message?: string;
  /** A row read only at start: the toast says so. */
  restartOnly?: boolean;
};

export const RESTART_MESSAGE = "Saved · takes effect after a restart";

/** Pure core: the hook is this plus a ref for the current value. */
export function instantSave<T>(
  old: T,
  next: T,
  set: (v: T) => void,
  opts: InstantOpts = {},
): void {
  if (Object.is(old, next)) return;
  set(next);
  pushSaveToast(opts.message ?? (opts.restartOnly ? RESTART_MESSAGE : "Saved"), () => set(old));
}

export function useInstantSave<T>(value: T, set: (v: T) => void, opts: InstantOpts = {}): (next: T) => void {
  const latest = useRef({ value, set, opts });
  latest.current = { value, set, opts };
  return useCallback((next: T) => {
    const { value: v, set: s, opts: o } = latest.current;
    instantSave(v, next, s, o);
  }, []);
}

/** A list save: onSave gets the value it replaces, and Undo gets the pair reversed, so neither closes over a stale value. */
export function listSave(value: string, to: string, onSave: (next: string, before: string) => void, opts?: InstantOpts): void {
  instantSave(value, to, (v) => onSave(v, v === to ? value : to), opts);
}
