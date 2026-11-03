/*
 * The glyphs the Flow screens draw: the approved mockup's own symbols, ported
 * onto its 24-unit grid and its 1.8 stroke. `FLOW_ICONS` in shared/flow.ts is
 * the closed list a role may choose from.
 */
import type { ReactNode } from "react";
import { FLOW_ICON_WAS } from "../../../../../shared/flow.ts";

export const FLOW_GLYPHS: Record<string, ReactNode> = {
  users: <><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.4 2.7-5.5 6-5.5s6 2.1 6 5.5"/><circle cx="17" cy="9" r="2.4"/><path d="M17 14.5c2.4 0 4 1.5 4 4"/></>,
  loop: <><path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3"/><path d="M18 3v4h-4M6 21v-4h4"/></>,
  gauge: <><path d="M4 18a9 9 0 1 1 16 0"/><path d="M12 14l4-5"/></>,
  shield: <><path d="M12 3l8 3v6c0 4.6-3.2 7.7-8 9-4.8-1.3-8-4.4-8-9V6z"/></>,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></>,
  check: <><path d="M5 12.5l4.5 4.5L19 7.5"/></>,
  x: <><path d="M6 6l12 12M18 6L6 18"/></>,
  chev: <><path d="M6 9l6 6 6-6"/></>,
  plus: <><path d="M12 5v14M5 12h14"/></>,
  minus: <><path d="M5 12h14"/></>,
  back: <><path d="M15 6l-6 6 6 6"/></>,
  dots: <><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></>,
  hand: <><path d="M8 12V6a1.6 1.6 0 0 1 3.2 0v5M11.2 11V4.6a1.6 1.6 0 0 1 3.2 0V11M14.4 11V6a1.6 1.6 0 0 1 3.2 0v8c0 4-2.4 6-6 6-3 0-4.6-1.6-6-4l-1.4-2.6a1.5 1.5 0 0 1 2.4-1.7L8 14"/></>,
  eye: <><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/></>,
  compass: <><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/></>,
  hammer: <><path d="M14 7l3 3M4 20l8-8M12 5l7 7-3 3-7-7z"/></>,
  flag: <><path d="M6 21V4M6 5h11l-2 4 2 4H6"/></>,
  pin: <><path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v8"/></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></>,
  key: <><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/></>,
  layers: <><path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5"/></>,
  note: <><path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h5"/></>,
  tag: <><path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.2"/></>,
  grid: <><rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/></>,
  fit: <><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></>,
  search: <><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></>,
  play: <><path d="M7 4l13 8-13 8z"/></>,
  stop: <><rect x="6" y="6" width="12" height="12" rx="2"/></>,
  drag: <><circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/></>,
  gear: <><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></>,
  alert: <><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.1"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  undo: <><path d="M9 7L4 12l5 5M4 12h10a6 6 0 0 1 0 12"/></>,
  hub: <><circle cx="12" cy="12" r="8.200"/><circle cx="12" cy="12" r="3.200" fill="currentColor" stroke="none"/><circle cx="12" cy="3.800" r="2" fill="currentColor" stroke="var(--accent, var(--primary))" strokeWidth={1.4}/><circle cx="4.900" cy="16.100" r="2" fill="currentColor" stroke="var(--accent, var(--primary))" strokeWidth={1.4}/><circle cx="19.100" cy="16.100" r="2" fill="currentColor" stroke="var(--accent, var(--primary))" strokeWidth={1.4}/></>,
  chart: <><circle cx="5" cy="17" r="1.6"/><circle cx="10" cy="8" r="1.6"/><circle cx="16" cy="13" r="1.6"/><circle cx="20" cy="5" r="1.6"/><path d="M6 15.6l3.2-6M11.4 8.8l3.4 3M17.3 12l2.2-5"/></>,
  rover: <><path d="M5 14h14l-1.6-4.5H8L5 14zM11 9.5V5l3.5-1.5M3 17.5h2M19 17.5h2"/><circle cx="7.5" cy="17.5" r="2.2"/><circle cx="16.5" cy="17.5" r="2.2"/></>,
  lens: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M10.5 7.4l.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9z"/></>,
  preflight: <><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2.8h6V4M8.5 10.5l1.6 1.6 3-3.2M8.5 16.5h7"/></>,
  lander: <><path d="M8 11a4 4 0 0 1 8 0v3H8zM8 14l-3.5 6M16 14l3.5 6M3 20h4M17 20h4M12 7V3M10.5 3h3"/></>,
  beaker: <><path d="M9 3h6M10 3v6l-5 9.5A1.5 1.5 0 0 0 6.300 21h11.400a1.500 1.500 0 0 0 1.300-2.500L14 9V3M7.800 15h8.400"/></>,
  shieldstar: <><path d="M12 3l7.500 3v5.500c0 4.500-3.100 7.800-7.500 9.500-4.400-1.700-7.500-5-7.500-9.500V6z"/><path d="M12 8.500l1.200 2.500 2.700.4-2 1.900.5 2.700-2.400-1.300-2.400 1.300.5-2.700-2-1.900 2.700-.4z"/></>,
  dish: <><path d="M4 13a8 8 0 0 0 8 8M4 13l6-6 6 6M10 7l-1-3.500M7 16a5.500 5.500 0 0 0 5 3M15.500 4.500a6 6 0 0 1 4 4M14.500 7.500a3 3 0 0 1 2 2"/></>,
  logbook: <><path d="M5 4.500A1.500 1.500 0 0 1 6.500 3H19v16H6.500A1.500 1.500 0 0 0 5 20.500zM5 20.500A1.500 1.500 0 0 0 6.500 22H19v-3M12 7.500l.8 1.800 1.900.2-1.400 1.300.4 1.900-1.700-1-1.700 1 .4-1.900-1.400-1.300 1.900-.2z"/></>,
  dock: <><circle cx="12" cy="12" r="3"/><path d="M4 12h5M15 12h5M12 4v5M12 15v5M7 7l2.200 2.200M14.800 14.800L17 17M17 7l-2.200 2.200M9.200 14.800L7 17"/></>,
  star: <><path d="M12 3l2.600 5.600 6 .7-4.500 4.100 1.300 6L12 16.400 6.600 19.400l1.300-6L3.400 9.300l6-.7z"/></>,
  rocket: <><path d="M12 3c3.500 2.500 4.500 6.500 4 11l-2 2h-4l-2-2c-.5-4.500.5-8.500 4-11z"/><circle cx="12" cy="10" r="1.600"/><path d="M8 14l-2.500 2.500V20L9 18M16 14l2.500 2.500V20L15 18M12 17v4"/></>,
  planet: <><circle cx="12" cy="12" r="5"/><path d="M3.500 16c-1-1.600 2-4.600 7-6.600s9.500-2.400 10.500-.8M20.500 8c1 1.600-2 4.600-7 6.600"/></>,
  comet: <><circle cx="16.500" cy="7.500" r="3.200"/><path d="M14 10L4 20M12.500 8.500L3.500 13M15.500 11.500L11 20.500"/></>,
  moon: <><path d="M19 14.500A8 8 0 0 1 9.500 5 8 8 0 1 0 19 14.500z"/><path d="M16 4v3M14.500 5.500h3"/></>,
  telescope: <><path d="M3.500 11l12-4.500 1.800 4.800-12 4.500zM13 8l1.400 3.800M10.500 15.500L8 21M12 14.500l3.500 6.500"/></>,
  satellite: <><rect x="9.500" y="9.500" width="5" height="5" rx="1" transform="rotate(45 12 12)"/><path d="M5.500 5.500l3 3M15.500 15.500l3 3M3 9l6-6M15 21l6-6M4 4l-1 3 3-1M20 20l1-3-3 1"/></>,
  radar: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12l6.400-6.400"/><circle cx="12" cy="12" r="1" fill="currentColor"/></>,
  lantern: <><path d="M9 3h6M10 3v2.500M14 3v2.500M7.500 8.500A3 3 0 0 1 10.500 5.500h3a3 3 0 0 1 3 3V17a3 3 0 0 1-3 3h-3a3 3 0 0 1-3-3z"/><path d="M12 9.500c1.500 1.300 2 3 .6 4.500-.5.500-1.700.5-2.200-.2-.7-1 0-2.500 1.600-4.300zM9 21h6"/></>,
  bug: <><path d="M8.500 8.500a3.500 3.500 0 0 1 7 0v6a3.500 3.500 0 0 1-7 0zM12 8.500V19M8.500 12H4.500M15.500 12h4M9 6L6.500 3.500M15 6l2.500-2.500M8.500 16.500l-3 2M15.500 16.500l3 2"/></>,
  bolt: <><path d="M13 3L5.500 13.500H11L10 21l8-11h-5.500z"/></>,
  database: <><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.700 3.100 3 7 3s7-1.300 7-3V6M5 12v6c0 1.700 3.100 3 7 3s7-1.300 7-3v-6"/></>,
  terminal: <><rect x="3" y="4.500" width="18" height="15" rx="3"/><path d="M7 10l3 2.500L7 15M12.500 15H17"/></>,
  branch: <><circle cx="6.500" cy="5.500" r="2"/><circle cx="6.500" cy="18.500" r="2"/><circle cx="17.500" cy="8.500" r="2"/><path d="M6.500 7.500v9M17.500 10.500c0 4-4 4-9.500 6"/></>,
  hourglass: <><path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9"/></>,
  spark: <><path d="M12 3c.6 4.800 2.200 6.400 7 7-4.800.6-6.400 2.200-7 7-.6-4.800-2.200-6.400-7-7 4.800-.6 6.400-2.200 7-7zM18.500 16.500l.5 1.500 1.500.5-1.500.5-.5 1.500-.5-1.500-1.500-.5 1.500-.5z"/></>,

  // The two the mockup draws no symbol for and the app needs.
  info: <><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" /><path d="M12 11v5M12 8h.01" /></>,
  up: <path d="M18 15l-6-6-6 6" />,
};

/** A name the table does not draw falls back to the old name it replaced, and
 *  only then to `info`: a role saved before the mockup's set still reads. */
/** The UI glyph names this table used before the mockup's set replaced it, so a caller still
 *  writing one paints the nearest drawn glyph, never the info fallback. A saved ROLE icon is
 *  normalised by `flowIconName` before it gets here, so the two old maps never meet. */
const UI_WAS: Record<string, string> = {
  left: "back", reset: "undo", menu: "dots", bot: "users", warn: "alert", grip: "drag", flow: "hub", panes: "grid", wrench: "hammer",
};

export function FlowIcon({ name, size = 12 }: { name: string; size?: number }) {
  const glyph = FLOW_GLYPHS[name] ?? FLOW_GLYPHS[UI_WAS[name] ?? FLOW_ICON_WAS[name] ?? ""] ?? FLOW_GLYPHS.info;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {glyph}
    </svg>
  );
}
