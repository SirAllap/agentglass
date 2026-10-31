import type { ReactNode } from "react";
import { ICON } from "./iconSize.ts";
// The small panel-header glyphs of the Starboard mockup (16 box, 1.4 stroke,
// currentColor), one per panel. Same stroke style as the workspace set.
const P = { fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const wrap = (size: number, d: ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden focusable="false">{d}</svg>
);
export type SbGlyph = "crew" | "core" | "needs" | "tools" | "cost";
export function SbGlyphIcon({ g, size = ICON.md }: { g: SbGlyph; size?: number }) {
  switch (g) {
    case "crew": return wrap(size, <><circle cx="8" cy="5.4" r="2.4" {...P} /><path d="M3 13.4c.6-2.6 2.6-3.8 5-3.8s4.4 1.2 5 3.8" {...P} /></>);
    case "core": return wrap(size, <><circle cx="8" cy="8" r="2.2" {...P} /><path d="M8 1v3.2M8 11.8V15M1 8h3.2M11.8 8H15" {...P} /></>);
    case "needs": return wrap(size, <><path d="M2.5 13 8 2.6 13.5 13Z" {...P} /><path d="M8 7v3" {...P} /><circle cx="8" cy="11.6" r=".6" fill="currentColor" /></>);
    case "tools": return wrap(size, <path d="M2 8c1.6-3.2 2.8-3.2 4 0s2.4 3.2 4 0 2.4-3.2 4 0" {...P} />);
    case "cost": return wrap(size, <><path d="M8 1.6 12.6 8 8 14.4 3.4 8Z" {...P} /><path d="M8 5.2v5.6" {...P} /></>);
  }
}
