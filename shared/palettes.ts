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

/*
 * The phone's own ground and ink, which are no longer the desk's.
 *
 * `BASE` above is github-dark and github-light, and it stays that on the desk:
 * a browser tab beside GitHub's own should not argue with it about what a
 * surface is. A phone has no such neighbour. It is held in one hand, in the
 * dark, at arm's length, and the two things it is mostly showing are a terminal
 * and a list of rows — so it is worth its own values.
 *
 * What changed and why, rather than "we picked nicer greys":
 *
 *   The ground goes DARKER and slightly cooler (#0a0c10 against #0d1117).
 *   github-dark is tuned to sit beside white browser chrome; a phone at night
 *   has nothing beside it, and the darker ground is what stops a full-screen
 *   terminal glowing in a dark room.
 *
 *   The hairline goes QUIETER (#232833 against #30363d) and the raised surface
 *   goes UP (#1a1f27 against #21262d). The desk separates things with borders
 *   because it has the pixels; the phone separates them with surface, because
 *   at 393 points a visible border around every row is most of what you see.
 *
 *   The mid ink goes UP (#a6b0bd against #c9d1d9 for secondary), because a
 *   phone is read outdoors and github-dark's third and fourth inks are close
 *   enough to disappear in sunlight.
 *
 * The light half is not github-light either, and not a photographic negative of
 * the dark one: it is warm where the dark one is cool. A cool near-white reads
 * as a screen that has been left on; a warm one reads as paper, which is what
 * a light mode is for.
 *
 * ── info stays a blue, and that is not an oversight ──────────────────────
 * The obvious move is to set `info` to the teal, since the teal is what this
 * palette is. It is wrong twice. In the UI it collapses two meanings into one
 * hex — an informational tone and a button you press stop being tellable apart,
 * and `info` is a semantic slot for the same reason `error` is. In the terminal
 * it is worse and it is silent: `deriveAnsi` picks ANSI blue by HUE, taking
 * `info` when it is near 220 and falling through to `primary` when it is not.
 * Teal is 171, so ANSI blue would become the accent — and on the NEUTRAL accent
 * the accent is the body text, which put the same hex in two of the sixteen
 * slots and made a `ls` colour vanish. Sixteen distinct slots is asserted in
 * mobile/test/term-ansi.test.ts, which is how this was found.
 */
export const PANE: Record<Polarity, Palette> = {
  dark: {
    bg: "#0a0c10", bg2: "#12161d", bg3: "#1a1f27", bg4: "#232833",
    text: "#e8ecf1", text2: "#a6b0bd", text3: "#7b8593", text4: "#6b7683",
    border: "#232833", border2: "#2f3540",
    // Replaced by the chosen accent — see paletteFor. These are what the shipped
    // one resolves to, so a palette read before a choice is made is not blue.
    primary: "#4dd6c1", primaryHover: "#7ce4d4",
    success: "#3fb950", warning: "#d9a441", error: "#f0776c", info: "#6aa9f5",
  },
  light: {
    bg: "#faf9f7", bg2: "#f2f0ed", bg3: "#e8e5e0", bg4: "#dbd7d1",
    text: "#16181c", text2: "#4a4e56", text3: "#6d727b", text4: "#8b9099",
    border: "#e2ded8", border2: "#cdc8c1",
    primary: "#0f9b88", primaryHover: "#0c8071",
    success: "#1a7f4b", warning: "#9a6a00", error: "#c2402f", info: "#1a63c8",
  },
};

export type AccentId = "neutral" | "blue" | "violet" | "green" | "amber" | "rose" | "cyan" | "teal";

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
  /* Teal is the phone's default and is not cyan with a nudge: cyan is a blue
     that has warmed up, and against a near-black ground it reads as another
     GitHub blue. This one is far enough round the wheel to be its own colour,
     and far enough from `success` green that a filled button is never mistaken
     for a passing check — the one confusion an accent on this app must not
     have. */
  { id: "teal", name: "Teal", primary: "#4dd6c1", hover: "#7ce4d4" },
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
export function accentFor(
  polarity: Polarity, id: AccentId, base: Record<Polarity, Palette> = BASE,
): { primary: string; hover: string } {
  if (id === "neutral") {
    // The ink of THIS page, which is why the base is a parameter: the phone's
    // near-white is not the desk's, and a neutral accent resolved against the
    // wrong one is an accent that does not match the text beside it.
    const surface = base[polarity];
    return { primary: surface.text, hover: polarity === "dark" ? "#ffffff" : "#000000" };
  }
  const accent = ACCENTS.find((a) => a.id === id);
  // An unknown id paints the base's own primary rather than throwing: this
  // value arrives from storage, and a phone that will not start because a
  // preference file says "purple" is worse than a phone with a blue cursor.
  // The BASE it falls back to is the caller's, not this file's — reading the
  // module constant here would answer a phone on PANE with the desk's blue,
  // which is the one case where the fallback is visible.
  if (!accent) return { primary: base[polarity].primary, hover: base[polarity].primaryHover };
  return { primary: accent.primary, hover: accent.hover };
}

/**
 * The palette to actually paint with.
 *
 * The accent overrides primary and primaryHover and NOTHING else — success,
 * warning, error and info stay the base's. Same rule as the desk's applyAccent:
 * an accent is a taste, and a red that means "this failed" is not.
 */
export function paletteFor(polarity: Polarity, accent: AccentId, base: Record<Polarity, Palette> = BASE): Palette {
  const { primary, hover } = accentFor(polarity, accent, base);
  return { ...base[polarity], primary, primaryHover: hover };
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
