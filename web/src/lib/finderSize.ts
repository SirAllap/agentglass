/**
 * The finder's outer box, in one place. It is the same box in every state —
 * searching, no results, a folder, a file — because a surface that sizes to
 * its content jumps between keystrokes: a folder of three items was short, one
 * item shorter, an open file tall. It fills the frame the layout gives it (the
 * page minus FINDER_MARGIN on every side) up to FINDER_MAX_WIDTH, and the
 * drawer, the centre and the rail scroll inside it; what is left over stays
 * empty. Ceiling: the width stops growing at FINDER_MAX_WIDTH on very wide
 * screens, a line length that stays readable.
 */
export const FINDER_MARGIN = 20;
export const FINDER_MAX_WIDTH = 1800;

export const FINDER_BOX = {
  width: `min(${FINDER_MAX_WIDTH}px, 100%)`,
  height: "100%",
} as const;
