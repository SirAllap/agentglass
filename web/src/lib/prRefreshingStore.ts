// Who is refreshing, for the board to read.
//
// The decision lives in prRefreshing.ts; this is the map and the timer that
// wakes a card at the ceiling so it stops saying "reading" even if GitHub never
// answers. One entry per pull request, by repository, because two repositories
// can hold the same number.
import { REFRESH_CEILING_MS } from "./prRefreshing.ts";

const since = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
let version = 0;

const keyOf = (root: string, n: number) => `${root}::${n}`;
const tell = () => { version++; for (const l of listeners) l(); };

export function onRefreshing(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function refreshingVersion(): number {
  return version;
}

/** When this pull request's update finished, or undefined. */
export function refreshingSince(root: string, n: number): number | undefined {
  return root && n ? since.get(keyOf(root, n)) : undefined;
}

/** An update just finished: say so until the read behind it lands. */
export function markRefreshing(root: string, n: number): number {
  const at = Date.now();
  const key = keyOf(root, n);
  since.set(key, at);
  const old = timers.get(key);
  if (old) clearTimeout(old);
  /* One wake-up at the ceiling, and it takes the marker with it: leaving `since`
     there made every later render ask `refreshPhase` about a read that is not
     coming, so the card said "GitHub has not answered in 45 s" for the rest of
     the session over a read that had since failed, landed, or been merged. */
  timers.set(key, setTimeout(() => { timers.delete(key); if (since.delete(key)) tell(); }, REFRESH_CEILING_MS + 20));
  tell();
  return at;
}

export function clearRefreshing(root: string, n: number): void {
  const key = keyOf(root, n);
  if (!since.delete(key)) return;
  const t = timers.get(key);
  if (t) clearTimeout(t);
  timers.delete(key);
  tell();
}

/** Forget everything — for a test, or a repository that changed under the board. */
export function forgetRefreshing(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  since.clear();
  tell();
}
