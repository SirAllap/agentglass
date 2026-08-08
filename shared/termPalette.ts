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
//
// ── why this is in shared/ and not in web/src/lib ────────────────────────────
// Because the phone grew a terminal, and it had written its own map: palette
// field to ANSI slot, one to one, with no notion of light or dark. Measured
// against the two bases in palettes.ts, that map produced
//
//   black        #21262d   1.24:1 on the dark base, 1.17:1 on white — INVISIBLE
//   cyan         the same hex as blue
//   brightWhite  the same hex as white
//   → ten distinct colours out of sixteen slots
//
// and it had to, because a palette carries four hues and a terminal needs six.
// The desk has not had that problem since `deriveAnsi` landed: it branches on
// the background's luminance and answers sixteen distinct colours for the same
// two palettes. A phone may not have its own idea of what red means in a
// terminal — that is one product showing one machine's screens — so the rule
// moves here rather than being copied, the way sessionTitle did (86b07f7) and
// the palettes themselves did. web/src/lib/termPalette.ts is now a re-export.

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
 * The contrast every colour in here is held to: WCAG's floor for normal text.
 *
 * It was 2.6 for the base half and 2.2 for the bright half, and those numbers
 * are what "the light terminal is unreadable" was made of. Measured on white,
 * before: cyan 2.85:1, magenta 3.14, brightMagenta 3.54, brightBlack 4.02 —
 * every one of them a colour somebody has to read a filename in.
 *
 * Saturated hues on white are low-contrast by physics, so a theme's own red is
 * simply not usable at its own lightness there; this is the number that makes
 * the derivation darken it instead of shipping it. GitHub Light does the same
 * thing by hand — its terminal cyan is #1b7c83, not the #08a9b8 its UI uses.
 */
const FLOOR = 4.5;
/**
 * ANSI black on a DARK background is the one exception, and it is deliberate.
 *
 * Programs paint black when they mean "recede": box rules, dimmed diff context,
 * an inactive tab. Holding it to 4.5 on a dark background makes it a mid-grey —
 * at which point it is brightBlack, and the palette has fifteen colours and two
 * names for one of them. It stays visible (2.8:1 on the dark base, against the
 * 1.24:1 the phone's own map gave it) and it stays the dimmest thing on screen.
 * On a LIGHT background black is the ink rather than the dim tone, so it takes
 * the full floor like everything else.
 */
const BLACK_ON_DARK = 2.6;
/**
 * The bright half's own floor, and it exists to keep the twins off their bases.
 *
 * Raising the floor to 4.5 collapsed them: measured on white, magenta and
 * brightMagenta both bottomed out at #d50ac4, because two lightnesses a tenth
 * apart were pushed to the same number. Sixteen slots and fifteen colours is a
 * palette that cannot show a diff.
 *
 * A floor rather than a multiple of the base's contrast, which was tried first
 * and is worse: cyan on the dark base sits at 13.92:1 on its own, and 1.25 of
 * that drove brightCyan to #d9fcff — a colour that is white with a memory of
 * blue. A colour already far from the background does not need pushing; only a
 * colour standing ON the floor does.
 */
const BRIGHT_FLOOR = 5.6;
/** Lightness never reaches its rail: at l≈0 two different hues both round to
 *  #000000, which is the same collapse from the other end. */
const L_MIN = 0.06, L_MAX = 0.94;

/**
 * Build a 16-colour ANSI palette from a theme's declared colours.
 *
 * The four semantic hues map straight onto the ANSI slots people read most
 * (error→red, success→green, warning→yellow, info→blue/cyan); the two ANSI
 * colours a UI theme never names — a distinct cyan and magenta — are synthesised
 * at fixed target hues but borrow the theme's own saturation and lightness so
 * they sit in the same family. Every colour is then moved until it clears the
 * floor above against the background, which is exactly what the old fixed
 * palette failed to do on the light themes.
 */
export function deriveAnsi(src: {
  bg: string; text: string; primary: string;
  error: string; success: string; warning: string; info: string;
}): AnsiPalette {
  const bg = parseHex(src.bg) ?? { r: 13, g: 17, b: 23 };
  const text = parseHex(src.text) ?? { r: 200, g: 204, b: 212 };
  const isLight = lum(bg) > 0.4;

  /** Contrast of a colour as it will actually be WRITTEN — quantised to eight
   *  bits per channel first. Bisecting on the continuous value and rounding
   *  afterwards lands a colour a hundredth under the floor it was aimed at. */
  const ratioAt = (h: number, s: number, l: number): number =>
    contrast(parseHex(toHex(hslToRgb(h, s, l))) ?? bg, bg);

  /*
   * Push a colour away from the background — lighter on a dark theme, darker on
   * a light one — until it clears `min`, and NO FURTHER.
   *
   * By bisection, not in steps of 0.035 of lightness as this used to walk. The
   * step version overshot by up to a whole step on every colour it moved, and on
   * a light background that is the difference between a cyan and a slate: at the
   * floor the answer is #06838f, two hundredths of lightness off GitHub Light's
   * hand-picked #1b7c83, where the walk would have gone past it. Contrast is
   * monotone in lightness on either side of a background, so the bisection is
   * exact rather than a search.
   *
   * Only the lightness moves. Saturation is the theme's statement about how
   * vivid it is and lightness is the axis contrast actually lives on: measured
   * on white, dropping cyan's saturation by a fifth bought 0.02 of ratio, while
   * a tenth of lightness bought 1.6.
   */
  const legible = (hex: string, min = FLOOR): string => {
    const rgb = parseHex(hex); if (!rgb) return hex;
    // Verbatim when it already reads. A theme's own #58a6ff comes back as
    // #58a6ff and not as whatever an HSL round trip rounds it to, and a colour
    // that clears the floor at l=0.96 is not dragged down to the search rail.
    if (contrast(rgb, bg) >= min) return hex;
    const { h, s } = rgbToHsl(rgb);
    const l0 = Math.max(L_MIN, Math.min(L_MAX, rgbToHsl(rgb).l));
    // The rail is the best this hue can do against this background. A mid-grey
    // background genuinely cannot carry 4.5:1 in any colour, and answering with
    // the closest thing beats answering with nothing.
    const rail = isLight ? L_MIN : L_MAX;
    if (ratioAt(h, s, rail) < min) return toHex(hslToRgb(h, s, rail));
    let near = l0, far = rail;
    for (let i = 0; i < 20; i++) {
      const mid = (near + far) / 2;
      if (ratioAt(h, s, mid) >= min) far = mid; else near = mid;
    }
    return toHex(hslToRgb(h, s, far));
  };
  /*
   * Keep a source colour's saturation and lightness, swap its hue — so a
   * synthesised cyan/magenta matches the theme's vividness and brightness.
   *
   * The lightness comes back off the rails first, because a hue does not exist
   * there: at l=1 every hue is #ffffff and at l=0 every hue is #000000. Two
   * shipped themes name a pure white or a pure black as their primary — and so
   * does this phone's "neutral" accent, which is the page's own ink — and each
   * of them was synthesising a magenta that came out identical to the text.
   * Measured before this line: high-contrast-dark had thirteen distinct colours
   * in sixteen slots, with magenta, white, brightMagenta and brightWhite all
   * #ffffff, so a magenta diff and a plain line were the same colour.
   */
  const recolor = (hex: string, hue: number, minS = 0.45): string => {
    const rgb = parseHex(hex); if (!rgb) return toHex(hslToRgb(hue, 0.5, isLight ? 0.4 : 0.65));
    const { s, l } = rgbToHsl(rgb);
    return toHex(hslToRgb(hue, Math.max(s, minS), Math.max(L_MIN, Math.min(L_MAX, l))));
  };
  const hueOf = (hex: string) => { const rgb = parseHex(hex); return rgb ? rgbToHsl(rgb).h : 0; };
  const ratioOf = (hex: string) => { const rgb = parseHex(hex); return rgb ? contrast(rgb, bg) : 1; };
  /*
   * The bright twin: the same colour, one step further from the background.
   *
   * Further OUT and not merely lighter, which is the same thing on a dark theme
   * and the opposite of it on a light one — bright red on white is #a31b24, a
   * deeper red, because there is nowhere brighter for it to go. The floor it is
   * held to is its base's contrast times BRIGHT, so raising the base cannot
   * swallow the twin.
   */
  const twin = (hex: string): string => {
    const rgb = parseHex(hex); if (!rgb) return hex;
    const { h, s, l } = rgbToHsl(rgb);
    // Held off the rails like everything else: a twin shifted to l=1 is #ffffff
    // whatever hue it started as, which is how brightMagenta ended up painting
    // the same colour as brightWhite on the black theme.
    const shifted = toHex(hslToRgb(h, s, Math.max(L_MIN, Math.min(L_MAX, l + (isLight ? -0.1 : 0.12)))));
    const out = legible(shifted, BRIGHT_FLOOR);
    // Both at the same rail: the base was already as far out as this hue goes,
    // so the twin separates by saturation instead. Anything is better than two
    // slots painting one colour.
    if (out.toLowerCase() !== hex.toLowerCase()) return out;
    const { l: railL } = rgbToHsl(parseHex(out)!);
    return toHex(hslToRgb(h, Math.max(0, s - 0.2), railL));
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

  /*
   * Neutrals. ANSI black is the dim tone and white is the body text, and the two
   * flip roles between light and dark — so they are mixed toward whichever end
   * reads and then held to the same floor as everything else.
   *
   * The blends are where they were; what is new is that they are a starting
   * point rather than the answer. brightBlack on white came out at 4.02:1 from
   * a blend factor somebody picked by eye, which is a legible-looking grey that
   * is not legible.
   */
  const black = isLight
    ? legible(toHex(blend(text, bg, 0.12)))
    : legible(toHex(blend(bg, text, 0.34)), BLACK_ON_DARK);
  let white = isLight ? legible(toHex(blend(bg, text, 0.7))) : legible(src.text);
  const brightBlack = legible(isLight ? toHex(blend(text, bg, 0.42)) : toHex(blend(bg, text, 0.55)));
  const brightWhite = isLight
    ? legible(toHex(blend(bg, text, 0.9)))
    : legible(toHex(blend(text, { r: 255, g: 255, b: 255 }, 0.5)));
  // A theme whose text is ALREADY #ffffff has nowhere brighter to put
  // brightWhite, so the two slots came back the same hex — high-contrast-dark
  // again. The emphatic one keeps the text's own colour and the ordinary one
  // steps back towards the background, which is the direction that reads.
  if (brightWhite.toLowerCase() === white.toLowerCase()) white = legible(toHex(blend(text, bg, 0.15)));

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
