// The one way to draw "close this".
//
// It was a `✕` character in a `<button>` — usually `text-[18px]`, sometimes
// `text-[11px]`, `text-[14px]`, `text-[15px]`, `text-[16px]`, and in
// twenty-five places nothing at all, which meant it inherited whatever the
// container happened to set. Eight different sizes for one control.
//
// The size was only half of it. U+2715 draws a glyph noticeably smaller than
// its em box, so a `✕` at 11px puts about 7px of ink on screen — a control that
// measures as small as it looks, and looks nothing like the stroked SVGs it
// sits beside in the same toolbar. And `px-2` gave it no height of its own: the
// target was the line box, around 15px tall, which is a thing you miss.
//
// So: a real glyph on the same 24-box grid and the same stroke as the workspace
// icons, at ICON.md, inside a square that is actually clickable.
import { ICON, HIT } from "../lib/iconSize.ts";

/** Shared with components/workspace/icons.tsx so the ✕ is visibly one of the
 *  same family — same grid, same stroke, same caps. */
const svg = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/**
 * The glyph on its own, for the places that already have a button.
 *
 * Several close controls live inside a wrapper that carries the styling and
 * behaviour — `Tool` in the browser, `IconBtn` in the machine panel,
 * `agx-note-btn` in the notes. Those want the mark and not a second button
 * around it.
 *
 * Inset to 6.5/17.5 rather than drawn corner to corner: a stroked X that
 * reaches the edges of its box reads as bigger than the other glyphs at the
 * same nominal size, because theirs are shapes with margins and this one is
 * two diagonals.
 */
export function CloseIcon({ size = ICON.md }: { size?: number }) {
  return (
    <svg {...svg} width={size} height={size} aria-hidden focusable="false">
      <path d="M6.5 6.5l11 11" />
      <path d="M17.5 6.5l-11 11" />
    </svg>
  );
}

type Props = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  /** The glyph. The box does not shrink with it — see `hit`. */
  size?: number;
  /** The square target, px. Drops to a row's height where a header has none to
   *  spare; never below the glyph plus its padding. */
  hit?: number;
};

/**
 * A close button: the glyph, centred, in a square you can hit.
 *
 * `title` doubles as the accessible name because the button has no text, and a
 * control whose only content is an `aria-hidden` SVG is unnameable otherwise —
 * it was announced as "button" everywhere it appeared.
 */
export function CloseButton({
  size = ICON.md,
  hit = HIT,
  title = "Close",
  className = "",
  style,
  ...rest
}: Props) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={`grid place-items-center shrink-0 rounded-lg t-dim2 hover:opacity-70 ${className}`}
      style={{ width: hit, height: hit, ...style }}
      {...rest}
    >
      <CloseIcon size={size} />
    </button>
  );
}
