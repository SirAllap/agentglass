import { ICON } from "../../lib/iconSize.ts";
/** The workspace glyphs, shared by the rail and the header button.
 *  They used to live in Header.tsx, where the rail couldn't reach them. */

const svg = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

type P = { size?: number };

/** A checklist: the one shape that reads as "things to do" rather than "things
 *  that happened", which is the difference between an issue and an event. */
export function IssuesIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M3.5 6.5l2 2 3.5-3.5" />
      <path d="M12 7h9" />
      <path d="M3.5 15.5l2 2 3.5-3.5" />
      <path d="M12 16h9" />
    </svg>
  );
}

/** Four panes: the shape of a dashboard since the first one. */
export function DashIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.4" />
      <rect x="13.5" y="3" width="7.5" height="4.5" rx="1.4" />
      <rect x="13.5" y="10.5" width="7.5" height="10.5" rx="1.4" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.4" />
    </svg>
  );
}

/**
 * A folder — and it is a folder because Diff is now a page.
 *
 * This was a page with a turned corner, which is the clearest way to say
 * "file" there is. It stopped being available the moment the diff glyph became
 * a document: a rail with two icons meaning "a file" is a rail with neither.
 * A folder is what the view actually opens on anyway — a checkout you browse.
 */
export function FilesIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M3 6.6a2 2 0 0 1 2-2h3.5l2 2.6H19a2 2 0 0 1 2 2v9.2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M3 9.7h18" />
    </svg>
  );
}

/**
 * Git's own mark, as Git draws it.
 *
 * Three hand-drawn attempts failed here and the third failed for a reason
 * worth writing down: an outline with detail inside loses the INSIDE first
 * when it shrinks, because the strokes close the gaps between themselves. The
 * real logo is a filled silhouette whose branch is knocked out of it, and
 * negative space does not close — which is exactly why it still reads on a
 * GitHub tab at 16px.
 *
 * So this is the official mark (Jason Long, CC-BY 3.0), unaltered except for
 * taking the rail's colour. It is filled where the rest of the rail is
 * stroked, and that is a deliberate trade: a brand mark is allowed to be a
 * brand mark, and homogeneity is worth nothing on an icon nobody can identify.
 * DockerIcon is filled for the same reason and no others are.
 */
export function GitIcon({ size = ICON.md }: P) {
  /*
   * The one icon the 83% rule gets wrong, and it is geometry rather than taste.
   *
   * The mark is a DIAMOND — a square turned 45° — so its bounding box is its
   * diagonal, and a diamond that fills 83% of a box carries about half the ink
   * of a square that fills the same 83%. Normalised with everything else it
   * came out visibly the runt of the rail. It gets its own box back, filling it
   * corner to corner, which is the √2 a rotated square needs to weigh what an
   * upright one does.
   */
  return (
    <svg viewBox="0 0 15 15" width={size} height={size} fill="currentColor">
      <path d="M6.79286 1.20708L7.14642 1.56063L7.14642 1.56063L6.79286 1.20708ZM1.20708 6.79287L0.853524 6.43931H0.853524L1.20708 6.79287ZM1.20708 8.20708L1.56063 7.85352L1.56063 7.85352L1.20708 8.20708ZM6.79287 13.7929L6.43931 14.1464L6.79287 13.7929ZM8.20708 13.7929L7.85352 13.4393L8.20708 13.7929ZM13.7929 8.20708L14.1464 8.56063L13.7929 8.20708ZM13.7929 6.79286L13.4393 7.14642L13.7929 6.79286ZM8.20708 1.20708L8.56063 0.853524V0.853524L8.20708 1.20708ZM6.43931 0.853525L0.853524 6.43931L1.56063 7.14642L7.14642 1.56063L6.43931 0.853525ZM0.853525 8.56063L6.43931 14.1464L7.14642 13.4393L1.56063 7.85352L0.853525 8.56063ZM8.56063 14.1464L14.1464 8.56063L13.4393 7.85352L7.85352 13.4393L8.56063 14.1464ZM14.1464 6.43931L8.56063 0.853524L7.85352 1.56063L13.4393 7.14642L14.1464 6.43931ZM14.1464 8.56063C14.7322 7.97484 14.7322 7.0251 14.1464 6.43931L13.4393 7.14642C13.6346 7.34168 13.6346 7.65826 13.4393 7.85352L14.1464 8.56063ZM6.43931 14.1464C7.0251 14.7322 7.97485 14.7322 8.56063 14.1464L7.85352 13.4393C7.65826 13.6346 7.34168 13.6346 7.14642 13.4393L6.43931 14.1464ZM0.853524 6.43931C0.267737 7.0251 0.267739 7.97485 0.853525 8.56063L1.56063 7.85352C1.36537 7.65826 1.36537 7.34168 1.56063 7.14642L0.853524 6.43931ZM7.14642 1.56063C7.34168 1.36537 7.65826 1.36537 7.85352 1.56063L8.56063 0.853524C7.97484 0.267737 7.0251 0.267739 6.43931 0.853525L7.14642 1.56063ZM5.14642 2.85352L6.14642 3.85352L6.85352 3.14642L5.85352 2.14642L5.14642 2.85352ZM7.49997 4.99997C7.22383 4.99997 6.99997 4.77611 6.99997 4.49997H5.99997C5.99997 5.3284 6.67154 5.99997 7.49997 5.99997V4.99997ZM7.99997 4.49997C7.99997 4.77611 7.77611 4.99997 7.49997 4.99997V5.99997C8.3284 5.99997 8.99997 5.3284 8.99997 4.49997H7.99997ZM7.49997 3.99997C7.77611 3.99997 7.99997 4.22383 7.99997 4.49997H8.99997C8.99997 3.67154 8.3284 2.99997 7.49997 2.99997V3.99997ZM7.49997 2.99997C6.67154 2.99997 5.99997 3.67154 5.99997 4.49997H6.99997C6.99997 4.22383 7.22383 3.99997 7.49997 3.99997V2.99997ZM8.14642 5.85352L9.64642 7.35352L10.3535 6.64642L8.85352 5.14642L8.14642 5.85352ZM10.5 7.99997C10.2238 7.99997 9.99997 7.77611 9.99997 7.49997H8.99997C8.99997 8.3284 9.67154 8.99997 10.5 8.99997V7.99997ZM11 7.49997C11 7.77611 10.7761 7.99997 10.5 7.99997V8.99997C11.3284 8.99997 12 8.3284 12 7.49997H11ZM10.5 6.99997C10.7761 6.99997 11 7.22383 11 7.49997H12C12 6.67154 11.3284 5.99997 10.5 5.99997V6.99997ZM10.5 5.99997C9.67154 5.99997 8.99997 6.67154 8.99997 7.49997H9.99997C9.99997 7.22383 10.2238 6.99997 10.5 6.99997V5.99997ZM6.99997 5.49997V9.49997H7.99997V5.49997H6.99997ZM7.49997 11C7.22383 11 6.99997 10.7761 6.99997 10.5H5.99997C5.99997 11.3284 6.67154 12 7.49997 12V11ZM7.99997 10.5C7.99997 10.7761 7.77611 11 7.49997 11V12C8.3284 12 8.99997 11.3284 8.99997 10.5H7.99997ZM7.49997 9.99997C7.77611 9.99997 7.99997 10.2238 7.99997 10.5H8.99997C8.99997 9.67154 8.3284 8.99997 7.49997 8.99997V9.99997ZM7.49997 8.99997C6.67154 8.99997 5.99997 9.67154 5.99997 10.5H6.99997C6.99997 10.2238 7.22383 9.99997 7.49997 9.99997V8.99997Z" />
    </svg>
  );
}

/**
 * A file carrying a plus and a minus: what a diff IS, rather than what git
 * calls the command that produces one.
 *
 * Two earlier goes drew the topology — a branch with a curve, then two elbows
 * — and both were correct and unreadable: at 17px they were the Git glyph
 * again, only fuzzier. A page with + and − needs no vocabulary at all.
 */
export function DiffIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M12 11.5v5M9.5 14h5" />
      <path d="M9.5 18.4h5" />
    </svg>
  );
}

/** A globe: the one view that is not this machine. */
export function BrowserIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z" />
    </svg>
  );
}

/** A pull request, at Octicons' proportions: one line carries on, the other
 *  asks to come in, and the arrow is the ask. */
export function PrIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <circle cx="6" cy="6" r="3" />
      <path d="M6 9v12" />
      <circle cx="18" cy="18" r="3" />
      <path d="M18 15V8a2 2 0 0 0-2-2h-4.5" />
      <path d="M13.5 3.5 11 6l2.5 2.5" />
    </svg>
  );
}

/**
 * Docker's own whale. Filled, for the reason set out on GitIcon: at 17px the
 * silhouette survives and the outline does not — mine lost its fin twice.
 */
export function DockerIcon({ size = ICON.md }: P) {
  return (
    <svg viewBox="-3.06 -3.06 30.12 30.12" width={size} height={size} fill="currentColor">
      <path d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.082.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z" />
    </svg>
  );
}

/**
 * A console: the window, with a prompt in it.
 *
 * It used to be the prompt alone — a chevron and an underscore floating in the
 * middle of an otherwise empty box. Measured, its ink covered 44% of its own
 * height while the rest of the rail sat at 83%, so at the same nominal size it
 * read as a smaller icon, and on a strip whose whole job is to be scanned that
 * is the one thing an icon must not be. The window gives it the same footprint
 * as its neighbours and says "terminal" more plainly than punctuation does.
 */
export function TerminalIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 10l2.5 2.5L7 15" />
      <path d="M12.5 15.5H17" />
    </svg>
  );
}

export function ChatIcon({ size = ICON.md }: P) {
  return <svg {...svg} viewBox="1.16 1.16 21.69 21.69" strokeWidth={1.81} width={size} height={size}><path d="M20 4H4v12h5v4l5-4h6z" /></svg>;
}

/**
 * Two of you, and the second one is drawn as a dotted line.
 *
 * The view is a scorecard of what a stand-in WOULD have done, so the glyph has
 * to say two things at once: that there is a second actor, and that it is not
 * real yet. A single figure says neither. Two solid figures say "a team", which
 * is the users icon every app already has and is exactly the wrong promise —
 * nothing here acts.
 *
 * The dashes carry that whole distinction, which is why they are 2.4 long
 * rather than the 1px ticks a dotted border would use: at the rail's 26px a
 * finer dash closes up into a solid stroke, and the icon quietly becomes the
 * one it was drawn not to be. The understudy stands behind and to the side, as
 * one does.
 */
export function UnderstudyIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <g strokeDasharray="2.4 2.2">
        <circle cx="16.6" cy="6.6" r="3" />
        <path d="M11.6 17.6v-1a3.6 3.6 0 0 1 3.6-3.6h2.8a3.6 3.6 0 0 1 3.6 3.6v1" />
      </g>
      <circle cx="8.8" cy="9.2" r="3.6" />
      <path d="M2.5 20.5v-1.2a4.3 4.3 0 0 1 4.3-4.3h4a4.3 4.3 0 0 1 4.3 4.3v1.2" />
    </svg>
  );
}

/** The single header button that replaced the five. A pane split off a frame. */
export function WorkspaceIcon({ size = ICON.md }: P) {
  return <svg {...svg} width={size} height={size}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>;
}

/** The skills catalog: a reference you open, not a view you work in — which is
 *  why it sits with close at the foot of the rail rather than among the tabs. */
export function SkillsIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M3 19.5A2.5 2.5 0 0 1 5.5 17H21" />
      <path d="M5.5 3H21v18H5.5A2.5 2.5 0 0 1 3 18.5v-13A2.5 2.5 0 0 1 5.5 3z" />
    </svg>
  );
}

export function CloseIcon({ size = ICON.md }: P) {
  return <svg {...svg} width={size} height={size}><path d="M6 6l12 12M18 6L6 18" /></svg>;
}



/** A lantern: it lights when somebody needs you. The flame is the one filled
 *  shape on the rail — everything else here is strokes — because a flame
 *  drawn as an outline is a leaf. */
export function LanternIcon({ size = ICON.md }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M9 3.5h6" />
      <path d="M12 3.5v2" />
      <path d="M7.5 5.5h9l1 3h-11z" />
      <path d="M8.5 8.5v8.5a1.5 1.5 0 0 0 1.5 1.5h4a1.5 1.5 0 0 0 1.5-1.5V8.5" />
      <path d="M8.5 18.5h7" />
      <path d="M12 15.6c-1.3 0-2-.9-2-1.9 0-1.2 1.1-1.8 1.4-3 .5 1 .6 1.5 1.1 1.8.3-.4.4-.7.4-1 .8.7 1.1 1.4 1.1 2.2 0 1-.7 1.9-2 1.9z" fill="currentColor" stroke="none" />
    </svg>
  );
}
