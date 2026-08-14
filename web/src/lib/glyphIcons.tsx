/*
 * The three shapes that kept being typed instead of drawn.
 *
 * A refresh, a play and a caret appear in six places across this app and every
 * one of them was a CHARACTER — `⟳`, `▶`, `▼` — inside a clickable element.
 * That walks past the icon ladder entirely, because the ladder is about
 * `<svg width={ICON.x}>`: a glyph has no size of its own beyond its font, draws
 * about 60% of the ink its font-size implies, and gives its control no height.
 * The branch list's tick box was the report that found it ("es ENANO, ni se
 * ve") and these are the rest of the family.
 *
 * Deliberately here rather than in `workspace/icons.tsx`: that file is the
 * rail's iconography, which is a set with a common weight and a common
 * silhouette. These are utilities.
 */
import { ICON } from "./iconSize.ts";

type P = { size?: number; className?: string };
const svg = (size: number, className?: string) => ({
  width: size, height: size, viewBox: "0 0 14 14", fill: "none",
  stroke: "currentColor", strokeWidth: 1.6,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  "aria-hidden": true, className,
});

/** Circular arrow. The one that spins while something is in flight. */
export function RefreshIcon({ size = ICON.sm, className }: P) {
  return (
    <svg {...svg(size, className)}>
      <path d="M12 7a5 5 0 1 1-1.6-3.7M12 2.2V4.8H9.4" />
    </svg>
  );
}

/** A filled triangle: start, run, play. Filled because an outline at 14px
 *  reads as a caret rather than as a button that starts something. */
export function PlayIcon({ size = ICON.sm, className }: P) {
  return (
    <svg {...svg(size, className)} fill="currentColor" stroke="none">
      <path d="M4.5 2.8l6.5 4.2-6.5 4.2z" />
    </svg>
  );
}

/** A tick, for "this finished and it went well". */
export function DoneIcon({ size = ICON.sm, className }: P) {
  return (
    <svg {...svg(size, className)} strokeWidth={1.8}>
      <path d="M3 7.4l2.6 2.6L11 4.6" />
    </svg>
  );
}

/** The caret every menu, picker and disclosure in this app points down with.
 *  Rotate it with a transform rather than swapping it for `▲`: one control that
 *  MOVES reads as the same thing in two states. */
export function CaretIcon({ size = ICON.xs, className }: P) {
  return (
    <svg {...svg(size, className)} strokeWidth={1.4}>
      <path d="M3.5 5.5L7 9l3.5-3.5" />
    </svg>
  );
}
