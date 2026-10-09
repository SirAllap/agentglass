/*
 * The rest of the app's marks, drawn rather than typed.
 *
 * Every control that used to be a character — `···`, `+`, `⟳`, `✓`, `▾`, `✦` —
 * is one of these now, for the reason src/nav/icons.tsx gives at length:
 * Android's system font carries no glyph for several of them, and the fallback
 * chain ends at an empty box. The four destinations, the gear, the way back and
 * a few with arguments of their own stay named components in that file; these
 * are the plain ones, in the same 24-unit box and the same stroke, as data.
 */
import Svg, { Circle, Path, Rect } from "react-native-svg";
import type { ColorValue } from "react-native";

const SHAPES = {
  down: <><Path d="M6 9l6 6 6-6" /></>,
  plus: <><Path d="M12 5v14M5 12h14" /></>,
  more: <><Circle cx="12" cy="5.5" r="1.5" fill="currentColor" stroke="none" /><Circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /><Circle cx="12" cy="18.5" r="1.5" fill="currentColor" stroke="none" /></>,
  close: <><Path d="M6 6l12 12M18 6L6 18" /></>,
  check: <><Path d="M5 12.5l4.5 4.5L19 7.5" /></>,
  spark: <><Path d="M11 3.5c.7 4.4 2.8 6.5 7.2 7.2-4.4.7-6.5 2.8-7.2 7.2-.7-4.4-2.8-6.5-7.2-7.2 4.4-.7 6.5-2.8 7.2-7.2z" /><Path d="M18.5 15.2c.3 1.6 1 2.3 2.6 2.6-1.6.3-2.3 1-2.6 2.6-.3-1.6-1-2.3-2.6-2.6 1.6-.3 2.3-1 2.6-2.6z" /></>,
  up: <><Path d="M12 19V5.5M6.5 11 12 5.5l5.5 5.5" /></>,
  refresh: <><Path d="M19.5 12.5a7.5 7.5 0 1 1-2.2-5.8" /><Path d="M19.5 4.5v4h-4" /></>,
  file: <><Path d="M7 3.5h6.5L18 8v12.5H7z" /><Path d="M13.5 3.5V8H18" /></>,
  branch: <><Circle cx="6.5" cy="5.5" r="2.2" /><Circle cx="6.5" cy="18.5" r="2.2" /><Circle cx="17.5" cy="7.5" r="2.2" /><Path d="M6.5 7.7v8.6" /><Path d="M17.5 9.7c0 3.6-3.2 4.4-6.2 4.9-2.3.4-3.9 1-4.5 1.6" /></>,
  commit: <><Circle cx="12" cy="12" r="3.3" /><Path d="M3 12h5.7M15.3 12H21" /></>,
  merge: <><Circle cx="6.5" cy="5.5" r="2.2" /><Circle cx="6.5" cy="18.5" r="2.2" /><Circle cx="17.5" cy="15" r="2.2" /><Path d="M6.5 7.7v8.6" /><Path d="M6.5 7.7c0 4.2 4.3 7.3 8.8 7.3" /></>,
  copy: <><Rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" /><Path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" /></>,
  external: <><Path d="M14 4.5h5.5V10" /><Path d="M19.5 4.5 11 13" /><Path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" /></>,
  bell: <><Path d="M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15z" /><Path d="M10 20.5a2 2 0 0 0 4 0" /></>,
  contrast: <><Circle cx="12" cy="12" r="8.4" /><Path d="M12 3.6a8.4 8.4 0 0 1 0 16.8z" fill="currentColor" stroke="none" /></>,
  wrench: <><Path d="M14.6 6.6a4.2 4.2 0 0 0-5.6 5.4L4 17v3h3l5-5a4.2 4.2 0 0 0 5.4-5.6l-2.7 2.7-2.4-.6-.6-2.4z" /></>,
  info: <><Circle cx="12" cy="12" r="8.4" /><Path d="M12 11v5.2" /><Circle cx="12" cy="7.9" r="1" fill="currentColor" stroke="none" /></>,
  alert: <><Path d="M12 4.2 20.6 19H3.4z" /><Path d="M12 10v4.2" /><Circle cx="12" cy="16.6" r="1" fill="currentColor" stroke="none" /></>,
  clock: <><Circle cx="12" cy="12" r="8.4" /><Path d="M12 7.5V12l3 2" /></>,
  lock: <><Rect x="5" y="10.5" width="14" height="9.5" rx="2" /><Path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5" /></>,
  offline: <><Path d="M3.5 3.5l17 17" /><Path d="M8.7 16.3a4.8 4.8 0 0 1 6.6 0" /><Path d="M5.4 12.9a9.4 9.4 0 0 1 4-2.3" /><Path d="M14.6 10.6a9.4 9.4 0 0 1 4 2.3" /><Circle cx="12" cy="19.6" r="1" fill="currentColor" stroke="none" /></>,
  qr: <><Rect x="4" y="4" width="6" height="6" rx="1" /><Rect x="14" y="4" width="6" height="6" rx="1" /><Rect x="4" y="14" width="6" height="6" rx="1" /><Path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 20h1.5M20 14v1.5" /></>,
  link: <><Path d="M10.3 13.7a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><Path d="M13.7 10.3a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  grip: <><Circle cx="9" cy="7" r="1.3" fill="currentColor" stroke="none" /><Circle cx="15" cy="7" r="1.3" fill="currentColor" stroke="none" /><Circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none" /><Circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none" /><Circle cx="9" cy="17" r="1.3" fill="currentColor" stroke="none" /><Circle cx="15" cy="17" r="1.3" fill="currentColor" stroke="none" /></>,
  filter: <><Path d="M4 5.5h16l-6.2 7.2v5.6l-3.6 1.7v-7.3z" /></>,
  people: <><Circle cx="9" cy="8.5" r="3.2" /><Path d="M3.5 19.5c.4-3.3 2.7-5 5.5-5s5.1 1.7 5.5 5" /><Path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.8c1.7.6 2.8 2.2 3 4.7" /></>,
  search: <><Circle cx="11" cy="11" r="6.5" /><Path d="M16 16l4.5 4.5" /></>,
  computer: <><Rect x="3" y="4.5" width="18" height="12" rx="2" /><Path d="M8.5 20h7M12 16.5V20" /></>,
  comment: <><Path d="M5 5.5h14A1.5 1.5 0 0 1 20.5 7v8a1.5 1.5 0 0 1-1.5 1.5h-8.5l-4.5 3.5v-3.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5z" /></>,
  eye: <><Path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" /><Circle cx="12" cy="12" r="2.8" /></>,
  "x_circle": <><Circle cx="12" cy="12" r="8.4" /><Path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" /></>,
  "ok_circle": <><Circle cx="12" cy="12" r="8.4" /><Path d="M8.3 12.3l2.6 2.6 4.9-5.2" /></>,
  "run_circle": <><Circle cx="12" cy="12" r="8.4" opacity={0.35} /><Path d="M12 3.6a8.4 8.4 0 0 1 8.4 8.4" /></>,
  circle: <><Circle cx="12" cy="12" r="8.4" /></>,
  "draft_circle": <><Circle cx="12" cy="12" r="8.4" /><Path d="M8.5 12h7" /></>,
  trash: <><Path d="M5 7h14" /><Path d="M9.5 7V5h5v2" /><Path d="M7 7l1 13h8l1-13" /></>,
  window: <><Rect x="3.5" y="5" width="17" height="14" rx="2" /><Path d="M3.5 9h17" /></>,
  shield: <><Path d="M12 3.5l7 3v5.4c0 4.4-3 7.5-7 9.1-4-1.6-7-4.7-7-9.1V6.5z" /></>,
  history: <><Path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" /><Path d="M4.5 4.5v3.7h3.7" /><Path d="M12 8v4.3l2.8 1.7" /></>,
  expand: <><Path d="M12 4v5M9.5 6.5 12 4l2.5 2.5M12 20v-5M9.5 17.5 12 20l2.5-2.5" /></>,
  fit: <><Path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" /></>,
  wrap: <><Path d="M4 6.5h16M4 12h11.5a3 3 0 0 1 0 6H11" /><Path d="M13.5 15.5 11 18l2.5 2.5M4 18h3" /></>,
  type: <><Path d="M5 6.5V5h14v1.5M12 5v14M9.5 19h5" /></>,
  pin: <><Path d="M9 4.5h6l-1 5 3 3v1.5H7V12.5l3-3z" /><Path d="M12 14v6" /></>,
  sliders: <><Path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><Circle cx="15" cy="7" r="2" /><Circle cx="9" cy="17" r="2" /></>,
  bot: <><Rect x="5" y="8.5" width="14" height="10.5" rx="3" /><Path d="M12 8.5V5" /><Circle cx="12" cy="4.2" r="1.1" fill="currentColor" stroke="none" /><Circle cx="9.2" cy="13.5" r="1.1" fill="currentColor" stroke="none" /><Circle cx="14.8" cy="13.5" r="1.1" fill="currentColor" stroke="none" /></>,
  tag: <><Path d="M3.5 4.5h7.6l9 9a1.5 1.5 0 0 1 0 2.1l-4.5 4.5a1.5 1.5 0 0 1-2.1 0l-9-9z" /><Circle cx="8" cy="9" r="1.2" fill="currentColor" stroke="none" /></>,
  camera: <><Path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" /></>,
  list: <><Path d="M8.5 6.5H20M8.5 12H20M8.5 17.5H20" /><Circle cx="4.6" cy="6.5" r="1" fill="currentColor" stroke="none" /><Circle cx="4.6" cy="12" r="1" fill="currentColor" stroke="none" /><Circle cx="4.6" cy="17.5" r="1" fill="currentColor" stroke="none" /></>,
  folder: <><Path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2.2h8A1.5 1.5 0 0 1 20.5 9.2V17a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17z" /></>,
  pr: <><Circle cx="6.5" cy="5.5" r="2.2" /><Circle cx="6.5" cy="18.5" r="2.2" /><Circle cx="17.5" cy="18.5" r="2.2" /><Path d="M6.5 7.7v8.6" /><Path d="M17.5 16.3v-5.8A3.5 3.5 0 0 0 14 7h-2.5M14 4.5 11.5 7 14 9.5" /></>,
} as const;

export type GlyphName = keyof typeof SHAPES;

export function Glyph({ name, color, size = 20, weight = 2.1 }: {
  name: GlyphName;
  color: ColorValue;
  size?: number;
  /** In the viewBox's units: 2.1 is 1.75px of ink at 20px. */
  weight?: number;
}): React.ReactNode {
  return (
    <Svg
      width={size} height={size} viewBox="0 0 24 24" color={color}
      fill="none" stroke="currentColor" strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round"
    >
      {SHAPES[name]}
    </Svg>
  );
}
