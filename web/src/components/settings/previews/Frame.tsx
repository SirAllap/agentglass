import type { CSSProperties, ReactNode } from "react";
import { StatusBadge } from "../../SettingsKit.tsx";

/**
 * The surface tokens are derived from --bg/--bg2/... where index.css defines
 * them on :root, so a theme set on a preview's own root would not reach them.
 * They are declared again here (a test compares them with index.css), so they
 * resolve against the preview's own palette. The card is `--bg2` spelled as a
 * full-strength mix: same colour, and not a direct fill for the surface ratchet.
 */
export const SURFACE_CSS = "[data-preview-scaled],[data-preview-box]{--surface-nav:color-mix(in srgb, var(--bg2) 88%, var(--bg));--surface-card:color-mix(in srgb, var(--bg2) 100%, transparent);--surface-inset:color-mix(in srgb, var(--bg3) 78%, var(--bg2));--surface-line:color-mix(in srgb, var(--border) 60%, transparent);}";

/**
 * A drawn miniature scales with the width it is given: the box is a size
 * container and its text is `width / 56`, so everything inside is written in
 * `em` and nothing has a pixel layout that breaks in the 900 px window.
 * Pieces built from real components (diff, Lantern card, flow) are fluid and
 * sit in a plain `PreviewBox`.
 */
export function Scaled({ children, vars, cols = 56, label }: { children: ReactNode; vars?: CSSProperties; cols?: number; label: string }) {
  return (
    <div data-preview-scaled role="img" aria-label={label} className="min-w-0 w-full" style={{ containerType: "inline-size", ...vars }}>
      <style>{`${SURFACE_CSS}.agx-pv-ic svg{width:1.25em;height:1.25em}`}</style>
      <div style={{ fontSize: `calc(100cqw / ${cols})`, color: "var(--text)" }}>{children}</div>
    </div>
  );
}

/** The wrapper of a preview made of real components: the theme tokens only. */
export function PreviewBox({ children, vars, label }: { children: ReactNode; vars?: CSSProperties; label: string }) {
  return <div data-preview-box aria-label={label} className="min-w-0 w-full flex flex-col gap-3" style={vars}><style>{SURFACE_CSS}</style>{children}</div>;
}

/** The chip a drawn (not real-component) preview carries, so nobody takes it for a capture. */
export function DrawnChip() {
  return <StatusBadge tone="warn">Drawn, not a capture</StatusBadge>;
}

export function PreviewNote({ children }: { children: ReactNode }) {
  return <p className="m-0 text-[11px]" style={{ color: "var(--text3)" }}>{children}</p>;
}
