/*
 * EIGHT WEEKS AS EIGHT BARS.
 *
 * `weekly` is what a project's rule list learned per week, oldest first, this
 * week last (shared/agentRules.ts). The strip draws how many rules the project
 * HAD at the end of each week: a grey block of the base rules every project
 * has, and on it the learned ones, the newest week marked. Growth over time is
 * a thing you see, so the scale is one fixed number of pixels per rule (the
 * design's three) and only shrinks when the busiest bar would not fit.
 *
 * What a week held is worked back from today's list: the learned rules now,
 * less what was learned after that week. A rule since removed is not in that
 * count, so an old bar reads as low as the rules still standing; the strip is
 * the growth of what is here, not an audit of what was.
 *
 * Fewer than eight weeks are padded on the left with the base alone: a project
 * a fortnight old has a short history, not a short strip.
 */
export interface WeekBar {
  /** Rules in force at the end of that week, base included: the bar's tooltip. */
  total: number;
  /** Pixels of the grey base block. */
  basePx: number;
  /** Pixels of the learned block on top; zero stays zero. */
  learnedPx: number;
  /** The bar for the current week. */
  current: boolean;
}

export const WEEKS = 8;
/** The design's scale: three pixels a rule, until the tallest bar would pass the strip. */
export const PX_PER_RULE = 3;

export function growthBars(weekly: readonly number[], base: number, learned: number, height = 64, weeks = WEEKS): WeekBar[] {
  const clean = weekly.map((n) => (Number.isFinite(n) && n > 0 ? n : 0)).slice(-weeks);
  const padded = [...Array.from({ length: weeks - clean.length }, () => 0), ...clean];
  const baseN = Math.max(0, base), learnedN = Math.max(0, learned);
  const scale = Math.min(PX_PER_RULE, height / Math.max(1, baseN + learnedN));
  return padded.map((_, i) => {
    const after = padded.slice(i + 1).reduce((a, b) => a + b, 0);
    const had = Math.max(0, learnedN - after);
    return { total: baseN + had, basePx: Math.round(baseN * scale), learnedPx: had === 0 ? 0 : Math.max(1, Math.round(had * scale)), current: i === weeks - 1 };
  });
}
