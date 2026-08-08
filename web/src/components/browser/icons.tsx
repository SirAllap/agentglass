/*
 * The browser toolbar's glyphs, drawn rather than typed.
 *
 * They were Unicode characters — ⊕ ▤ ✎ ⌕ ⌂ ↗ ⋯ — and the row read as untidy
 * however carefully each one was sized. That is not a matter of taste: those
 * characters come from six different Unicode blocks, and a font gives each
 * block its own x-height, its own optical weight and its own box. `⌂` and `⌕`
 * are drawn at roughly half the height of an arrow at the same point size, `✎`
 * hangs below the baseline, `▤` is a filled block among outlines. Sizing them
 * one at a time fixes the SIZE and leaves them sitting at different heights,
 * which is exactly what "unos más altos otros más bajos" describes.
 *
 * So: one 24×24 grid, one stroke width, one cap style, every shape centred in
 * its box. The same conventions the workspace rail already uses, because a
 * toolbar three inches from the rail should not look like it came from a
 * different program.
 */

const svg = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

type P = { size?: number };

export function BackIcon({ size = 16 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M19 12H5" />
      <path d="M11 6l-6 6 6 6" />
    </svg>
  );
}

export function ForwardIcon({ size = 16 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}

/** A circle that does not quite close, with the arrow at the gap — the only
 *  reload shape that reads at 16px. */
export function ReloadIcon({ size = 16 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4.5h-4.5" />
    </svg>
  );
}

export function StopIcon({ size = 16 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M6.5 6.5l11 11" />
      <path d="M17.5 6.5l-11 11" />
    </svg>
  );
}

export function HomeIcon({ size = 16 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M4 10.5L12 4l8 6.5" />
      <path d="M6 9.8V19.5h12V9.8" />
    </svg>
  );
}

/** A reticle. Says "point at a thing" in a way a magnifier does not — that one
 *  already means "find text on this page", two controls to the right. */
export function TargetIcon({ size = 16 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <circle cx="12" cy="12" r="6.5" />
      <path d="M12 2.5v3.5M12 18v3.5M2.5 12h3.5M18 12h3.5" />
    </svg>
  );
}

/** A speech bubble with a plus: leave a note on this, for somebody else. */
export function NoteIcon({ size = 16 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M20 15.5a2 2 0 0 1-2 2H8.5L4.5 21V6a2 2 0 0 1 2-2H18a2 2 0 0 1 2 2z" />
      <path d="M12 8.2v5.2M9.4 10.8h5.2" />
    </svg>
  );
}

export function PenIcon({ size = 16 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M16.5 3.7l3.8 3.8" />
      <path d="M14.6 5.6L4.5 15.7 3.3 20.7l5-1.2L18.4 9.4z" />
    </svg>
  );
}

export function SearchIcon({ size = 16 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="M15.4 15.4L20.5 20.5" />
    </svg>
  );
}

/** Angle brackets. The universal mark for "the code behind this". */
export function CodeIcon({ size = 16 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M8.5 7.5L3.5 12l5 4.5" />
      <path d="M15.5 7.5L20.5 12l-5 4.5" />
    </svg>
  );
}

export function ExternalIcon({ size = 16 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M13.5 4.5H19.5V10.5" />
      <path d="M19.5 4.5L11 13" />
      <path d="M18 14.5v4a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h4" />
    </svg>
  );
}

/** Three dots. Drawn as round caps on zero-length strokes so they inherit the
 *  same weight as every other icon here rather than being three circles that
 *  happen to look about right. */
export function MoreIcon({ size = 16 }: P) {
  return (
    <svg {...svg} width={size} height={size} strokeWidth={2.6}>
      <path d="M5.6 12h.01M12 12h.01M18.4 12h.01" />
    </svg>
  );
}

export function PlusIcon({ size = 16 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M12 5.5v13M5.5 12h13" />
    </svg>
  );
}

export function CloseIcon({ size = 14 }: P) {
  return (
    <svg {...svg} width={size} height={size} strokeWidth={2.2}>
      <path d="M6.8 6.8l10.4 10.4M17.2 6.8L6.8 17.2" />
    </svg>
  );
}

/** The padlock beside the address, closed for https. */
export function LockIcon({ size = 12 }: P) {
  return (
    <svg {...svg} width={size} height={size} strokeWidth={2.2}>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
      <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
    </svg>
  );
}

/** And a globe when it is not. Says "this is a page" without claiming the
 *  connection is anything in particular. */
export function GlobeIcon({ size = 12 }: P) {
  return (
    <svg {...svg} width={size} height={size} strokeWidth={2}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5a13 13 0 0 1 0 17a13 13 0 0 1 0-17z" />
    </svg>
  );
}

/** The mark on an empty tab, and in the middle of an empty view. */
export function BlankPageIcon({ size = 16 }: P) {
  return (
    <svg {...svg} width={size} height={size} strokeWidth={1.6}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5a13 13 0 0 1 0 17a13 13 0 0 1 0-17z" />
    </svg>
  );
}

/** Still spinning. The arc is deliberately short — a nearly-closed ring reads
 *  as a full circle once it is moving. */
export function SpinnerIcon({ size = 13 }: P) {
  return (
    <svg {...svg} width={size} height={size} strokeWidth={2.4} className="animate-spin">
      <path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" />
    </svg>
  );
}
