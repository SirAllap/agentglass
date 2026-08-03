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
 *  body ratio. `--text3` is labels and timestamps — AA. `--text4` is the
 *  quietest thing on screen and only has to be perceptible. */
export const TIER_TARGET: Record<string, number> = {
  "--text2": 7,
  "--text3": 4.5,
  "--text4": 3,
};

/**
 * The tiers, floored and still in order.
 *
 * Lifting each one independently can cross them — a `--text3` that needed a big
 * lift can end up brighter than a `--text2` that needed none, and then the
 * hierarchy the theme was expressing is inverted. Each tier is capped at the
 * one above it after the lift.
 */
export function floorTiers(vars: Record<string, string>): Record<string, string> {
  const text = vars["--text"], bg = vars["--bg2"] || vars["--bg"];
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
