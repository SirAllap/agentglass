/*
 * A per-key store held in memory for as long as the app is, and read by every
 * screen that names the same key — what lets a tick made in a diff show up in
 * the list behind it. Not saved: what it holds is stale within a week.
 */
import { useCallback, useEffect, useState } from "react";

export function memoryStore<T>(empty: T, next: (current: T, item: string) => T): (key: string) => [T, (item: string) => void] {
  const held = new Map<string, T>();
  const listeners = new Set<() => void>();
  return function useMemoryStore(key: string): [T, (item: string) => void] {
    const [, bump] = useState(0);
    useEffect(() => {
      const fn = (): void => bump((n) => n + 1);
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    }, []);
    const update = useCallback((item: string): void => {
      held.set(key, next(held.get(key) ?? empty, item));
      for (const fn of listeners) fn();
    }, [key]);
    return [held.get(key) ?? empty, update];
  };
}
