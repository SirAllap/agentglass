// A floor under the dim text tiers.
//
// A theme declares four text colours: `--text` for what you read, then `--text2`
// / `--text3` / `--text4` for things that should recede. Thirty-odd themes each
// picked those by eye, and on a good number of them the recessive tiers recede
// past legible — which matters more than it sounds, because 555 places in this
// app ask for one of them, including a lot of text that is not chrome at all.
//
// This does not restyle anything and does not override a theme that got it
// right. It measures each tier against the background it will actually sit on
// and lifts only the ones that fall under a contrast target, keeping the hue
// and keeping the ladder — a lifted `--text3` is never brighter than `--text2`.

export type Rgb = { r: number; g: number; b: number };

/** The eight ANSI colours a palette can name twice, normal and bright. */
export type Shades = Partial<Record<
  "red" | "green" | "yellow" | "blue" | "magenta" | "cyan"
  | "brightRed" | "brightGreen" | "brightYellow" | "brightBlue" | "brightMagenta" | "brightCyan",
  string
>>;

/** `#abc`, `#aabbcc`, `rgb(1 2 3)` — the shapes the themes actually use, plus
 *  the shape `getComputedStyle` hands back. Null for anything else, so an
 *  unparseable colour is left exactly as the theme wrote it. */
export function parseColor(input: string): Rgb | null {
  const s = (input || "").trim();
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1]!;
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    };
  }
  const rgb = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  return null;
}

const channel = (v: number): number => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance. */
export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a), lb = luminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => ({
  r: Math.round(a.r + (b.r - a.r) * t),
  g: Math.round(a.g + (b.g - a.g) * t),
  b: Math.round(a.b + (b.b - a.b) * t),
});

export const toHex = ({ r, g, b }: Rgb): string =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;

/**
 * `dim`, moved toward `text` only as far as it has to be.
 *
 * Toward the theme's own `--text` rather than toward white, so a warm theme
 * stays warm and a light theme darkens instead of washing out — the direction
 * is decided by the palette, not assumed.
 *
 * Returns the original when it already clears the target: a theme that was
 * designed carefully is left alone, which is the whole point of a floor.
 */
export function liftToContrast(dim: string, text: string, bg: string, target: number): string {
  const d = parseColor(dim), t = parseColor(text), b = parseColor(bg);
  if (!d || !t || !b) return dim;
  if (contrast(d, b) >= target) return dim;
  // 20 steps is finer than the eye resolves over this range, and bounded so a
  // target that cannot be met (a theme whose own --text does not reach it)
  // ends at --text rather than looping.
  for (let i = 1; i <= 20; i++) {
    const c = mix(d, t, i / 20);
    if (contrast(c, b) >= target) return toHex(c);
  }
  return toHex(t);
}

/** What each tier has to clear, against the panel it sits on.
 *
 *  `--text2` carries body copy in a lot of places, so it is held to the AAA
 *  body ratio. `--text3` is labels — comfortably past AA. `--text4` is the
 *  quietest tier but still has to be read, not just sensed, so it clears AA too.
 *  Measured against `--bg3` (see floorTiers), the darker elevated surface these
 *  tiers actually land on — a floor tuned to `--bg2` alone left dim text failing
 *  on tiles, hover rows and tinted grounds. */
export const TIER_TARGET: Record<string, number> = {
  "--text2": 7,
  "--text3": 5,
  "--text4": 4,
};

const PAIRS: Array<[keyof Shades, keyof Shades]> = [
  ["red", "brightRed"], ["green", "brightGreen"], ["yellow", "brightYellow"],
  ["blue", "brightBlue"], ["magenta", "brightMagenta"], ["cyan", "brightCyan"],
];

/**
 * The other shade of a semantic colour the desktop already named — normal for
 * bright, bright for normal — checked by value rather than by key, since a
 * theme's `--warning` may have come from `yellow` or from `orange` and this
 * only needs to find its ANSI twin, not its origin.
 */
export function altShade(tint: string, ansi?: Shades): string | undefined {
  if (!ansi) return undefined;
  for (const [n, b] of PAIRS) {
    if (ansi[n] === tint) return ansi[b];
    if (ansi[b] === tint) return ansi[n];
  }
  return undefined;
}

/**
 * A tinted chip's text colour, guaranteed to clear `target` against the
 * ground it actually sits on (a chip's own fill is a translucent mix of this
 * same tint over that ground, so the ground is the honest thing to measure
 * against rather than each chip's own percentage).
 *
 * Tried in order: the tint itself (a theme that already got it right is left
 * alone); the tint's other ANSI shade, when the palette names one, because
 * swapping normal for bright (or back) keeps the theme's own colour rather
 * than diluting it toward grey; and only then a mix toward `text`.
 */
export function inkFor(tint: string, text: string, bg: string, target: number, ansi?: Shades): string {
  const t = parseColor(tint), b = parseColor(bg);
  if (t && b && contrast(t, b) >= target) return tint;
  const alt = altShade(tint, ansi);
  if (alt) {
    const a = parseColor(alt);
    if (a && b && contrast(a, b) >= target) return alt;
  }
  return liftToContrast(tint, text, bg, target);
}

/** Semantic tints a chip, label, banner or button paints its text with. */
export const TINT_KEYS = ["--success", "--warning", "--error", "--info", "--primary"] as const;

const dataInkCache = new Map<string, string>();

/**
 * `inkFor`, live: a colour a *label or status* names rather than a theme —
 * a GitHub label's hex, a ClickUp status's hex — checked against the ground
 * it is actually painted on right now.
 *
 * These never go through `inkTints`, because they are not theme data: they
 * arrive per-row from an API, one value per label rather than one per theme,
 * and a theme switch does not touch them. Read `--text`/`--bg3` off the live
 * document instead, the same way `cardPrPick.ts`'s `mergedInk` already reads
 * the GitHub "Merged" purple's ink — this generalises that to any hex a label
 * or status pill hands the app, cached per (colour, text, bg) triple rather
 * than recomputed every render.
 */
export function dataInk(hex: string, bg?: string): string {
  if (typeof document === "undefined") return hex;
  const cs = getComputedStyle(document.documentElement);
  const text = cs.getPropertyValue("--text").trim();
  const ground = bg ?? (cs.getPropertyValue("--bg3").trim() || cs.getPropertyValue("--bg").trim());
  if (!text || !ground) return hex;
  const key = `${hex}|${text}|${ground}`;
  const cached = dataInkCache.get(key);
  if (cached) return cached;
  const ink = inkFor(hex, text, ground, 4.5);
  dataInkCache.set(key, ink);
  return ink;
}

/** The ink for text on a solid `--primary` fill: WCAG AA body text. An icon
 *  alone on the fill would only need 3:1; nothing here is drawn as icon-only
 *  without a label, so one bar, the higher one. */
export const ON_PRIMARY = 4.5;
const NEAR_BLACK = "#0a0a0a", NEAR_WHITE = "#fafafa";

/**
 * What to write on a button, badge or selected chip that is filled with the
 * primary colour.
 *
 * The app used `--bg` for this, which is the right answer only while the
 * primary is far from the background in lightness. Measured on the 23 desktop
 * palettes, seven put a primary within reach of their own background (a mid
 * blue or green on a cream page: 3.1 to 4.3:1), so the label on every primary
 * button was dim. The ink is chosen from the primary's own luminance instead:
 * the theme's background if that reads (a theme that got it right is left
 * alone), then its text colour, then whichever of near-black and near-white is
 * farther from the primary, which always reaches 4.5:1 because one of the two
 * poles is at least that far from any colour. `--primary-hover` is not held to
 * it: no control fills with it (it is a text colour, and a button's hover is a
 * brightness step), and on a mid-tone primary no single ink clears both a
 * primary and its darker hover.
 */
export function onPrimaryInk(primary: string, bg?: string, text?: string): string | undefined {
  const p = parseColor(primary);
  if (!p) return undefined;
  const poles = [NEAR_BLACK, NEAR_WHITE].sort((a, b) => contrast(parseColor(b)!, p) - contrast(parseColor(a)!, p));
  const candidates = [bg, text, ...poles].filter((c): c is string => !!c && !!parseColor(c));
  return candidates.find((c) => contrast(parseColor(c)!, p) >= ON_PRIMARY) ?? poles[0];
}

/**
 * `--success-ink` etc. alongside the tint they are read off — one pass per
 * theme rather than per screen, the same shape as `floorTiers`.
 *
 * Measured against `--bg3`, the same worst-case surface `floorTiers` uses: a
 * tinted chip's fill is that tint mixed over whatever ground sits under it,
 * and `--bg3` is the ground where that mix is palest — the fill most likely
 * to fail. A key with no ink target is passed through unchanged.
 */
export function inkTints(vars: Record<string, string>, ansi?: Shades): Record<string, string> {
  const text = vars["--text"], bg = vars["--bg3"] || vars["--bg2"] || vars["--bg"];
  const out = { ...vars };
  if (!text || !bg) return out;
  for (const key of TINT_KEYS) {
    const v = vars[key];
    if (!v) continue;
    out[`${key}-ink`] = inkFor(v, text, bg, 4.5, ansi);
  }
  const on = vars["--primary"] && onPrimaryInk(vars["--primary"], vars["--bg"], text);
  if (on) out["--on-primary"] = on;
  return out;
}

/**
 * The tiers, floored and still in order.
 *
 * Lifting each one independently can cross them — a `--text3` that needed a big
 * lift can end up brighter than a `--text2` that needed none, and then the
 * hierarchy the theme was expressing is inverted. Each tier is capped at the
 * one above it after the lift.
 */
export function floorTiers(vars: Record<string, string>): Record<string, string> {
  // Floor against --bg3, the darker of the elevated surfaces the dim tiers
  // actually sit on (tiles, hover rows, chips). A tier that clears it here also
  // clears the lighter --bg/--bg2, and comes far closer on the tinted washes.
  const text = vars["--text"], bg = vars["--bg3"] || vars["--bg2"] || vars["--bg"];
  if (!text || !bg) return vars;
  const out = { ...vars };
  let ceiling = text;
  for (const key of ["--text2", "--text3", "--text4"]) {
    const cur = out[key];
    if (!cur) continue;
    const lifted = liftToContrast(cur, text, bg, TIER_TARGET[key]!);
    const l = parseColor(lifted), c = parseColor(ceiling), b = parseColor(bg);
    // Never brighter than the tier above: compare by distance from the
    // background, which is the direction "brighter" means on either theme.
    out[key] = l && c && b && contrast(l, b) > contrast(c, b) ? ceiling : lifted;
    ceiling = out[key]!;
  }
  return out;
}

/**
 * The surfaces a desktop palette hands this app, shaped so that text can be
 * read on every one of them and one can be told from the next.
 *
 * A desktop names a background, a "lighter" one, a selection and a muted tone,
 * and `desktopTheme` takes them as this app's four surfaces on the assumption
 * that they sit close to the background. They do not always: a cream theme's
 * selection is the same slate as its text (measured: text on `--bg3` at 1.0:1,
 * so every chip, search field and pinned strip painted on it was unreadable),
 * and another theme's lighter background is the background (1.00:1, so cards
 * vanished into the page). Both are the same fault, a surface placed without
 * looking at what is drawn on it or beside it, so it is one rule here rather
 * than a case per theme:
 *
 *  1. The body text is lifted to SURFACE_TEXT:1 on `--bg`, which is the room
 *     the ladder needs (see below). A theme that already has it is untouched.
 *  2. Each of `--bg2..4` is pulled back toward `--bg`, hue kept, only as far as
 *     the text needs to stay at READABLE:1 on it, with a STEP of room left for
 *     each surface after it (greedy, the first took it all and the last had none).
 *  3. Each is pushed on, away from the one before and toward the text, until it
 *     is STEP:1 from it, unless that would break 2: legible wins over distinct.
 *  4. The borders keep their distance from the grounds they outline.
 *
 * STEP is 1.10 because it is the smallest step a hand-made palette in the
 * Omarchy set uses between its background and its second surface (1.10 to 1.37
 * across the 22 measured; the ones below it, at 1.00 and 1.04, are the ones
 * that read as flat). With the text at 7:1, three steps of 1.10 leave it 5.3:1
 * on `--bg4`, over READABLE. Not covered: a surface that is a different hue
 * from the background is kept in hue only while it stays near it.
 */
export const SURFACE_STEP = 1.1;
export const READABLE = 4.5;
export const SURFACE_TEXT = 7;
/** Headroom above READABLE when pulling a surface back, so the step after it
 *  has a little to spend; 8-bit colour rounds by about half a percent. */
const CAP_SLACK = 1.02;
/** A hairline against the grounds it separates, and the control edge (WCAG 1.4.11). */
export const BORDER_STEP = 1.25;
export const CONTROL_EDGE = 3;

const cr = (a: Rgb, b: Rgb) => contrast(a, b);

export function shapeSurfaces(vars: Record<string, string>): Record<string, string> {
  const bg = parseColor(vars["--bg"] ?? ""), text = parseColor(vars["--text"] ?? ""),
    text2 = parseColor(vars["--text2"] ?? "");
  if (!bg || !text || !text2) return vars;
  const out = { ...vars };
  // Toward whichever pole the text is on: light themes darken, dark ones lighten.
  const pole: Rgb = luminance(text) >= luminance(bg) ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  const poleHex = toHex(pole);
  const bgHex = toHex(bg);
  out["--text"] = liftToContrast(vars["--text"]!, poleHex, bgHex, SURFACE_TEXT);
  out["--text2"] = liftToContrast(vars["--text2"]!, poleHex, bgHex, SURFACE_TEXT);
  // The weaker of the two: some palettes name a bright foreground that is
  // dimmer than the foreground, and both are drawn on these surfaces.
  const lifted = [out["--text"]!, out["--text2"]!].map((h) => parseColor(h)!);
  const ink = cr(lifted[0]!, bg) <= cr(lifted[1]!, bg) ? lifted[0]! : lifted[1]!;

  let prev = bg;
  for (const [n, key] of ["--bg2", "--bg3", "--bg4"].entries()) {
    const named = parseColor(vars[key] ?? "") ?? prev;
    let s = named;
    // 2: back toward the page until the text reads on it, leaving the surfaces
    // after this one the room for their own step.
    const need = READABLE * CAP_SLACK * SURFACE_STEP ** (2 - n);
    if (cr(ink, s) < need) {
      // Bisect for the farthest point on the way back to the page that still
      // clears it: exact, where a coarse walk stops short and leaves a surface
      // the same tone as its neighbour.
      let lo = 0, hi = 1;
      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        if (cr(ink, mix(bg, named, mid)) >= need) lo = mid; else hi = mid;
      }
      s = mix(bg, named, lo);
    }
    // The surface must be on the text's side of the one before: a "lighter"
    // background that is lighter than a light page is not a step up.
    if (cr(s, pole) > cr(prev, pole)) s = prev;
    // 3: step on toward the text until it is told apart, or the text would stop reading.
    for (let i = 0; i < 200 && cr(s, prev) < SURFACE_STEP; i++) {
      const n = mix(s, ink, 0.01);
      if (cr(ink, n) < READABLE) break;
      s = n;
    }
    out[key] = toHex(s);
    prev = s;
  }

  // 4: a hairline must be seen on the grounds it sits between; the control edge
  // (--border2) is the outline of something you operate, so it keeps 3:1.
  const grounds = ["--bg", "--bg2", "--bg3"].map((k) => parseColor(out[k]!)!);
  const lineOf = (start: string, min: number, over: Rgb[]) => {
    let b = parseColor(start) ?? ink;
    for (let i = 0; i < 100 && over.some((g) => cr(b, g) < min); i++) b = mix(b, ink, 0.05);
    return toHex(b);
  };
  out["--border"] = lineOf(vars["--border"] ?? out["--bg4"]!, BORDER_STEP, grounds);
  out["--border2"] = lineOf(vars["--border2"] ?? out["--border"]!, CONTROL_EDGE, grounds.slice(0, 2));
  return out;
}

/** What the desktop's palette becomes on screen: shaped, floored, inked. One
 *  path, so the sweep test measures the same colours the window paints. */
export function paintDesktop(vars: Record<string, string>, ansi?: Shades): Record<string, string> {
  return inkTints(floorTiers(shapeSurfaces(vars)), ansi);
}
