/*
 * The state a container is in, drawn: a glyph in the row, a square in the map.
 * Colour, shape and word always come together (KINDS in dockerState.ts), so the
 * state survives a colour-blind reader and a screen reader alike.
 */
import type { CSSProperties, ReactNode } from "react";
import { KINDS, type ContainerKind } from "../../lib/dockerState.ts";
import { SQUARE_TONE } from "../../lib/dockerTriage.ts";

const DRAW: Record<string, (tone: string) => ReactNode> = {
  dot: (t) => <circle cx="8" cy="8" r="6" fill={t} />,
  "dot-check": (t) => (<>
    <circle cx="8" cy="8" r="6" fill={t} />
    <path d="m5.2 8.2 1.9 1.9 3.7-3.9" stroke="var(--bg)" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </>),
  triangle: (t) => (<>
    <path d="M8 1.6 15 14H1z" fill={t} stroke={t} strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M8 6.2v3.4M8 11.8h.01" stroke="var(--bg)" strokeWidth="1.8" strokeLinecap="round" />
  </>),
  spinner: (t) => (
    <g className="dk-spin">
      <circle cx="8" cy="8" r="5.6" fill="none" stroke={`color-mix(in srgb, ${t} 25%, transparent)`} strokeWidth="2.4" />
      <path d="M8 2.4a5.6 5.6 0 0 1 5.6 5.6" fill="none" stroke={t} strokeWidth="2.4" strokeLinecap="round" />
    </g>
  ),
  pause: (t) => (<>
    <rect x="3.5" y="3" width="3" height="10" rx="1" fill={t} />
    <rect x="9.5" y="3" width="3" height="10" rx="1" fill={t} />
  </>),
  ring: (t) => <circle cx="8" cy="8" r="5.4" fill="none" stroke={t} strokeWidth="1.8" />,
  "ring-dashed": (t) => <circle cx="8" cy="8" r="5.4" fill="none" stroke={t} strokeWidth="1.8" strokeDasharray="2.4 2" />,
  "ring-x": (t) => (<>
    <circle cx="8" cy="8" r="5.6" fill="none" stroke={t} strokeWidth="1.8" />
    <path d="m5.8 5.8 4.4 4.4M10.2 5.8l-4.4 4.4" stroke={t} strokeWidth="1.8" strokeLinecap="round" />
  </>),
  "square-x": (t) => (<>
    <rect x="2" y="2" width="12" height="12" rx="3" fill={t} />
    <path d="m5.5 5.5 5 5M10.5 5.5l-5 5" stroke="var(--bg)" strokeWidth="1.8" strokeLinecap="round" />
  </>),
};

/** Just the drawing, for a place that sets its own size (a chip names the container in the same shape). */
export function GlyphSvg({ kind }: { kind: ContainerKind }) {
  const k = KINDS[kind];
  return <svg viewBox="0 0 16 16" aria-hidden>{DRAW[k.shape]!(k.tone)}</svg>;
}

export function Glyph({ kind }: { kind: ContainerKind }) {
  const k = KINDS[kind];
  return (
    <span className="dk-g" role="img" aria-label={k.word} title={k.word}>
      <GlyphSvg kind={kind} />
    </span>
  );
}

/** One square in the map or a stack's header. A button only when it has somewhere to go. */
export function Square({ kind, small, dim, current, title, onPick }: {
  kind: ContainerKind; small?: boolean; dim?: boolean; current?: boolean; title?: string; onPick?: () => void;
}) {
  const tone = SQUARE_TONE[kind];
  const inner = kind === "dead"
    ? <svg viewBox="0 0 10 10" aria-hidden><path d="m3 3 4 4M7 3 3 7" /></svg>
    : tone === "need"
      ? <svg viewBox="0 0 10 10" aria-hidden><path d="M5 2v3.4M5 8h.01" /></svg>
      : kind === "paused"
        ? <svg viewBox="0 0 10 10" aria-hidden style={{ strokeWidth: 1.8 }}><path d="M3.5 2.5v5M6.5 2.5v5" /></svg>
        : null;
  const attrs = {
    className: "dk-q", "data-t": tone, "data-sq": kind, "data-small": small || undefined, "data-dim": dim || undefined, "data-current": current || undefined,
    title,
  };
  return onPick
    ? <button type="button" {...attrs} aria-label={title} onClick={onPick}>{inner}</button>
    : <i {...attrs}>{inner}</i>;
}

/** The mockup's badge: 16px, 10px type, a 28% edge in its own tint. */
export function Badge({ tint, title, children }: { tint: string; title?: string; children: ReactNode }) {
  return <span className="dk-badge" style={{ "--tint": tint } as CSSProperties} title={title}>{children}</span>;
}

/** "Opens outside": the box with an arrow, as the port chip and the Ports fact draw it. */
export function ExtIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 2.5h4.5V7M13.5 2.5L7 9M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
    </svg>
  );
}

/** The container itself: the mockup's box, drawn on a 16 grid. */
export function CubeIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 5.5L8 2.5l5.5 3v5L8 13.5l-5.5-3ZM2.5 5.5L8 8.5l5.5-3M8 8.5v5" />
    </svg>
  );
}
