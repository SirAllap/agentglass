import type { GraphRow } from "./gitGraph.ts";

/** Lanes drawn; the rest of a row's lanes collapse into a "+N" tick. */
export const MINI_LANES = 3;

export interface MiniRow {
  /** Links whose both ends are inside the drawn lanes, or that reach the edge. */
  links: { from: number; to: number; lane: number; toEdge: boolean; hiddenEnd?: "from" | "to" }[];
  /** The dot's lane, pinned to the last drawn one when it sits in a hidden lane. */
  dot: number;
  /** Hidden lanes the row's own commit is joined to. */
  hidden: number;
}

/**
 * Lanes by first-seen order from the left: lane index IS that order, since the
 * layout hands out the lowest free lane. An edge into a hidden lane ends at the
 * last drawn lane's edge with a dot (`toEdge`, `hiddenEnd` says which end); a
 * line wholly in hidden lanes is dropped. "+N" counts the distinct hidden lanes
 * the row's own commit joins (its dot, a merge parent, a fork). Hidden lanes
 * merely passing through are not counted: under a merge every row has some, and
 * a tick on every row says nothing.
 */
export function miniRow(row: GraphRow, lanes = MINI_LANES): MiniRow {
  const edge = lanes - 1;
  const hiddenSet = new Set<number>();
  const links: MiniRow["links"] = [];
  if (row.dot > edge) hiddenSet.add(row.dot);
  for (const l of row.links) {
    if (l.from === row.dot || l.to === row.dot) {
      if (l.from > edge) hiddenSet.add(l.from);
      if (l.to > edge) hiddenSet.add(l.to);
    }
    if (l.from > edge && l.to > edge) continue;
    const hiddenEnd = l.from > edge ? "from" as const : l.to > edge ? "to" as const : undefined;
    links.push({ from: Math.min(l.from, edge), to: Math.min(l.to, edge), lane: l.lane, toEdge: !!hiddenEnd, ...(hiddenEnd ? { hiddenEnd } : {}) });
  }
  return { links, dot: Math.min(row.dot, edge), hidden: hiddenSet.size };
}
