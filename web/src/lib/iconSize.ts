// The icon ladder.
//
// An audit of every icon in the cockpit found 61 vector sites spread across
// fourteen different sizes — 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 26,
// 46 — with no rule saying which belonged where. Eleven of them were under
// 14px. Sizes chosen one at a time, each reasonable beside the thing it sat
// next to and none of them agreeing with the others, which is what a toolbar
// looks like when its glyphs were never a set.
//
// Five rungs, picked against the type they actually sit beside rather than in
// the abstract: this UI sets 384 strings at 11px and 345 at 10px, so an icon is
// legible at roughly 1.4-1.6x its neighbouring text and starts to dominate the
// row past that. `md` is the default and the one to reach for; the others exist
// because a chip and a page header are not the same object.
//
// Deliberately numbers, not classes. Icons take a `size` prop and render an
// <svg width height>, which Tailwind cannot set — a `text-[16px]` on an SVG
// styles nothing.
export const ICON = {
  /** 12 — inside a chip or a badge, beside 9-10px type. The floor: below this
   *  a stroked glyph stops resolving into a shape at 1x. */
  xs: 12,
  /** 14 — inline with body text, for an affordance that should not lead. */
  sm: 14,
  /** 16 — THE DEFAULT. Rail, toolbars, panel headers, close buttons. */
  md: 16,
  /** 18 — a primary action, or an icon carrying a row on its own. */
  lg: 18,
  /** 22 — the logo, an avatar, the glyph in an empty state. */
  xl: 22,
  /**
   * 26 — the workspace rail, and only it.
   *
   * The rail is the one place where the glyph IS the control: no label beside
   * it, no box behind it since the tinted panel came off, and a strip of them
   * to tell apart at a glance from the far side of the screen. It is also the
   * one place with a width to be sized against rather than a line of type —
   * VS Code draws 24 in a 48px rail, and this is the same half of a 52px one.
   *
   * Its own rung rather than a bigger `xl`, because xl is measured against an
   * empty state's prose and would grow every logo and avatar with it.
   */
  rail: 26,
} as const;

export type IconSize = (typeof ICON)[keyof typeof ICON];

/**
 * The smallest square that is still comfortably clickable, in px.
 *
 * Separate from the glyph size on purpose: the close buttons were `px-2` around
 * a text glyph, which made the target as tall as the line box — around 15px,
 * under half the 44px the WCAG target-size guidance asks for and small enough
 * to miss on a trackpad. The glyph got bigger AND the box got its own size,
 * because growing the glyph alone would have left the same thin target.
 *
 * 26 rather than 44: this is a dense desk UI whose rows are 22-28px tall, and a
 * 44px target would not fit a panel header without reflowing it. It is the
 * largest square the layout has room for, which is the honest trade.
 */
export const HIT = 26;

/**
 * The smallest square a control may be squeezed into, when `HIT` will not fit.
 *
 * This number existed already and lived somewhere nothing could find it:
 * `FileRail.tsx` declared `const JUMP_BOX = 20` with fifteen lines justifying
 * it, and this file — the one that owns the question — had never heard of it.
 * Two floors, two files, neither aware of the other, and an audit that read one
 * of them produced findings the other file argues against.
 *
 * The reasoning is the rail's, kept because it is measured: `HIT` is 26 and
 * "drops to a row's height where a header has none to spare; never below the
 * glyph plus its padding". A 9.5px meta line four rows deep in a 320px column
 * is exactly that case — a 26px square would make the line taller than the
 * quote it belongs to. 20 clears a 14px glyph with room either side.
 *
 * So: `HIT` first, `MIN_BOX` where the layout genuinely cannot carry it, and
 * nothing below that. A glyph may be `ICON.xs`; the square it lives in may not
 * shrink to match.
 */
export const MIN_BOX = 20;
