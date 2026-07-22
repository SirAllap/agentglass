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

export function GitIcon({ size = 15 }: P) {
  return <svg {...svg} width={size} height={size}><path d="M12 3v6M12 15v6" /><circle cx="12" cy="12" r="3" /></svg>;
}

export function DiffIcon({ size = 15 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <path d="M6 3v12" /><circle cx="6" cy="18" r="2.2" /><path d="M6 15a6 6 0 0 0 6 6" />
      <circle cx="18" cy="6" r="2.2" /><path d="M18 8v3a6 6 0 0 1-6 6" />
    </svg>
  );
}

/** Two commits reconciling into one line — a pull request, not a branch. */
export function PrIcon({ size = 15 }: P) {
  return (
    <svg {...svg} width={size} height={size}>
      <circle cx="6" cy="6" r="2.2" /><path d="M6 8.2V18" /><circle cx="6" cy="20" r="2" />
      <circle cx="18" cy="18" r="2.2" /><path d="M18 15.8V10a4 4 0 0 0-4-4h-2.5" />
      <path d="M13 3.5 10.5 6 13 8.5" />
    </svg>
  );
}

export function DockerIcon({ size = 15 }: P) {
  return <svg {...svg} width={size} height={size}><path d="M3 9l9-5 9 5v6l-9 5-9-5z" /><path d="M3 9l9 5 9-5M12 14v6" /></svg>;
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

export function CloseIcon({ size = 15 }: P) {
  return <svg {...svg} width={size} height={size}><path d="M6 6l12 12M18 6L6 18" /></svg>;
}
