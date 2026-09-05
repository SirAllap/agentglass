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

/*
 * ONE LADDER, NOT TWO.
 *
 * These twenty-seven components defaulted to the literal `16` and this file
 * imported nothing — a second scale, competing with `lib/iconSize.ts`, and the
 * one everything off-ladder clustered around: of the twenty-four icon sites in
 * the app that are not on a rung, eleven are in this file's consumer, and
 * twenty-three of the app's sixty hardcoded sizes live there too. The other two
 * icon files in this app both import `ICON` and default to `ICON.md`; this one
 * was the outlier, not the pattern.
 *
 * Nothing renders differently: 16 IS `ICON.md`. What changes is that a rung has
 * a name, so the next size is chosen from a ladder rather than typed.
 */
import { ICON } from "../../lib/iconSize.ts";

type P = { size?: number };

export function BackIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M19 12H5" />
      <path d="M11 6l-6 6 6 6" />
    </svg>
  );
}

export function ForwardIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}

/** A circle that does not quite close, with the arrow at the gap — the only
 *  reload shape that reads at 16px. */
export function ReloadIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4.5h-4.5" />
    </svg>
  );
}

export function StopIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M6.5 6.5l11 11" />
      <path d="M17.5 6.5l-11 11" />
    </svg>
  );
}

export function HomeIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M4 10.5L12 4l8 6.5" />
      <path d="M6 9.8V19.5h12V9.8" />
    </svg>
  );
}

/** A reticle. Says "point at a thing" in a way a magnifier does not — that one
 *  already means "find text on this page", two controls to the right. */
export function TargetIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <circle cx="12" cy="12" r="6.5" />
      <path d="M12 2.5v3.5M12 18v3.5M2.5 12h3.5M18 12h3.5" />
    </svg>
  );
}

/** A speech bubble with a plus: leave a note on this, for somebody else. */
export function NoteIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M20 15.5a2 2 0 0 1-2 2H8.5L4.5 21V6a2 2 0 0 1 2-2H18a2 2 0 0 1 2 2z" />
      <path d="M12 8.2v5.2M9.4 10.8h5.2" />
    </svg>
  );
}

export function PenIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M16.5 3.7l3.8 3.8" />
      <path d="M14.6 5.6L4.5 15.7 3.3 20.7l5-1.2L18.4 9.4z" />
    </svg>
  );
}

export function SearchIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="M15.4 15.4L20.5 20.5" />
    </svg>
  );
}

/** Angle brackets. The universal mark for "the code behind this". */
export function CodeIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M8.5 7.5L3.5 12l5 4.5" />
      <path d="M15.5 7.5L20.5 12l-5 4.5" />
    </svg>
  );
}

export function ExternalIcon({ size = ICON.md }: P) {
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
export function MoreIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size} strokeWidth={2.6}>
      <path d="M5.6 12h.01M12 12h.01M18.4 12h.01" />
    </svg>
  );
}

export function PlusIcon({ size = ICON.md }: P) {
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
export function BlankPageIcon({ size = ICON.md }: P) {
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

/** A folder, for the shelf. Drawn open or shut, because the caret beside it is
 *  4px of glyph and the folder is what the eye actually lands on. */
export function FolderIcon({ size = 14, open }: P & { open?: boolean }) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M3 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.2h8a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3 17.7z" />
      {open && <path d="M3.4 18.6L6 11.6h15l-2.6 7" />}
    </svg>
  );
}

/**
 * A container: one agent's identity, with its pages inside it.
 *
 * Not a folder. A folder is where you filed something; a container is a thing
 * with its own walls — its own cookies, its own logins, its own cache — and
 * with several agents working at once that distinction is the whole point of
 * the bar. So: a box, drawn in one piece, with the seam that says it has an
 * inside.
 */
export function ContainerIcon({ size = 13 }: P) {
  return (
    <svg {...svg} width={size} height={size} strokeWidth={1.9}>
      <path d="M12 3.4l7.6 4.2v8.8L12 20.6 4.4 16.4V7.6z" />
      <path d="M4.4 7.6L12 11.8l7.6-4.2" />
      <path d="M12 11.8v8.8" />
    </svg>
  );
}

/** A space: the browser's whole set, swapped at once. Two panes, because that
 *  is what changing one looks like — everything moves. */
export function SpaceIcon({ size = 13 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <rect x="3.5" y="4.5" width="7" height="15" rx="1.5" />
      <rect x="13.5" y="4.5" width="7" height="15" rx="1.5" />
    </svg>
  );
}

/** A camera, for the screenshot tool. */
export function CameraIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M3.5 8.5a1.5 1.5 0 0 1 1.5-1.5h2l1.4-2h5.2L15 7h4a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />
      <circle cx="12" cy="13" r="3.4" />
    </svg>
  );
}

/** The bar itself, for the control that hides it: a pane with a rail down one
 *  side, which is what it is. */
export function PanelIcon({ size = 15 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M15 4.5v15" />
    </svg>
  );
}

/** Up and down, for stepping through search matches. Chevrons rather than the
 *  ▲▼ glyphs: a clickable thing whose whole content is a character is the
 *  mistake the icon audit exists to stop. */
export function UpIcon({ size = 14 }: P) {
  return <svg {...svg} width={size} height={size}><path d="M6 14.5L12 8.5l6 6" /></svg>;
}

export function DownIcon({ size = 14 }: P) {
  return <svg {...svg} width={size} height={size}><path d="M6 9.5l6 6 6-6" /></svg>;
}

/** Keep it: an arrow into a tray. */
export function SaveIcon({ size = 15 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M12 4v10" /><path d="M8 10.5l4 4 4-4" /><path d="M4.5 17.5v2h15v-2" />
    </svg>
  );
}

/** Two panes sharing the width. */
export function SplitIcon({ size = 14 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M12 5v14" />
    </svg>
  );
}
