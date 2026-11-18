/*
 * What a change of panes moves, and nothing more.
 *
 * The mount effect used to run again on every focus change as well as every
 * tab change, and each run took every holder out of the DOM, parked its
 * renderer, put it back and refitted it: a blank or stale canvas for a frame,
 * then a repaint, then a refit. A holder whose slot and shell did not change
 * is left alone.
 */
export type PaneMountPlan = { keep: string[]; leave: string[]; enter: string[] };

/** `prev` and `next` list the shell id in each slot, in slot order. */
export function planPaneMount(prev: readonly string[], next: readonly string[]): PaneMountPlan {
  const keep: string[] = [];
  const enter: string[] = [];
  next.forEach((id, i) => (prev[i] === id ? keep : enter).push(id));
  const leave = prev.filter((id, i) => next[i] !== id);
  return { keep, leave, enter };
}

/** Holder DOM operations a run of the mount effect performs for this change. */
export function mountOps(plan: PaneMountPlan): number {
  return plan.leave.length + plan.enter.length;
}
