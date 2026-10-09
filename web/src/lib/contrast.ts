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
