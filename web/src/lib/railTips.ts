/**
 * Extra words a rail button's tooltip carries, keyed by view id ("Docker · 3 running").
 *
 * One store for all views so the rail makes one subscription instead of a hook
 * per button. get() returns one snapshot object, replaced only when a text
 * changes: useSyncExternalStore compares by identity, and a fresh object per
 * call loops the render (same rule as loadRail in views.ts).
 */
export type RailTips = Readonly<Record<string, string>>;

let snap: RailTips = {};
const listeners = new Set<() => void>();

export const getRailTips = (): RailTips => snap;

export function subscribeRailTips(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** null removes the tip. Nothing is notified when the text did not change. */
export function setRailTip(id: string, text: string | null): void {
  if ((snap[id] ?? null) === text) return;
  const next = { ...snap };
  if (text === null) delete next[id]; else next[id] = text;
  snap = next;
  listeners.forEach((f) => f());
}
