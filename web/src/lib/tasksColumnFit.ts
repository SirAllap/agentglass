/*
 * How wide the ClickUp table's PR and Who tracks need to be, decided once per
 * change of the data and drawn as plain pixels.
 *
 * Measured, in a headless browser on a board of 400 cards over eight statuses:
 * tracks of `minmax(floor,max-content)` with every row a subgrid laid the page
 * out in 790 ms against 102 ms for the same board with fixed tracks (128 cards:
 * 155 ms against 92 ms), and re-laid it out in 15 ms instead of 2 on a resize.
 * A subgrid takes part in its parent's track sizing, so each row's cells have to
 * be measured, and a subgrid cannot be size-contained, which is what lets
 * `.agx-row`'s `content-visibility: auto` skip the rows that are off screen.
 *
 * So the rows are grids of their own again, with the SAME template as the
 * heading, and the one number the fit needs is worked out here from what the
 * cells will hold. The heading and the rows read one string, so they cannot
 * disagree about where a column is.
 *
 * Ceiling: the width is an estimate from character counts and two measured
 * digit advances, not a layout. It carries a pixel of slack per cell, never
 * shrinks below the floor the cell was drawn for, and stops at `CELL_MAX_W`
 * (the chip ellipsises past it). A chip drawn with a different font than the two
 * probes measure would be a few pixels off; the floor and the cap keep that from
 * moving anything else.
 */
import type { CardPrPick } from "./cardPrPick.ts";
import { isRelated, restCounts } from "./cardPrPick.ts";

/** The most a PR or Who cell may ask for. */
export const CELL_MAX_W = 168;
/** What the PR and Who tracks were drawn for before they fitted anything. */
export const PR_FLOOR = 92;
export const WHO_FLOOR = 50;

/** Width of one digit, in px, in the two faces the cells draw numbers in. */
export interface DigitMetrics {
  /** The chip's `#12345`: 10.5px mono. */
  mono: number;
  /** The chip's `+N` and the Who count: 9.5px sans. */
  sans: number;
}

/* House sizes the cells are drawn at: px-1.5 + 1px border on both sides, the
   12px glyph (ICON.xs) and the 4px gap (gap-1) of CardPrChip; the 18px faces
   with their -5px overlap of Face in TasksPanel. */
const CHIP_CHROME = 2 + 12 + 12 + 4;
const GLYPH = 12;
const GAP = 4;
const FACE = 18;
const FACE_OVERLAP = 5;
const FACES_SHOWN = 3;

const digits = (n: number): number => String(Math.max(0, Math.trunc(n))).length;

/** The widest the chip for this pick can be, in px. 0 when there is no chip. */
export function prChipWidth(pick: CardPrPick, m: DigitMetrics): number {
  if (pick.kind === "none") return 0;
  const shown = pick.kind === "one" ? pick.pr : pick.primary;
  const rest = pick.kind === "many" ? pick.rest : [];
  const rc = restCounts(rest);
  const relatedChip = isRelated(shown);
  const plusN = relatedChip ? rest.length : rc.own;
  const plusRelated = relatedChip ? 0 : rc.related;
  let w = CHIP_CHROME + (1 + digits(shown.number)) * m.mono;
  // "+N": the plus sign is as wide as a digit in these faces, near enough.
  if (plusN > 0) w += GAP + (1 + digits(plusN)) * m.sans;
  if (plusRelated > 0) w += GAP + GLYPH + 2 + digits(plusRelated) * m.sans;
  return Math.ceil(w) + 1;
}

/** The widest a row of `people` faces can be, in px. 0 when nobody is on it. */
export function whoCellWidth(people: number, m: DigitMetrics): number {
  if (people <= 0) return 0;
  const faces = Math.min(people, FACES_SHOWN);
  let w = FACE * faces - FACE_OVERLAP * (faces - 1);
  // 8.5px sans, against the 9.5px the chip counts are probed at.
  if (people > FACES_SHOWN) w += GAP + (1 + digits(people - FACES_SHOWN)) * m.sans * (8.5 / 9.5);
  return Math.ceil(w) + 1;
}

/** A track: the floor it was drawn for, grown to what the widest cell needs,
 *  and no further than the cap. */
export function trackPx(floor: number, needed: number): number {
  return Math.max(floor, Math.min(CELL_MAX_W, Math.ceil(needed)));
}

let probed: DigitMetrics | null = null;
const FALLBACK: DigitMetrics = { mono: 6.4, sans: 5.6 };

/**
 * The two digit advances, read off the page once the fonts are in. A probe
 * that ran before the web fonts loaded would measure the fallback face, so it
 * is not kept until `document.fonts` says it is done.
 */
export function digitMetrics(): DigitMetrics {
  if (probed) return probed;
  if (typeof document === "undefined" || !document.body) return FALLBACK;
  const one = (cls: string, px: number): number => {
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = "0000000000";
    el.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font-size:${px}px;left:-9999px;top:0`;
    document.body.appendChild(el);
    const w = el.getBoundingClientRect().width / 10;
    el.remove();
    return w > 0 ? w : 0;
  };
  const m = { mono: one("font-mono tabular-nums", 10.5), sans: one("tabular-nums", 9.5) };
  if (!m.mono || !m.sans) return FALLBACK;
  if (document.fonts?.status === "loaded") probed = m;
  return m;
}

/** Forget the probe, for the one moment it can change: the fonts arriving. */
export function forgetDigitMetrics(): void { probed = null; }
