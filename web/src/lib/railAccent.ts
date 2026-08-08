/*
 * The colour the ACTIVE rail icon is drawn in.
 *
 * The rail used to say "you are here" with a tinted box behind the glyph. The
 * box is what got removed: at 16px the icon needed it to be findable, and once
 * the glyph is big enough to read on its own the box is a second shape
 * competing with the only one that matters. So the icon itself carries the
 * state, in the accent.
 *
 * Which cannot simply be `var(--primary)`. The accent is laid over the theme's
 * primary, and the serious themes ship a MONOCHROME primary on purpose —
 * Graphite's is `#e5e5e5`, Porcelain's `#171717`. Set one of those to a grey
 * near the rail's own and the active view becomes the hardest icon on the strip
 * to find, which is the exact opposite of the point.
 *
 * The rule below came out of measuring the shipped palette rather than from
 * reasoning about it, and the measurement moved it twice:
 *
 *   graphite   inactive icons sit at 4.22:1 · violet accent 3.94 · blue 4.53
 *   porcelain  inactive icons sit at 3.19:1 · amber accent 2.15 · green 2.28
 *
 * Violet is BELOW the dim tier it has to be told apart from, and on screen it
 * is unmistakable — because a hue is distinguishable in a way a lightness step
 * is not. So a contrast floor alone is the wrong instrument: applied honestly
 * it would "fix" violet, and the fix would take away the colour somebody chose.
 *
 * Hence two rules for two different kinds of colour, which is what the data
 * says there are:
 */
import { contrast, liftToContrast, parseColor, type Rgb } from "./contrast.ts";

/** WCAG's floor for a graphical object — which is what a lone glyph is. */
const FLOOR = 3;

/**
 * How far from grey a colour has to be before its hue counts as help.
 *
 * 12/255 of spread between the channels. Below it the eye has only lightness
 * to go on, which is the case the fallback exists for; above it, the colour
 * reads as a colour even when it is quiet.
 */
const CHROMA_MIN = 12;

const chroma = ({ r, g, b }: Rgb): number => Math.max(r, g, b) - Math.min(r, g, b);

/**
 * @param primary the accent as it stands (`--primary`)
 * @param bg      the rail's own background (`--bg`)
 * @param text    the theme's text colour (`--text`) — white on dark, near-black on light
 * @param dim     the inactive icons' colour (`--text4`), the thing the active one
 *                has to be told apart FROM
 */
export function railActiveColor(primary: string, bg: string, text: string, dim?: string): string {
  const a = parseColor(primary);
  const b = parseColor(bg);
  // A var that has not resolved, or a format the parser does not know. Text is
  // the answer that is never wrong, only sometimes plainer.
  if (!a || !b) return text || primary;

  if (chroma(a) < CHROMA_MIN) {
    // A grey. Nothing but lightness separates it from the dimmed icons, so it
    // has to out-do them at their own game — Graphite's near-white primary
    // does, at 13:1, and a dark-grey one does not, at 1.06:1. That second case
    // is the one to catch: it goes white on a dark theme and near-black on a
    // light one, because that is what `--text` is.
    const d = dim ? parseColor(dim) : null;
    const needed = d ? contrast(d, b) : FLOOR;
    return contrast(a, b) >= needed ? primary : (text || primary);
  }

  // A colour. Its hue already tells it apart from the greys around it, so it is
  // kept — only lifted toward the theme's text if it is genuinely too faint to
  // read, which on the shipped palette is amber, green and cyan on white. A
  // darker amber is still amber; near-black is not, and that is the difference
  // between a floor and a veto.
  return liftToContrast(primary, text, bg, FLOOR);
}
