/**
 * The finder's outer box, in one place. It is the same box in every state —
 * searching, no results, a folder, a file — because a surface that sizes to
 * its content jumps between keystrokes: a folder of three items was short, one
 * item shorter, an open file tall. It fills the frame the layout gives it (the
 * page minus FINDER_MARGIN on every side) up to FINDER_MAX_WIDTH, and the
 * drawer, the centre and the rail scroll inside it; what is left over stays
 * empty. Ceiling: the width stops growing at FINDER_MAX_WIDTH, set past any
 * single monitor on purpose: at 1800 a 2000px-wide window left 100px of bare
 * page on each side against 20px above and below, and the panel read as
 * off-centre. Wider than that is a multi-monitor span, where the margin
 * matching on all four sides matters less than the cap.
 */
export const FINDER_MARGIN = 20;
export const FINDER_MAX_WIDTH = 3840;

export const FINDER_BOX = {
  width: `min(${FINDER_MAX_WIDTH}px, 100%)`,
  height: "100%",
} as const;
