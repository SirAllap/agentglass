// Which card an elbow starts at and which it ends at, on one lane.
//
// The gutter rail joins stack neighbours that stand one right under the other.
// A card whose parent is somewhere else in the lane (below a sister, or two
// cards up) gets no line there, and reads as the child of whatever is above it.
// The elbow is that missing line: it leaves the child's left edge and ends at
// the true parent. It is drawn only for an open parent that is in this lane and
// that the rail does not already join; across lanes the "on #A" chip speaks.
export interface Elbow {
  /** The card that hangs on the parent (where the elbow starts). */
  from: number;
  /** The true parent (where it ends). */
  to: number;
  /** Position of each in the lane, for the drawing and for ordering the gutter. */
  fromIndex: number;
  toIndex: number;
  /** Cards the line passes: the more there are, the further out the gutter it runs. */
  span: number;
}

/** The gutter is 28px and a column is 6px: the fifth would be drawn outside it and clipped. */
export const MAX_ELBOW_COLS = 4;

/** `hidden` cards draw no card (a slip stands there), so they neither start nor end an elbow. */
export function elbowsOf(
  fullLane: readonly number[], parentOf: (n: number) => number | null | undefined, railTo: (n: number) => number | null | undefined,
  hidden?: (n: number) => boolean,
): Elbow[] {
  const lane = hidden ? fullLane.filter((n) => !hidden(n)) : fullLane;
  const at = new Map(lane.map((n, i) => [n, i] as const));
  const out: Elbow[] = [];
  lane.forEach((n, fromIndex) => {
    const to = parentOf(n);
    if (to == null || to === n) return;
    const toIndex = at.get(to);
    if (toIndex === undefined || railTo(n) === to) return;
    out.push({ from: n, to, fromIndex, toIndex, span: Math.abs(fromIndex - toIndex) - 1 });
  });
  return out;
}

/** Gutter column of an elbow, 0 the closest to the cards; longer ones step out so two never run on one line.
 *  Capped at MAX_ELBOW_COLS - 1: past that, elbows share the outermost column rather than leave the gutter. */
export function elbowLanes(elbows: readonly Elbow[]): Map<number, number> {
  const out = new Map<number, number>();
  const taken: { lo: number; hi: number; col: number }[] = [];
  [...elbows].sort((a, b) => a.span - b.span || a.from - b.from).forEach((e) => {
    const lo = Math.min(e.fromIndex, e.toIndex), hi = Math.max(e.fromIndex, e.toIndex);
    let col = 0;
    while (taken.some((t) => t.col === col && t.lo <= hi && lo <= t.hi)) col++;
    col = Math.min(col, MAX_ELBOW_COLS - 1);
    taken.push({ lo, hi, col });
    out.set(e.from, col);
  });
  return out;
}
