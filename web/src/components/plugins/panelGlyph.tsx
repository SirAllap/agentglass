import { ICON } from "../../lib/iconSize.ts";
import type { CanvasIcon } from "../../../../shared/pluginCanvas.ts";

/**
 * The icon a panel names in its manifest, drawn from this set and no other
 * (PANEL_ICONS in shared/pluginUi.ts). A plugin picks a word; it cannot ship
 * an image, so every tab in the Plugins view is drawn in the same hand.
 */
const svg = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const PATHS: Record<string, React.ReactNode> = {
  puzzle: <path d="M5 7.2h3.7a2.3 2.3 0 1 1 4.6 0H17v3.7a2.3 2.3 0 1 1 0 4.6v3.7h-3.7a2.3 2.3 0 1 0-4.6 0H5v-3.7a2.3 2.3 0 1 0 0-4.6z" />,
  review: <><path d="M4 5h16v11H9l-5 4z" /><path d="M8.5 10.5l2 2 4-4" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  chart: <><path d="M4 20V4" /><path d="M4 20h16" /><path d="M8 16v-5" /><path d="M12 16V8" /><path d="M16 16v-3" /></>,
  list: <><path d="M9 6h11" /><path d="M9 12h11" /><path d="M9 18h11" /><circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" /></>,
  bell: <><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></>,
  bug: <><rect x="7" y="7" width="10" height="13" rx="5" /><path d="M12 7V4" /><path d="M4 12h3" /><path d="M17 12h3" /><path d="M5 18l2.5-1.5" /><path d="M19 18l-2.5-1.5" /></>,
  book: <><path d="M5 4h9a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4z" /><path d="M5 16a4 4 0 0 1 4-4h9" /></>,
  bolt: <path d="M13 3L5 13.5h6L10 21l8-10.5h-6z" />,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.5" /></>,
};

export function PanelGlyph({ icon, size = ICON.md }: { icon?: string; size?: number }) {
  return (
    <svg {...svg} width={size} height={size} aria-hidden>
      {PATHS[icon ?? "puzzle"] ?? PATHS.puzzle}
    </svg>
  );
}

/**
 * The words a live canvas may name as an icon (CANVAS_ICONS in
 * shared/pluginCanvas.ts), each drawn here in the same hand as the panel
 * glyphs. Typed over the whole list, so a word added there without a drawing
 * here does not compile.
 */
const CANVAS_PATHS: Record<CanvasIcon, React.ReactNode> = {
  dot: <circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none" />,
  lock: <><rect x="5.5" y="10.5" width="13" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>,
  unlock: <><rect x="5.5" y="10.5" width="13" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.6-1.6" /></>,
  check: PATHS.check!,
  cross: <><path d="M6.5 6.5l11 11" /><path d="M17.5 6.5l-11 11" /></>,
  bolt: PATHS.bolt!,
  alert: <><path d="M12 4l9 15.5H3z" /><path d="M12 10v4" /><path d="M12 17v.01" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  eye: PATHS.eye!,
  database: <><ellipse cx="12" cy="6" rx="7" ry="2.8" /><path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6" /><path d="M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8" /></>,
  shield: <path d="M12 3.5l7 2.5v5.5c0 4.2-2.8 7.4-7 9-4.2-1.6-7-4.8-7-9V6z" />,
  arrow: <><path d="M4.5 12h15" /><path d="M13.5 6l6 6-6 6" /></>,
  gate: <><path d="M5 20V5" /><path d="M19 20V5" /><path d="M5 9h14" /><path d="M5 15h14" /></>,
  spark: <path d="M12 3.5l2 6.5 6.5 2-6.5 2-2 6.5-2-6.5-6.5-2 6.5-2z" />,
};

export function CanvasGlyph({ icon, size = ICON.md }: { icon: CanvasIcon; size?: number }) {
  return (
    <svg {...svg} width={size} height={size} aria-hidden>
      {CANVAS_PATHS[icon] ?? CANVAS_PATHS.dot}
    </svg>
  );
}
