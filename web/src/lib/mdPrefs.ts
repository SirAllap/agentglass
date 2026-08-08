// How the markdown viewer is set, and why it is set separately from everything
// else.
//
// The terminal has its own font size and the app has its own display size, and
// neither is the right knob here: this is prose, read at arm's length, next to
// a UI that is deliberately dense. Somebody who wants the cockpit small and a
// status report comfortable is asking for two different things, and until now
// had to choose one.
//
// Kept in localStorage rather than in the settings file: it is a reading
// preference of one pane on one machine, it changes with the document you are
// looking at, and a round trip to the server for a font size would be the
// slowest thing in the pane.

const SIZE_KEY = "agentglass.md.size";
const WIDTH_KEY = "agentglass.md.width";

/**
 * The size range, in pixels.
 *
 * 12 is the app's own dense reading size and the floor: below it this stops
 * being prose. 22 is where a line of 72 characters starts needing more than
 * half a 1080p window, which is the point at which a wider measure is the
 * better answer than a bigger face.
 */
export const SIZE_MIN = 12;
export const SIZE_MAX = 22;
export const SIZE_DEFAULT = 14;

/**
 * The measure, in characters.
 *
 * Not in pixels: what makes a line easy to come back from is how many
 * characters are on it, and `ch` is the unit that keeps that true when the
 * font size changes. 65–75 is the typographic range everyone quotes; 100 is
 * for tables, which are the one thing in these documents that genuinely wants
 * the width; 0 means "the whole pane", for somebody with a wide screen and a
 * wide table.
 */
export const WIDTHS = [66, 80, 100, 0] as const;
export type MdWidth = (typeof WIDTHS)[number];
export const WIDTH_DEFAULT: MdWidth = 66;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function mdSize(): number {
  try {
    const n = Number(localStorage.getItem(SIZE_KEY));
    return Number.isFinite(n) && n > 0 ? clamp(Math.round(n), SIZE_MIN, SIZE_MAX) : SIZE_DEFAULT;
  } catch { return SIZE_DEFAULT; }
}

export function setMdSize(px: number): number {
  const n = clamp(Math.round(px), SIZE_MIN, SIZE_MAX);
  try { localStorage.setItem(SIZE_KEY, String(n)); } catch { /* private mode */ }
  return n;
}

export function mdWidth(): MdWidth {
  try {
    /*
     * The raw string first, and that is not fussiness.
     *
     * `Number(null)` is 0, and 0 is a MEMBER of this list — it means "the whole
     * pane". So reading an unset preference through Number() answered "Full",
     * and the viewer opened full-bleed for everybody who had never touched the
     * control. Measured on a fresh profile: max-width came out `none` when the
     * default is 66 characters.
     */
    const raw = localStorage.getItem(WIDTH_KEY);
    if (raw === null) return WIDTH_DEFAULT;
    const n = Number(raw);
    return (WIDTHS as readonly number[]).includes(n) ? (n as MdWidth) : WIDTH_DEFAULT;
  } catch { return WIDTH_DEFAULT; }
}

export function setMdWidth(w: MdWidth): MdWidth {
  try { localStorage.setItem(WIDTH_KEY, String(w)); } catch { /* private mode */ }
  return w;
}

/** What to call a measure in a button. The number of characters is the honest
 *  label for the first three; the last one is not a measure at all. */
export const widthLabel = (w: MdWidth): string => (w === 0 ? "Full" : String(w));
