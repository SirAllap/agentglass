/**
 * A memo that only holds while the view is hidden.
 *
 * Every visited view stays mounted, so the app's ten-second tick re-renders all
 * of them — including the seven nobody can see. A plain `React.memo` would stop
 * that, and it would also stop the ACTIVE view, whose props are equal on that
 * same tick: what the tick exists for is state that moves without new props
 * (a status demoting to idle, "running Bash · 4m" advancing), so freezing the
 * view on screen would be a bug dressed as an optimisation.
 *
 * So the comparator bails only when the view is hidden on both sides of the
 * comparison. Active in either direction — including the switch itself — falls
 * through to a real render.
 */
export function hiddenOnly<P extends { active: boolean }>(prev: P, next: P): boolean {
  if (prev.active || next.active) return false;
  const keys = Object.keys(next) as (keyof P)[];
  if (keys.length !== Object.keys(prev).length) return false;
  return keys.every((k) => Object.is(prev[k], next[k]));
}
