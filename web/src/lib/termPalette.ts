// The 16-colour ANSI palette a terminal paints its output with.
//
// A theme file (see `themes.ts`) only carries UI colours — one background, a few
// text tones, an accent and the four semantic hues. That was enough for the app
// chrome but left the terminal itself painted in a single hardcoded palette, so
// switching theme changed the panel around the terminal and nothing inside it.
//
// This module closes that gap without asking every theme to hand-author sixteen
// more colours. `deriveAnsi` builds a coherent, legible palette from the colours
// a theme already declares: its four semantic hues ARE its red/green/yellow and
// (usually) its blue, so a theme's real identity comes through for free, and a
// new theme still needs "nothing extra" — the principle themes.ts is built on.
// A theme may still pin an exact `ansi` palette when the canonical one matters
// (Gruvbox, Nord, Solarized, Dracula); `deriveAnsi` is the floor under the rest.

export interface AnsiPalette {
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}

interface RGB { r: number; g: number; b: number }

function parseHex(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
const clamp = (v: number, lo = 0, hi = 255) => Math.max(lo, Math.min(hi, v));
function toHex({ r, g, b }: RGB): string {
  const h = (v: number) => clamp(Math.round(v)).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

// WCAG relative luminance and contrast ratio — used both to tell a light theme
// from a dark one and to keep every colour readable against the background.
function lum({ r, g, b }: RGB): number {
  const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: RGB, b: RGB): number {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

interface HSL { h: number; s: number; l: number }
function rgbToHsl({ r, g, b }: RGB): HSL {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : l > 0.5 ? d / (2 - max - min) : d / (max + min);
  if (d !== 0) {
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h: h * 360, s, l };
}
function hslToRgb(h: number, s: number, l: number): RGB {
  h = (((h % 360) + 360) % 360) / 360;
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const t = (x: number): number => {
    if (x < 0) x += 1; if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return { r: t(h + 1 / 3) * 255, g: t(h) * 255, b: t(h - 1 / 3) * 255 };
}

const hueDist = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const blend = (a: RGB, b: RGB, t: number): RGB => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });

/**
 * Build a 16-colour ANSI palette from a theme's declared colours.
 *
 * The four semantic hues map straight onto the ANSI slots people read most
 * (error→red, success→green, warning→yellow, info→blue/cyan); the two ANSI
 * colours a UI theme never names — a distinct cyan and magenta — are synthesised
 * at fixed target hues but borrow the theme's own saturation and lightness so
 * they sit in the same family. Every colour is then nudged until it clears a
 * minimum contrast against the background, which is exactly what the old fixed
 * palette failed to do on the light themes.
 */
export function deriveAnsi(src: {
  bg: string; text: string; primary: string;
  error: string; success: string; warning: string; info: string;
}): AnsiPalette {
  const bg = parseHex(src.bg) ?? { r: 13, g: 17, b: 23 };
  const text = parseHex(src.text) ?? { r: 200, g: 204, b: 212 };
  const isLight = lum(bg) > 0.4;

  // Push a colour away from the background (lighter on dark themes, darker on
  // light ones) until it is comfortably readable. Chromatic colours get a firm
  // floor; it is capped so it can never invert past mid-grey.
  const legible = (hex: string, min = 2.6): string => {
    const rgb = parseHex(hex); if (!rgb) return hex;
    let { h, s, l } = rgbToHsl(rgb);
    for (let i = 0; i < 24 && contrast(hslToRgb(h, s, l), bg) < min; i++) {
      l += isLight ? -0.035 : 0.035;
      if (l <= 0.02 || l >= 0.98) break;
    }
    return toHex(hslToRgb(h, Math.min(1, s), Math.max(0, Math.min(1, l))));
  };
  // Keep a source colour's saturation and lightness, swap its hue — so a
  // synthesised cyan/magenta matches the theme's vividness and brightness.
  const recolor = (hex: string, hue: number, minS = 0.45): string => {
    const rgb = parseHex(hex); if (!rgb) return toHex(hslToRgb(hue, 0.5, isLight ? 0.4 : 0.65));
    const { s, l } = rgbToHsl(rgb);
    return toHex(hslToRgb(hue, Math.max(s, minS), l));
  };
  const hueOf = (hex: string) => { const rgb = parseHex(hex); return rgb ? rgbToHsl(rgb).h : 0; };
  // A slightly-brighter twin for the "bright" ANSI half (dimmer on light themes).
  const twin = (hex: string): string => {
    const rgb = parseHex(hex); if (!rgb) return hex;
    const { h, s, l } = rgbToHsl(rgb);
    return legible(toHex(hslToRgb(h, s, Math.max(0, Math.min(1, l + (isLight ? -0.1 : 0.12))))), 2.2);
  };

  const infoH = hueOf(src.info), primH = hueOf(src.primary);

  const red = legible(src.error);
  const green = legible(src.success);
  const yellow = legible(src.warning);
  const blue = legible(hueDist(infoH, 220) <= 35 ? src.info : hueDist(primH, 220) <= 35 ? src.primary : recolor(src.info, 220));
  let cyan = legible(hueDist(infoH, 185) <= 22 ? src.info : recolor(src.info, 185));
  const magenta = legible(hueDist(primH, 305) <= 40 ? src.primary : recolor(src.primary, 305));
  // Blue and cyan can both trace back to `info`; keep them apart so a diff or a
  // prompt doesn't paint two "blues".
  if (hueDist(hueOf(blue), hueOf(cyan)) < 16) cyan = legible(recolor(src.info, 182));

  // Neutrals. ANSI black is a dim tone that must still be visible on the
  // background, white is the body text; the two flip roles between light and
  // dark, so they're mixed toward whichever end reads.
  const black = isLight ? toHex(blend(text, bg, 0.12)) : toHex(blend(bg, text, 0.34));
  const white = isLight ? toHex(blend(bg, text, 0.7)) : legible(src.text, 3);
  const brightBlack = isLight ? toHex(blend(text, bg, 0.42)) : toHex(blend(bg, text, 0.55));
  const brightWhite = isLight ? toHex(blend(bg, text, 0.9)) : toHex(blend(text, { r: 255, g: 255, b: 255 }, 0.5));

  return {
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed: twin(red), brightGreen: twin(green), brightYellow: twin(yellow),
    brightBlue: twin(blue), brightMagenta: twin(magenta), brightCyan: twin(cyan), brightWhite,
  };
}

/** Contrast of a foreground hex against a background hex; 1 when either is unparseable. */
export function contrastRatio(fg: string, bg: string): number {
  const a = parseHex(fg), b = parseHex(bg);
  return a && b ? contrast(a, b) : 1;
}
