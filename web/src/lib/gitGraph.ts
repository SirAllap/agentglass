/*
 * The commit graph, as lanes and edges — not as `| | * | \ \`.
 *
 * `git log --graph` draws its own picture in ASCII, and the Log tab was
 * printing that picture as text in a monospace column. On a repository with
 * twenty-seven live branches it is forty characters wide before the commit
 * subject starts, so every message read `fix(pr-revi…` and the tab looked, in
 * the author's words, like it broke on the way down.
 *
 * The shape is not in the drawing, though — it is in the PARENTS, which git will
 * hand over for a fraction of the cost of `--graph`'s topological walk. So the
 * server sends those and this turns them into something a browser can draw:
 * which column each commit's dot sits in, and which lines pass through the row
 * on their way somewhere else.
 *
 * Pure, and tested next door: the whole of the difficulty here is bookkeeping
 * (a merge frees a lane, a fork claims one, and the row in between has to be
 * drawn with the lanes it had at the TOP and the lanes it has at the BOTTOM),
 * and none of that needs a DOM to be got wrong.
 */

/** One segment crossing a row, from a lane at the top edge to one at the
 *  bottom. A straight line has `from === to`; a merge or a fork does not. */
export interface GraphLink {
  from: number;
  to: number;
  /** Which lane's colour it carries. A line keeps its colour across a bend, so
   *  a branch is one colour from its tip to where it was cut. */
  lane: number;
}

export interface GraphRow {
  hash: string;
  /** The column the commit's dot sits in. */
  dot: number;
  /** True when it has more than one parent — drawn hollow, because a merge is
   *  the one commit whose content is not its own. */
  merge: boolean;
  links: GraphLink[];
  /** Lanes in use across this row, top or bottom, so the column can be sized to
   *  the widest row on screen rather than to the widest in the repository. */
  width: number;
}

/**
 * Lay out the commits.
 *
 * One pass, in the order git gave them (newest first), holding a list of OPEN
 * lanes — each one waiting for a particular commit to appear. When it does, that
 * lane is where its dot goes; the lane then moves on to wait for the commit's
 * first parent, and any further parents (a merge) either join a lane that is
 * already waiting for them or claim a free one.
 *
 * The subtlety is that a lane can be freed and reused inside the same row, so
 * the drawing needs BOTH states: `before` for where a line enters the row and
 * `after` for where it leaves. Reusing one array for both is what turns a merge
 * into a line that appears to come from nowhere.
 */
export function layoutGraph(commits: { hash: string; parents: string[] }[]): GraphRow[] {
  // Lane n is waiting for this hash. `null` is a free lane, kept rather than
  // compacted: compacting would shuffle every line sideways on every merge,
  // which reads as the whole graph twitching.
  let lanes: (string | null)[] = [];
  /** The lane a colour belongs to, so a line keeps its colour across a bend. */
  const colourOf = new Map<number, number>();
  let nextColour = 0;

  const rows: GraphRow[] = [];

  for (const c of commits) {
    const before = lanes.slice();
    let dot = before.indexOf(c.hash);
    if (dot === -1) {
      // A tip: nothing was waiting for it. Take the first free lane so a
      // finished branch's column is reused rather than the graph growing
      // forever to the right.
      dot = before.indexOf(null);
      if (dot === -1) { dot = before.length; before.push(c.hash); }
      else before[dot] = c.hash;
      colourOf.set(dot, nextColour++);
    }

    const after = before.slice();
    const [first, ...rest] = c.parents;

    // The lane this commit was in now waits for its first parent — unless some
    // other lane is already waiting for that parent, in which case the two lines
    // join and this lane closes.
    if (!first) {
      after[dot] = null;                       // a root commit: the line ends
    } else {
      const joined = after.findIndex((h, i) => h === first && i !== dot);
      after[dot] = joined === -1 ? first : null;
    }

    for (const p of rest) {
      const existing = after.indexOf(p);
      if (existing !== -1) continue;           // already tracked: the merge line bends into it
      let slot = after.indexOf(null);
      if (slot === -1) { slot = after.length; after.push(p); }
      else after[slot] = p;
      colourOf.set(slot, nextColour++);
    }

    /* Every line crossing this row, drawn from where it entered to where it
       leaves. Built from the two states rather than from the commit, because a
       row is mostly OTHER branches passing by — on this repository, thirty of
       them for every one that has a dot in the row. */
    const links: GraphLink[] = [];
    const push = (from: number, to: number, lane: number) => links.push({ from, to, lane: colourOf.get(lane) ?? lane });

    before.forEach((h, i) => {
      if (h === null || i === dot) return;
      const to = after.indexOf(h);
      if (to !== -1) push(i, to, i);
    });

    if (first) {
      const to = after.indexOf(first);
      if (to !== -1) push(dot, to, dot);
    }
    for (const p of rest) {
      const to = after.indexOf(p);
      if (to !== -1) push(dot, to, to);
    }

    rows.push({ hash: c.hash, dot, merge: c.parents.length > 1, links, width: Math.max(before.length, after.length) });
    lanes = after;
  }

  return rows;
}

/**
 * The colours a lane can take.
 *
 * Six, from the app's own tokens rather than a rainbow: the graph is a diagram
 * beside text, not the subject of the screen, and eight saturated hues next to a
 * commit message is a Christmas tree. They repeat past six, which is honest —
 * the colour tells two ADJACENT lines apart, and nothing more.
 */
export const LANE_COLOURS = [
  "var(--primary)",
  "var(--info)",
  "var(--success)",
  "var(--warning)",
  "var(--error)",
  "var(--text3)",
] as const;

export const laneColour = (lane: number): string => LANE_COLOURS[lane % LANE_COLOURS.length]!;

/**
 * How wide the graph column is, in pixels, for the rows currently on screen.
 *
 * Capped, and the cap is the point: this repository has periods where forty
 * lanes are open at once, and forty lanes is not a diagram anybody reads — it is
 * the wall of pipes this replaces. Past the cap the extra lanes are drawn
 * clipped at the edge, which says "there is more going on here" without letting
 * it eat the commit message.
 */
export const LANE_W = 11;
export const MAX_LANES = 8;

export function graphWidth(rows: GraphRow[]): number {
  const lanes = Math.min(MAX_LANES, rows.reduce((n, r) => Math.max(n, r.width), 1));
  return lanes * LANE_W + LANE_W;
}


/* ── drawing ──────────────────────────────────────────────────────────────── */

/**
 * The height the graph is drawn in, before it is stretched.
 *
 * Arbitrary on purpose: the row's real height is decided by its own content and
 * by the app's UI scale, so the SVG is scaled to fill it (`preserveAspectRatio`
 * of `none`). What matters is not the number — it is that every path starts at 0
 * and ends at it, so one row's lines meet the next row's exactly.
 */
export const GRAPH_H = 100;

/** Where a lane sits, horizontally. */
export const laneX = (lane: number): number => lane * LANE_W + LANE_W / 2;

/**
 * One link, as an SVG path.
 *
 * A straight line is a `V`, and a bend is a cubic whose control points sit just
 * either side of the middle — a right angle is what the ASCII already looked
 * like, and a branch should look like it leaves and comes back.
 *
 * `cap` clamps a lane to the last drawn column: past it the line is pinned to
 * the edge, which says "there is more going on here" without letting forty
 * branches eat the commit message.
 */
export function linkPath(link: GraphLink, cap: number): string {
  const x1 = laneX(Math.min(link.from, cap));
  const x2 = laneX(Math.min(link.to, cap));
  return x1 === x2
    ? `M${x1} 0 V${GRAPH_H}`
    : `M${x1} 0 C${x1} ${GRAPH_H * 0.45} ${x2} ${GRAPH_H * 0.55} ${x2} ${GRAPH_H}`;
}
