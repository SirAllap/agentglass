/**
 * The palette the launch cover paints its first frame in.
 *
 * The cover is drawn before the bundle has arrived, so it cannot ask the theme
 * list what "the user's theme" is — THEMES is in the bundle. What it can do is
 * read a copy: every time a theme is painted, applyTheme leaves the variables
 * it set here, and web/index.html's boot script puts them back on the root
 * before the first element of the page exists. The first frame is already the
 * app's palette, and when applyTheme runs a moment later it sets the same
 * values over themselves.
 *
 * "System" is the one choice a copy of the last paint can get wrong: the OS may
 * have gone from dark to light while the app was closed. So a system choice
 * carries both of its answers and the boot script asks the OS which one, the
 * way initialTheme() is about to.
 *
 * The desktop's own palette needs nothing extra: the app paints the last one it
 * saw until the desktop answers (themes.ts), and so does this.
 */
export const BOOT_PAINT_KEY = "agentglass-boot-paint";

export interface BootPaintEntry {
  id: string;
  /** Whether --bg is dark: the cover tones its glow and stars down on light. */
  dark: boolean;
  vars: Record<string, string>;
}

export interface BootPaint extends BootPaintEntry {
  v: 1;
  /** Present only while the mode is "system": both answers, for the OS to pick. */
  system?: { dark: BootPaintEntry; light: BootPaintEntry };
}

/** Dark by the luminance of the background, the rule isDarkTheme uses. */
export function bgIsDark(bg: string | undefined): boolean {
  const hex = (bg ?? "").trim().replace("#", "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(full)) return true;
  const n = parseInt(full, 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) < 128;
}

/** One entry, from the variables a paint set. */
export function bootEntry(id: string, vars: Record<string, string>): BootPaintEntry {
  return { id, dark: bgIsDark(vars["--bg"]), vars };
}

let written = "";
/** Leave `p` for the next launch. False when it is what is already there —
 *  applyTheme runs on every repaint, and most repaints change nothing. */
export function writeBootPaint(p: BootPaint): boolean {
  const json = JSON.stringify(p);
  if (json === written) return false;
  written = json;
  try { localStorage.setItem(BOOT_PAINT_KEY, json); } catch { /* private mode: the cover falls back to the default palette */ }
  return true;
}
