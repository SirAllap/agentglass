/*
 * The same content keeps the same object.
 *
 * A value derived in the root (a list built with `map`, an object literal) is
 * a new object on every render even when nothing in it changed, and a new
 * object is what makes a memoised child render again. These are the compares
 * for the shapes the top bar is given, and the one hook that applies them.
 *
 * Ceiling: one level deep. A field that is itself an object or an array is
 * compared by identity, which is right for the shapes here (strings, numbers,
 * booleans, null) and wrong for anything nested: a nested shape needs its own
 * compare, not this one.
 */
import { useRef } from "react";
import { sameFields } from "./dashFeed.ts";

/** Both null, or the same fields with the same values. */
export function sameOrBothNull<T extends object>(a: T | null, b: T | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return sameFields(a, b);
}

/** The same rows in the same order, each compared field by field. */
export function sameRows<T extends object>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((row, i) => sameFields(row, b[i]!));
}

/** The same strings in the same order. */
export function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

/** `prev` when `same` says nothing changed, else `next`. */
export function kept<T>(prev: T, next: T, same: (a: T, b: T) => boolean): T {
  return prev === next || same(prev, next) ? prev : next;
}

/** A value whose identity changes only when its content does. */
export function useKept<T>(value: T, same: (a: T, b: T) => boolean): T {
  const ref = useRef(value);
  ref.current = kept(ref.current, value, same);
  return ref.current;
}
