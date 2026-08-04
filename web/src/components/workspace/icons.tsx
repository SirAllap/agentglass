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
export function IssuesIcon({ size = 15 }: P) {
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
export function DashIcon({ size = 15 }: P) {
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
 * A page with its corner turned: a file, said the way every interface has said
 * it for forty years.
 *
 * Two attempts got this wrong in opposite directions. A folder behind a page
 * was two outlines overlapping into a smudge at 17px; the stem-and-leaves tree
 * that replaced it was legible but read as a hierarchy, an org chart, a
 * mind-map — anything structural — and crowded its own box besides. This says
 * "file" and nothing else, and it has the whole 24 to breathe in.
 */
export function FilesIcon({ size = 15 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </svg>
  );
}

/**
 * A branch leaving a line: the shape Git's own logo abstracts, and the one
 * every tool in this family draws.
 *
 * It was a vertical line through a ring, which is a record button, a power
 * symbol or an axis depending on who is looking — anything except version
 * control. Three of these icons are git concepts (branch, compare, pull
 * request) and they now share one vocabulary: 3px nodes, 2px strokes, a
 * quarter-circle to turn a corner. Told apart by their topology rather than by
 * decoration, which is what makes them survive being drawn at 17px.
 */
export function GitIcon({ size = 15 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M6 3v12" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

/**
 * Two refs pointing at each other: `git compare`, which is what a diff view
 * actually is.
 *
 * The old one was the branch icon with an extra curve — same nodes, same
 * sweep — so at rail size Git and Diff were the same smudge twice. This one
 * reads as a comparison because both arms turn back on themselves.
 */
export function DiffIcon({ size = 15 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <circle cx="5" cy="6" r="3" />
      <circle cx="19" cy="18" r="3" />
      <path d="M12 6h3a2 2 0 0 1 2 2v7" />
      <path d="M14.5 8.5 17 6l2.5 2.5" />
      <path d="M12 18H9a2 2 0 0 1-2-2V9" />
      <path d="M9.5 15.5 7 18l-2.5-2.5" />
    </svg>
  );
}

/** A globe: the one view that is not this machine. */
export function BrowserIcon({ size = 15 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z" />
    </svg>
  );
}

/** A pull request: one line carries on, the other asks to come in — the arrow
 *  is the ask, and it is what tells this apart from the compare above. */
export function PrIcon({ size = 15 }: P) {
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
 * Containers stacked on a hull: Docker's own mark, reduced to what survives at
 * 17px.
 *
 * It was an isometric cube, which is the universal glyph for "a package" — npm,
 * cargo, a release artifact, a box. True of Docker and true of nine other
 * things, so it identified nothing. The stack over a waterline is the shape
 * people actually recognise, and it stays a shape rather than a texture when it
 * is small: five rectangles and one curve.
 */
export function DockerIcon({ size = 15 }: P) {
  return (
    <svg {...svg} width={size} height={size} strokeWidth={1.7}>
      <rect x="3" y="10.5" width="4" height="4" rx="0.6" />
      <rect x="8" y="10.5" width="4" height="4" rx="0.6" />
      <rect x="13" y="10.5" width="4" height="4" rx="0.6" />
      <rect x="8" y="6" width="4" height="4" rx="0.6" />
      <path d="M2 17.5c1.6 1.6 4 2.2 6.6 2.2 4.6 0 8.4-2.2 9.6-6.4 1.4.5 2.8.3 3.8-.6-1.3-1.1-3-1-3.9-.4" />
    </svg>
  );
}

export function TerminalIcon({ size = 15 }: P) {
  return <svg {...svg} width={size} height={size}><path d="M6 8l3.5 4L6 16" /><path d="M12.5 16.5H18" /></svg>;
}

export function ChatIcon({ size = 15 }: P) {
  return <svg {...svg} width={size} height={size}><path d="M20 4H4v12h5v4l5-4h6z" /></svg>;
}

/** The single header button that replaced the five. A pane split off a frame. */
export function WorkspaceIcon({ size = 15 }: P) {
  return <svg {...svg} width={size} height={size}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>;
}

/** The skills catalog: a reference you open, not a view you work in — which is
 *  why it sits with close at the foot of the rail rather than among the tabs. */
export function SkillsIcon({ size = 15 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 3H20v18H6.5A2.5 2.5 0 0 1 4 18.5v-13A2.5 2.5 0 0 1 6.5 3z" />
    </svg>
  );
}

export function CloseIcon({ size = 15 }: P) {
  return <svg {...svg} width={size} height={size}><path d="M6 6l12 12M18 6L6 18" /></svg>;
}
