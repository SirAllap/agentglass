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
 * A folder — and it is a folder because Diff is now a page.
 *
 * This was a page with a turned corner, which is the clearest way to say
 * "file" there is. It stopped being available the moment the diff glyph became
 * a document: a rail with two icons meaning "a file" is a rail with neither.
 * A folder is what the view actually opens on anyway — a checkout you browse.
 */
export function FilesIcon({ size = 15 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M3 6.6a2 2 0 0 1 2-2h3.5l2 2.6H19a2 2 0 0 1 2 2v9.2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M3 9.7h18" />
    </svg>
  );
}

/**
 * Git's own diamond.
 *
 * Two attempts before this drew the concept — a line through a ring, then a
 * branch — and both were things Git happens to do rather than how Git signs
 * its name. The diamond is the signature, and it is recognised before it is
 * read.
 */
export function GitIcon({ size = 15 }: P) {
  return (
    /* The diamond is how Git signs its name, so it stays. What could not stay
       is the logo's interior: a three-node branch is more marks than there are
       pixels for at 17px, and it collapsed into a smudge inside the outline —
       "es tan mini que no se distingue". Rendered at the rail's own size
       against four alternatives, the readable budget turned out to be exactly
       a diagonal and two nodes. The nodes are filled rather than stroked
       because a 2px ring of radius 1.5 has no hole left at this size; it is a
       dot whether or not it is drawn as one, so it may as well be a crisp one. */
    <svg {...svg} width={size} height={size} strokeWidth={1.7}>
      <path d="M12 1.4 22.6 12 12 22.6 1.4 12Z" />
      <path d="M8.4 15.6 15.6 8.4" />
      <circle cx="8.4" cy="15.6" r="2" fill="currentColor" stroke="none" />
      <circle cx="15.6" cy="8.4" r="2" fill="currentColor" stroke="none" />
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
export function DiffIcon({ size = 15 }: P) {
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
export function BrowserIcon({ size = 15 }: P) {
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
 * things, so it identified nothing. The stack over a hull is the shape people
 * actually recognise.
 *
 * The fin is back, and closer to the real mark. What broke the first version
 * was not the fin but its size: a thin curl detached from the body at 17px and
 * read as a missing piece — "le falta un trozo". Drawn heavier and touching
 * the hull, it holds.
 */
export function DockerIcon({ size = 15 }: P) {
  return (
    <svg {...svg} width={size} height={size} strokeWidth={1.7}>
      <rect x="4.2" y="10.3" width="3.4" height="3.2" rx="0.5" />
      <rect x="8.4" y="10.3" width="3.4" height="3.2" rx="0.5" />
      <rect x="12.6" y="10.3" width="3.4" height="3.2" rx="0.5" />
      <rect x="8.4" y="6.5" width="3.4" height="3.2" rx="0.5" />
      <path d="M2.6 14.2h14.9c0 2.8-2 4.8-5.1 4.8H7.5c-2.8 0-4.9-1.9-4.9-4.8Z" />
      <path d="M18 12.6c1.1-.8 2.4-.9 3.4-.3-.6 1.4-1.9 2-3.2 1.8" />
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
