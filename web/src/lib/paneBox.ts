/*
 * Where a tmux pane is, in pixels.
 *
 * tmux panes are not elements. They are rectangles of CHARACTER CELLS painted
 * into one xterm canvas, so anything this app wants to draw on a pane — the bar
 * that opens its git, its diff, its pull request and its card — has to be
 * placed by arithmetic rather than by layout.
 *
 * The arithmetic is small and every part of it has already been wrong once in
 * this app, which is why it is here rather than inline: the screen element is
 * not the container (a container is usually a few pixels taller than a whole
 * number of rows, and dividing by the wrong height puts the box a row out at
 * the bottom of a tall pane — see cellAt, which learned the same lesson), and a
 * pane's `right`/`bottom` are the LAST cell it owns, not the first cell after
 * it.
 *
 * No DOM in here on purpose: the callers hand over two rects they measured, and
 * the awkward cases — a single pane, a zoomed pane, a pane too narrow to draw
 * on — are checkable without a browser.
 */

/** A rectangle, in whatever space the caller is working in. */
export interface Rect { left: number; top: number; width: number; height: number }

/** The cells of a tmux pane, as tmux reports them: inclusive on both ends. */
export interface PaneCells { left: number; top: number; right: number; bottom: number }

/**
 * The foot of a pane: where its bottom edge is, and how wide it is.
 *
 * The corner arithmetic above placed a block; this places a bar. Same two
 * traps — the screen is not the container, and `bottom` is the LAST cell the
 * pane owns rather than the first one after it — and the same clamp, because a
 * pane narrower than the bar must not push it out over its neighbour.
 *
 * `top` is the pane's bottom edge, not the bar's top: the caller draws upwards
 * from it, which is the direction the bar comes from.
 */
export function paneFoot(o: { screen: Rect; slot: Rect; cols: number; rows: number; pane: PaneCells | null; edge?: number }): { left: number; top: number; width: number; atRight: boolean } {
  const cellW = o.cols > 0 ? o.screen.width / o.cols : 0;
  const cellH = o.rows > 0 ? o.screen.height / o.rows : 0;
  const dx = o.screen.left - o.slot.left;
  const dy = o.screen.top - o.slot.top;
  const left = o.pane ? dx + o.pane.left * cellW : dx;
  const width = o.pane ? (o.pane.right - o.pane.left + 1) * cellW : o.screen.width;
  const bottom = o.pane ? dy + (o.pane.bottom + 1) * cellH : dy + o.screen.height;
  /* And when the pane reaches the terminal's own bottom, hang from the SLOT's
     edge rather than the screen's.
     The two are not the same line and the difference is exactly the space this
     feature needs: xterm can only draw whole rows, so the slot is usually a few
     pixels taller than a whole number of them, and in a split the grid adds its
     own padding underneath. Measured against the screen, a seam sits on the
     last row's descenders — reported twice, with a screenshot each time, the
     second one pointing at the empty strip below the line: "look, you have
     room to put the bar without it sitting on top of the text". That strip is
     this difference. */
  const atBottom = !o.pane || (o.pane.bottom + 1) * cellH >= o.screen.height - 1;
  /* `edge` is THIS pane's own bottom, in the same space as everything else
     here. It is not `slot.height`: the slot is the whole grid, so on the top
     half of a split that would drop the bar through the pane below it. */
  const edge = o.edge ?? o.slot.height;
  const foot = atBottom ? Math.max(bottom, Math.min(edge, o.slot.height)) : bottom;
  return {
    left: Math.round(Math.max(left, 0)),
    top: Math.round(Math.min(Math.max(foot, 0), o.slot.height)),
    width: Math.round(Math.min(width, o.slot.width)),
    /* The bench button sits in the slot's bottom-right corner, so only the pane
       whose foot touches BOTH the right edge and the slot bottom makes room.
       xterm leaves up to one cell of slack right of its grid, plus the slot's
       padding (dx), so the tolerance grows with the font. */
    atRight: touchesRightEdge({ left, width }, o.slot.width, Math.max(16, cellW + dx)) && Math.min(Math.max(foot, 0), o.slot.height) >= o.slot.height - Math.max(16, cellH + dy),
  };
}

/** Does a pane's foot reach the container's right edge? Only that pane sits under the bench button.
 *  `tol` forgives the part-cell gap xterm leaves at the right of its grid. */
export function touchesRightEdge(foot: { left: number; width: number }, containerW: number, tol = 16): boolean {
  return foot.left + foot.width >= containerW - tol;
}

/** Is this pane the one in the terminal's bottom-right corner, where the bench button sits?
 *  Pure cell arithmetic on tmux's inclusive cells, so it needs no measuring and holds on the first paint.
 *  No pane (one pane, zoomed, no tmux) means the whole terminal, which is the corner. */
export function paneAtCorner(pane: PaneCells | null, cols: number, rows: number): boolean {
  return !pane || (pane.right + 1 >= cols && pane.bottom + 1 >= rows);
}
