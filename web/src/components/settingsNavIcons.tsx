import { ICON } from "../lib/iconSize.ts";

/**
 * One glyph per settings page, so the nav is twenty-four shapes instead of
 * twenty-four identical rows of text.
 *
 * Same ladder as the rail (`../lib/iconSize.ts`) and the same 24×24 stroke
 * style as `workspace/icons.tsx` — five of these ARE that file's icons
 * (Terminal, Chat, Diff, Browser, Understudy), reused rather than redrawn,
 * because a setting and the view it configures should read as the same
 * object. The rest are new because nothing in the rail stands for a
 * preference that has no view of its own — Appearance, Shortcuts, Privacy.
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

export function SlidersIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M4 7h9M17 7h3" /><circle cx="14" cy="7" r="2.2" />
      <path d="M4 17h3M11 17h9" /><circle cx="8.5" cy="17" r="2.2" />
    </svg>
  );
}

export function ThemeIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function BellIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M6 10a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 14 6 10z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </svg>
  );
}

export function SidebarIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="M9.5 4v16" />
    </svg>
  );
}

export function KeyboardIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </svg>
  );
}

export function BudgetIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v10M14.5 9.3c0-1-1-1.8-2.5-1.8s-2.5.8-2.5 1.8c0 2.4 5 1.1 5 3.4 0 1-1 1.8-2.5 1.8s-2.5-.8-2.5-1.8" />
    </svg>
  );
}

export function PulseIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M3 12h4l2-6 4 12 2-6h6" />
    </svg>
  );
}

export function FolderIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 17.5z" />
    </svg>
  );
}

export function CommandIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M5 5l6 7-6 7" /><path d="M13 19h6" />
    </svg>
  );
}

export function ReviewIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M4 19l1-4L16 4a2 2 0 0 1 3 3L8 18l-4 1z" />
    </svg>
  );
}

export function QuoteIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M4 15V9a2 2 0 0 1 2-2h2v6H4z" />
      <path d="M13 15V9a2 2 0 0 1 2-2h2v6h-4z" />
    </svg>
  );
}

export function DownloadIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M12 4v11M8 11l4 4 4-4" /><path d="M4 18.5h16" />
    </svg>
  );
}

export function PanesIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.4" />
      <rect x="13.5" y="3" width="7.5" height="4.5" rx="1.4" />
      <rect x="13.5" y="10.5" width="7.5" height="10.5" rx="1.4" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.4" />
    </svg>
  );
}

export function PlugIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0z" />
      <path d="M12 16v5" />
    </svg>
  );
}

export function ServerIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <rect x="3.5" y="4" width="17" height="7" rx="1.5" />
      <rect x="3.5" y="13" width="17" height="7" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </svg>
  );
}

export function PhoneIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
      <path d="M10.5 18.5h3" />
    </svg>
  );
}

export function PuzzleIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M9 4h4v2.2a1.8 1.8 0 0 0 3 1.3 1.8 1.8 0 0 1 3 1.3V13h-2.2a1.8 1.8 0 0 0 0 3.6H19v4h-4v-2.2a1.8 1.8 0 0 0-3.6 0V21H9v-4.5H6.8a1.8 1.8 0 0 1 0-3.6H9V9H6.8a1.8 1.8 0 0 1-1.3-3 1.8 1.8 0 0 1 3-1.3V4z" />
    </svg>
  );
}

export function ShieldIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
    </svg>
  );
}

export function InfoIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.8h.01" />
    </svg>
  );
}

export function ChecklistIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M3.5 6.5l2 2 3.5-3.5" /><path d="M12 7h9" />
      <path d="M3.5 15.5l2 2 3.5-3.5" /><path d="M12 16h9" />
    </svg>
  );
}

/** Three columns — the triage board, which is what it is a picture of. */
export function ColumnsIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <rect x="3" y="4" width="4.5" height="16" rx="1" />
      <rect x="9.75" y="4" width="4.5" height="16" rx="1" />
      <rect x="16.5" y="4" width="4.5" height="16" rx="1" />
    </svg>
  );
}

/** A tray with a lid open — the notifications inbox. Not an envelope: mail is
 *  something you send, and nothing here is sent. */
export function InboxIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M3 12.5h4.5l1.5 2.5h6l1.5-2.5H21" />
      <path d="M5.2 5.5h13.6L21 12.5v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4z" />
    </svg>
  );
}
