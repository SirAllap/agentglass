/*
 * The three shapes that kept being typed instead of drawn.
 *
 * A refresh, a play and a caret appear in six places across this app and every
 * one of them was a CHARACTER — `⟳`, `▶`, `▼` — inside a clickable element.
 * That walks past the icon ladder entirely, because the ladder is about
 * `<svg width={ICON.x}>`: a glyph has no size of its own beyond its font, draws
 * about 60% of the ink its font-size implies, and gives its control no height.
 * The branch list's tick box was the report that found it ("it is TINY, you
 * can't even see it") and these are the rest of the family.
 *
 * Deliberately here rather than in `workspace/icons.tsx`: that file is the
 * rail's iconography, which is a set with a common weight and a common
 * silhouette. These are utilities.
 */
import { ICON } from "./iconSize.ts";
import type { ReactNode } from "react";

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

/**
 * Two sheets, for "take this away with you".
 *
 * The board drew it as `⧉` at `fontSize: 9`, which is the smallest ink in the
 * app: a character paints about 60% of what its size promises (see the note at
 * the top of this file), so nine landed near five — beside a 14px vector, two
 * lines away, in the same row. Reported as "some icons are very big, others
 * very small", and this was the pair that made it obvious.
 */
export function CopyIcon({ size = ICON.xs, className }: P) {
  return (
    <svg {...svg(size, className)}>
      <rect x="5.2" y="2.4" width="6.4" height="6.4" rx="1.2" />
      <path d="M8.8 11.6H3.6a1.2 1.2 0 0 1-1.2-1.2V5.2" />
    </svg>
  );
}

/**
 * A star, filled when it is on.
 *
 * `★`/`☆` were two DIFFERENT characters swapped for each other, which is the
 * thing the caret below refuses to do — and worse here, because the two are not
 * the same width in every font, so the row shifted as it toggled. One shape,
 * one size, filled or not.
 */
export function StarIcon({ size = ICON.sm, className, filled }: P & { filled?: boolean }) {
  return (
    <svg {...svg(size, className)} fill={filled ? "currentColor" : "none"}>
      <path d="M7 1.9l1.55 3.14 3.47.5-2.51 2.45.59 3.45L7 9.81 3.9 11.44l.59-3.45L1.98 5.54l3.47-.5z" />
    </svg>
  );
}

/*
 * The rest of the family.
 *
 * Every one of these was a character somewhere in the app — `⌕`, `✎`, `⚠`, `🔒`,
 * `⎇`, `⏰`, `💬`, `✦`, `⛶`… — and the emoji among them drew in colour, at a
 * size set by whatever font the system picked, beside the line icons of the
 * rail. One stroke, one grid, one colour (the text's), so a row reads as one
 * set wherever it sits. The glyph each replaces is named on the line above it.
 */

/** ⌕ 🔍 🔎 */
export function SearchIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><circle cx="6" cy="6" r="3.8" /><path d="M8.9 8.9L12 12" /></svg>;
}

/** ✎ */
export function EditIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M9.5 2.5l2 2L5 11l-2.6.6L3 9z" /><path d="M8.3 3.7l2 2" /></svg>;
}

/** ⚠ */
export function WarningIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M7 1.9l5.4 9.6H1.6z" /><path d="M7 5.6v2.6M7 9.9v.1" /></svg>;
}

/** 🔒 ⚿, open when `open` (🔓). */
export function LockIcon({ size = ICON.sm, className, open }: P & { open?: boolean }) {
  return (
    <svg {...svg(size, className)}>
      <rect x="2.8" y="6.2" width="8.4" height="5.8" rx="1.2" />
      <path d={open ? "M4.8 6.2V4.4a2.2 2.2 0 0 1 4.3-.7" : "M4.8 6.2V4.4a2.2 2.2 0 0 1 4.4 0v1.8"} />
    </svg>
  );
}

/** 🔗 */
export function LinkIcon({ size = ICON.sm, className }: P) {
  return (
    <svg {...svg(size, className)}>
      <path d="M6 8a2.4 2.4 0 0 0 3.4 0l1.8-1.8a2.4 2.4 0 0 0-3.4-3.4l-.8.8" />
      <path d="M8 6a2.4 2.4 0 0 0-3.4 0L2.8 7.8a2.4 2.4 0 0 0 3.4 3.4l.8-.8" />
    </svg>
  );
}

/** ⎇ ⑂ ⑃ */
export function BranchIcon({ size = ICON.sm, className }: P) {
  return (
    <svg {...svg(size, className)}>
      <circle cx="4" cy="3" r="1.3" /><circle cx="4" cy="11" r="1.3" /><circle cx="10" cy="4.4" r="1.3" />
      <path d="M4 4.3v5.4M10 5.7c0 2.6-6 1.8-6 4" />
    </svg>
  );
}

/** ⏰ ⏱ ⏳ ◷ — one clock for every "when". */
export function ClockIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><circle cx="7" cy="7" r="5.1" /><path d="M7 4.2V7l1.9 1.3" /></svg>;
}

/** ⚡ */
export function BoltIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M8 1.6L3.4 8h3.5l-.9 4.4L10.6 6H7.1z" /></svg>;
}

/** 💬 */
export function CommentIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M2.3 3.3a1 1 0 0 1 1-1h7.4a1 1 0 0 1 1 1v5.2a1 1 0 0 1-1 1H6.1L3.7 11.6V9.5h-.4a1 1 0 0 1-1-1z" /></svg>;
}

/** ✦ ✨ */
export function SparkleIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M7 1.8l1.3 3.9L12.2 7 8.3 8.3 7 12.2 5.7 8.3 1.8 7l3.9-1.3z" /></svg>;
}

/** ⛶ ⤢ — fill the space; `shrink` for ⤡, back to size. */
export function ExpandIcon({ size = ICON.sm, className, shrink }: P & { shrink?: boolean }) {
  return (
    <svg {...svg(size, className)}>
      {shrink
        ? <path d="M12 2L8.6 5.4M8.6 2.8v2.6h2.6M2 12l3.4-3.4M5.4 11.2V8.6H2.8" />
        : <path d="M8.6 2.2h3.2v3.2M11.8 2.2L8.2 5.8M5.4 11.8H2.2V8.6M2.2 11.8l3.6-3.6" />}
    </svg>
  );
}

/** ⊘ ⛔ */
export function BlockedIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><circle cx="7" cy="7" r="5.1" /><path d="M3.4 10.6l7.2-7.2" /></svg>;
}

/** ☐ ☑ ✅ — one box, ticked or not. */
export function CheckboxIcon({ size = ICON.sm, className, checked }: P & { checked?: boolean }) {
  return (
    <svg {...svg(size, className)}>
      <rect x="2.2" y="2.2" width="9.6" height="9.6" rx="2" />
      {checked && <path d="M4.6 7.2l1.7 1.7 3.2-3.5" />}
    </svg>
  );
}

/** ⋯ */
export function MoreIcon({ size = ICON.sm, className }: P) {
  return (
    <svg {...svg(size, className)} fill="currentColor" stroke="none">
      <circle cx="3" cy="7" r="1.1" /><circle cx="7" cy="7" r="1.1" /><circle cx="11" cy="7" r="1.1" />
    </svg>
  );
}

/** 📌 */
export function PinIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M8.6 1.8l3.6 3.6-1.5.7-2.3 2.3.3 2.3-.9.9-5.4-5.4.9-.9 2.3.3 2.3-2.3z" /><path d="M4.4 9.6L1.8 12.2" /></svg>;
}

/** 📁 🗀 */
export function FolderIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M1.8 4a1 1 0 0 1 1-1h2.8l1.3 1.4h4.3a1 1 0 0 1 1 1v5.4a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z" /></svg>;
}

/** 🖥 */
export function MonitorIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><rect x="1.8" y="2.2" width="10.4" height="7.2" rx="1" /><path d="M5 11.8h4M7 9.4v2.4" /></svg>;
}

/** 📱 */
export function PhoneIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><rect x="3.8" y="1.6" width="6.4" height="10.8" rx="1.3" /><path d="M6.3 10.4h1.4" /></svg>;
}

/** 👤 */
export function UserIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><circle cx="7" cy="4.8" r="2.4" /><path d="M2.6 12.2a4.4 4.4 0 0 1 8.8 0" /></svg>;
}

/** 👁 */
export function EyeIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M1.4 7S3.6 3 7 3s5.6 4 5.6 4-2.2 4-5.6 4S1.4 7 1.4 7z" /><circle cx="7" cy="7" r="1.8" /></svg>;
}

/** 🏷 */
export function TagIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M1.9 2.9v3.5l5.6 5.6 4.4-4.4-5.6-5.6H2.9a1 1 0 0 0-1 .9z" /><circle cx="4.6" cy="4.6" r=".8" /></svg>;
}

/** 📎 */
export function AttachIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M10.8 6.6l-4.2 4.2a2.6 2.6 0 0 1-3.7-3.7l4.6-4.6a1.7 1.7 0 0 1 2.4 2.4L5.3 9.5a.8.8 0 0 1-1.2-1.2l4-4" /></svg>;
}

/** ✳ 🤖 — an agent. */
export function AgentIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M7 1.8v10.4M2.5 4.4l9 5.2M11.5 4.4l-9 5.2" /></svg>;
}

/** 🌙 */
export function MoonIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M11.8 8.6A5 5 0 1 1 5.4 2.2a4 4 0 0 0 6.4 6.4z" /></svg>;
}

/** ✋ 🙋 — somebody is needed. */
export function HandIcon({ size = ICON.sm, className }: P) {
  return (
    <svg {...svg(size, className)}>
      <path d="M4.6 7.4V3.6a.9.9 0 0 1 1.8 0v3M6.4 6.6V2.6a.9.9 0 0 1 1.8 0v4M8.2 6.6V3.6a.9.9 0 0 1 1.8 0v4.8a3.8 3.8 0 0 1-3.8 3.8h-.3a3.4 3.4 0 0 1-2.8-1.5L1.7 8.3a.9.9 0 0 1 1.4-1.1l1.5 1.6" />
    </svg>
  );
}

/** 🔥 */
export function FireIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M7 12.2a3.8 3.8 0 0 0 3.8-3.8c0-2.6-2.4-3.4-2.4-6.6-2 1.2-3 3-2.8 4.6-.8-.4-1.4-1.2-1.4-2-1 1.4-1.2 2.6-1.2 4A3.8 3.8 0 0 0 7 12.2z" /></svg>;
}

/** ↺ ⟲ ↶ ⎌ — back; `redo` for ↷. */
export function UndoIcon({ size = ICON.sm, className, redo }: P & { redo?: boolean }) {
  return (
    <svg {...svg(size, className)} style={redo ? { transform: "scaleX(-1)" } : undefined}>
      <path d="M4.4 3.8L2.2 6l2.2 2.2" /><path d="M2.2 6h6.2a3.2 3.2 0 0 1 0 6.4H6" />
    </svg>
  );
}

/** ⇄ */
export function SwapIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M2.4 4.6h9M9.4 2.4l2.2 2.2-2.2 2.2M11.6 9.4h-9M4.6 7.2L2.4 9.4l2.2 2.2" /></svg>;
}

/** ▤ — a note. */
export function NoteIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><rect x="2.6" y="1.8" width="8.8" height="10.4" rx="1.2" /><path d="M4.8 5h4.4M4.8 7.2h4.4M4.8 9.4h2.6" /></svg>;
}

/** ◆ — a file. */
export function FileIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M3.4 1.8h4.7l2.5 2.5v7a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1z" /><path d="M8 1.8v2.6h2.6" /></svg>;
}

/** ☰ ⊟ ▣ — put away: a stash, a drawer. */
export function StashIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M2 5.2l1.4-2.6h7.2L12 5.2" /><rect x="2" y="5.2" width="10" height="6.4" rx="1" /><path d="M5.4 7.8h3.2" /></svg>;
}

/** ⛁ — a disk. */
export function DiskIcon({ size = ICON.sm, className }: P) {
  return (
    <svg {...svg(size, className)}>
      <ellipse cx="7" cy="3.6" rx="4.4" ry="1.8" />
      <path d="M2.6 3.6v6.8c0 1 2 1.8 4.4 1.8s4.4-.8 4.4-1.8V3.6M2.6 7c0 1 2 1.8 4.4 1.8s4.4-.8 4.4-1.8" />
    </svg>
  );
}

/** ⌂ */
export function HomeIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M2 6.6L7 2.4l5 4.2M3.4 5.6v6h7.2v-6" /></svg>;
}

/** ⚐ ⚑ — filled when set. */
export function FlagIcon({ size = ICON.sm, className, filled }: P & { filled?: boolean }) {
  return <svg {...svg(size, className)} ><path d="M3 12.2V1.8" /><path d="M3 2.4h7.2L8.6 5l1.6 2.6H3z" fill={filled ? "currentColor" : "none"} /></svg>;
}

/** ⊞ — tiles. */
export function GridIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><rect x="2" y="2" width="4.2" height="4.2" rx=".8" /><rect x="7.8" y="2" width="4.2" height="4.2" rx=".8" /><rect x="2" y="7.8" width="4.2" height="4.2" rx=".8" /><rect x="7.8" y="7.8" width="4.2" height="4.2" rx=".8" /></svg>;
}

/** ✕ ❌ — the close cross, for places that are not a CloseButton. */
export function CrossIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M3.6 3.6l6.8 6.8M10.4 3.6l-6.8 6.8" /></svg>;
}

/** ◯ • — waiting, not answered yet. */
export function CircleIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><circle cx="7" cy="7" r="4.6" /></svg>;
}

/** ◌ — a draft. */
export function DraftIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)} strokeDasharray="2 1.8"><circle cx="7" cy="7" r="4.8" /></svg>;
}

/** ⏣ — merged. */
export function MergeIcon({ size = ICON.sm, className }: P) {
  return (
    <svg {...svg(size, className)}>
      <circle cx="4" cy="3" r="1.3" /><circle cx="4" cy="11" r="1.3" /><circle cx="10.4" cy="8" r="1.3" />
      <path d="M4 4.3v5.4M4.6 4.2c.6 2 2.4 3.6 4.5 3.8" />
    </svg>
  );
}

/** Two circles and the line between them, an arrowhead partway along it —
 *  a branch offering itself back, which is the one shape `BranchIcon` and
 *  `MergeIcon` both stop short of drawing. The row's pull-request chip. */
export function PullRequestIcon({ size = ICON.sm, className }: P) {
  return (
    <svg {...svg(size, className)}>
      <circle cx="4" cy="3" r="1.3" /><circle cx="4" cy="11" r="1.3" /><circle cx="10.4" cy="8" r="1.3" />
      <path d="M4 4.3v5.4M4.6 4.2c.6 2 2.4 3.6 4.5 3.8" />
      <path d="M7.9 6.6 9.1 8l-1.2 1.4" />
    </svg>
  );
}

/** ＋ */
export function PlusIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M7 2.8v8.4M2.8 7h8.4" /></svg>;
}

/** ⌨ */
export function KeyboardIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><rect x="1.6" y="3.4" width="10.8" height="7.2" rx="1.2" /><path d="M4 5.8h.1M6 5.8h.1M8 5.8h.1M10 5.8h.1M4.6 8.2h4.8" /></svg>;
}

/** ☰ as "insights" — a small bar chart. */
export function ChartIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M2.2 11.8h9.6M3.8 11.8V7.6M7 11.8V3.2M10.2 11.8V5.6" /></svg>;
}

/** ◉ — aim at one thing: bisect. */
export function TargetIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><circle cx="7" cy="7" r="5" /><circle cx="7" cy="7" r="1.6" /></svg>;
}

/** ⊟ — a tree of files. */
export function TreeIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M3 2.4v8.2M3 4.6h3.2M3 8.4h3.2M3 10.6h0" /><rect x="7.4" y="3.4" width="4.4" height="2.4" rx=".6" /><rect x="7.4" y="7.2" width="4.4" height="2.4" rx=".6" /></svg>;
}

/** ≡ — a flat list. */
export function ListIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M2.4 3.8h9.2M2.4 7h9.2M2.4 10.2h9.2" /></svg>;
}

/** ⎇ on the commit button — a commit on its line. */
export function CommitIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><circle cx="7" cy="7" r="2.4" /><path d="M1.6 7h3M9.4 7h3" /></svg>;
}

/**
 * An icon and its words, on one line, spaced like every other labelled icon.
 *
 * For the places that had "⟳ Refresh" as one string inside an element whose
 * class is not a flex row: wrapping the pair here keeps that element's own
 * class — and every test that pins it — untouched.
 */
export function IconLabel({ icon, children, className }: { icon: ReactNode; children?: ReactNode; className?: string }) {
  return <span className={`inline-flex items-center gap-1 ${className ?? ""}`}>{icon}{children}</span>;
}

/** － */
export function MinusIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M2.8 7h8.4" /></svg>;
}

/** ℹ */
export function InfoIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><circle cx="7" cy="7" r="5.1" /><path d="M7 6.4v3.4M7 4.3v.1" /></svg>;
}

/** ▭ — draw a box. */
export function BoxIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><rect x="2.2" y="3.4" width="9.6" height="7.2" rx="1" /></svg>;
}

/** ↗ as a drawing tool — an arrow. */
export function ArrowIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M3 11L11 3M5.4 3H11v5.6" /></svg>;
}

/** ⌸ — an inbox tray. */
export function InboxIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)}><path d="M2 8l1.6-5.2h6.8L12 8v3.2a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" /><path d="M2 8h2.8l.9 1.6h2.6L9.2 8H12" /></svg>;
}

/** ● — set, chosen, weighted. */
export function DotIcon({ size = ICON.sm, className }: P) {
  return <svg {...svg(size, className)} fill="currentColor" stroke="none"><circle cx="7" cy="7" r="3.4" /></svg>;
}
