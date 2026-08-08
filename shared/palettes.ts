/*
 * The colours both apps are built from: two base palettes and seven accents.
 *
 * This file exists because the phone got a theme. The desk has thirty-seven
 * palettes and a mode segment above them; the phone gets the IDEA without the
 * catalogue — dark or light, and one accent for the things that read as live.
 * Two palettes and seven accents is the whole of it.
 *
 * ── why the bases are the desk's own github-dark / github-light ──────────────
 * Because they are not new colours. Whatever else the two products differ in,
 * a phone showing a session and a desk showing the same session have to look
 * like one application; picking a fresh pair of greys for the phone is how you
 * get two. These two records are byte-for-byte what web/src/lib/themes.ts had
 * inline for those themes, which is why that file now imports them instead —
 * the desktop's offer is unchanged, it just stopped holding the only copy.
 *
 * ── why shared/ and not a copy ──────────────────────────────────────────────
 * Precedent, set in this repo today: sessionTitle moved to shared/ rather than
 * being duplicated, because four disagreeing copies of one rule is what forced
 * that move. A colour is the same kind of value — nobody notices the copies
 * drifting until two screens of the same product are different greys.
 *
 * ── the shape ───────────────────────────────────────────────────────────────
 * camelCase, sixteen fields, and that is not arbitrary: it is exactly what the
 * server normalizes a theme to (`ThemeVars` in server/src/themesync.ts) and so
 * exactly what already travels between the machine, the phone, tmux and nvim.
 * The `--bg` spelling is one client's rendering detail, so it lives in the
 * converter at the bottom rather than in the values.
 */

export interface Palette {
  bg: string; bg2: string; bg3: string; bg4: string;
  text: string; text2: string; text3: string; text4: string;
  border: string; border2: string;
  primary: string; primaryHover: string;
  success: string; warning: string; error: string; info: string;
}

/** What a surface actually is, once "system" has been asked. */
export type Polarity = "dark" | "light";

/** What somebody chose. "system" is a question, not a palette — see polarityOf. */
export type ThemeMode = "dark" | "light" | "system";

export const BASE: Record<Polarity, Palette> = {
  dark: {
    bg: "#0d1117", bg2: "#161b22", bg3: "#21262d", bg4: "#30363d",
    text: "#e6edf3", text2: "#c9d1d9", text3: "#8b949e", text4: "#6e7681",
    border: "#30363d", border2: "#444c56",
    primary: "#58a6ff", primaryHover: "#79c0ff",
    success: "#3fb950", warning: "#d29922", error: "#f85149", info: "#58a6ff",
  },
  light: {
    bg: "#ffffff", bg2: "#f6f8fa", bg3: "#eaeef2", bg4: "#d0d7de",
    text: "#1f2328", text2: "#414852", text3: "#656d76", text4: "#8c959f",
    border: "#d0d7de", border2: "#afb8c1",
    primary: "#0969da", primaryHover: "#0550ae",
    success: "#1a7f37", warning: "#9a6700", error: "#cf222e", info: "#0969da",
  },
};

export type AccentId = "neutral" | "blue" | "violet" | "green" | "amber" | "rose" | "cyan";

export interface Accent { id: AccentId; name: string; primary: string; hover: string }

/*
 * The six with a hue, and these hex values are the desktop's — accent.ts held
 * them and now imports them.
 *
 * One pair per accent rather than one per polarity, deliberately. The desk lays
 * these same six over its light themes as well, and an accent whose hex changed
 * between the phone and the desk would put us back to two products that happen
 * to share a name for a colour.
 */
export const ACCENTS: Accent[] = [
  { id: "blue", name: "Blue", primary: "#3b82f6", hover: "#60a5fa" },
  { id: "violet", name: "Violet", primary: "#8b5cf6", hover: "#a78bfa" },
  { id: "green", name: "Green", primary: "#22c55e", hover: "#4ade80" },
  { id: "amber", name: "Amber", primary: "#f59e0b", hover: "#fbbf24" },
  { id: "rose", name: "Rose", primary: "#f43f5e", hover: "#fb7185" },
  { id: "cyan", name: "Cyan", primary: "#06b6d4", hover: "#22d3ee" },
];

/**
 * Every accent the phone offers: no-accent first, then the six.
 *
 * Neutral is here and not in ACCENTS above because it is the one the desk has
 * no name for. Its picker's first entry is "Theme", which means "do not
 * override" — a different thing, since what shows through is then whichever of
 * thirty-seven palettes is on. On a phone with exactly two palettes that would
 * be github's blue and nothing else, so "no accent" needed saying properly.
 */
export const PHONE_ACCENTS: Accent[] = [
  // Resolved per polarity — see accentFor. The hex here is the dark one so the
  // record is a valid Accent; nothing reads it without asking for a polarity.
  { id: "neutral", name: "Neutral", primary: BASE.dark.text, hover: "#ffffff" },
  ...ACCENTS,
];

/**
 * What an accent paints, on a given surface.
 *
 * Only neutral depends on the surface, and it has to: "no accent" is the ink of
 * the page, and an ink that reads on #0d1117 is invisible on #ffffff. The desk
 * says the same thing with its two serious defaults — Graphite's primary is its
 * own near-white, Porcelain's is its own near-black — so this is that idea
 * rather than a fourth constant nobody would keep in step.
 */
export function accentFor(polarity: Polarity, id: AccentId): { primary: string; hover: string } {
  if (id === "neutral") {
    const base = BASE[polarity];
    return { primary: base.text, hover: polarity === "dark" ? "#ffffff" : "#000000" };
  }
  const accent = ACCENTS.find((a) => a.id === id);
  // An unknown id paints the base's own primary rather than throwing: this
  // value arrives from storage, and a phone that will not start because a
  // preference file says "purple" is worse than a phone with a blue cursor.
  if (!accent) return { primary: BASE[polarity].primary, hover: BASE[polarity].primaryHover };
  return { primary: accent.primary, hover: accent.hover };
}

/**
 * The palette to actually paint with.
 *
 * The accent overrides primary and primaryHover and NOTHING else — success,
 * warning, error and info stay the base's. Same rule as the desk's applyAccent:
 * an accent is a taste, and a red that means "this failed" is not.
 */
export function paletteFor(polarity: Polarity, accent: AccentId): Palette {
  const { primary, hover } = accentFor(polarity, accent);
  return { ...BASE[polarity], primary, primaryHover: hover };
}

/** The mode as a surface. `systemIsDark` is asked for rather than read here
 *  because the two apps ask different things — matchMedia on the desk,
 *  Appearance on the phone — and neither belongs in shared/. */
export function polarityOf(mode: ThemeMode, systemIsDark: boolean): Polarity {
  if (mode === "dark" || mode === "light") return mode;
  return systemIsDark ? "dark" : "light";
}

/** A chosen look: what to resolve, and what to paint the live parts with. */
export interface Look { mode: ThemeMode; accent: AccentId }

/**
 * A look as read back out of storage, field by field.
 *
 * Nothing here trusts the record. It is JSON on a device, it survives app
 * upgrades that rename things, and an accent id that no longer exists would
 * otherwise reach `accentFor` — which answers with the base's own primary, so
 * the app would run in a colour that is not on the picker and cannot be
 * re-chosen. Each field falls back on its own, because half a remembered
 * choice is still a choice somebody made.
 */
export function sanitizeLook(raw: unknown, fallback: Look): Look {
  const saved = (raw && typeof raw === "object" ? raw : {}) as Partial<Look>;
  const mode = saved.mode;
  const accent = saved.accent;
  return {
    mode: mode === "dark" || mode === "light" || mode === "system" ? mode : fallback.mode,
    accent: PHONE_ACCENTS.some((a) => a.id === accent) ? accent as AccentId : fallback.accent,
  };
}

/** The browser's spelling of a palette. `--shadow` is not in here: it is a
 *  CSS-only var with no counterpart in what the server syncs, so it stays
 *  beside the theme that declares it. */
export function cssVars(p: Palette): Record<string, string> {
  return {
    "--bg": p.bg, "--bg2": p.bg2, "--bg3": p.bg3, "--bg4": p.bg4,
    "--text": p.text, "--text2": p.text2, "--text3": p.text3, "--text4": p.text4,
    "--border": p.border, "--border2": p.border2,
    "--primary": p.primary, "--primary-hover": p.primaryHover,
    "--success": p.success, "--warning": p.warning, "--error": p.error, "--info": p.info,
  };
}

/** The two inks a coloured face is allowed. The dark one is the phone's own
 *  `#08111d`, which every button on it was drawn against. */
const INK_DARK = "#08111d";
const INK_LIGHT = "#ffffff";

const channel = (v: number): number => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of a `#rgb`/`#rrggbb`. Unparseable is treated as
 *  black, which picks the light ink — the safe way to be wrong about a colour
 *  that should not exist. */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}/.test(full)) return 0;
  const n = Number.parseInt(full.slice(0, 6), 16);
  return 0.2126 * channel((n >> 16) & 255)
    + 0.7152 * channel((n >> 8) & 255)
    + 0.0722 * channel(n & 255);
}

/**
 * Ink for text sitting ON a coloured face, whichever of the two contrasts more.
 *
 * The phone had `#08111d` hardcoded at four call sites — the send key, the
 * badge, the primary button, the composer — because the face was always
 * github-dark's blue. The face is now the accent, which ranges from #f59e0b to
 * #1f2328, and near-black ink on the neutral accent of a LIGHT screen is
 * near-black on near-black.
 *
 * WCAG ratios rather than a luminance threshold, because the two disagree
 * exactly where it matters. Measured over all seven accents on both bases: the
 * ink flips only for light-neutral (#1f2328 → white 15.80 against dark 1.20);
 * every hue keeps the dark ink, and blue (5.15 against 3.68) sits on the wrong
 * side of the obvious shortcut — un-linearized, #3b82f6 is 0.48 of the way up,
 * so a 0.5 cut hands it white ink at two thirds of the contrast.
 */
export function inkOn(face: string): string {
  const l = luminance(face);
  const dark = (Math.max(l, luminance(INK_DARK)) + 0.05) / (Math.min(l, luminance(INK_DARK)) + 0.05);
  const light = (Math.max(l, luminance(INK_LIGHT)) + 0.05) / (Math.min(l, luminance(INK_LIGHT)) + 0.05);
  return dark >= light ? INK_DARK : INK_LIGHT;
}
