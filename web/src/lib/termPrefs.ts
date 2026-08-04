/*
 * The terminal's own typography — font, size, cursor.
 *
 * Kept apart from the app theme on purpose: the theme paints every surface at
 * once, but the terminal is the one place where the exact face and size matter,
 * and xterm is fussy about them (it measures a cell once and lays the whole grid
 * on it). So these live here, apply straight to xterm, and force a refit when
 * they change — never a CSS var the terminal would read stale.
 *
 * A face is only offered if it's actually installed (see `fontAvailable`): the
 * old mistake was letting people pick a font the machine doesn't have, whereupon
 * xterm mis-measured the fallback and the grid "went crazy".
 */
const TERM_FALLBACK = `"SF Mono", SFMono-Regular, ui-monospace, "Cascadia Code", Menlo, Consolas, "Liberation Mono", "JetBrainsMono Nerd Font Mono", monospace`;

// `bundled` faces ship with the app (see web/src/fonts.ts), so they're always
// available — no OS install, and the availability probe can be skipped for them.
export interface TermFont { id: string; name: string; family: string; stack: string; bundled?: boolean }
export const TERM_FONTS: TermFont[] = [
  { id: "", name: "System default", family: "", stack: "" },
  { id: "jetbrains", name: "JetBrains Mono", family: "JetBrains Mono", bundled: true, stack: `"JetBrains Mono", "JetBrainsMono Nerd Font Mono", ${TERM_FALLBACK}` },
  { id: "fira", name: "Fira Code", family: "Fira Code", bundled: true, stack: `"Fira Code", "FiraCode Nerd Font", ${TERM_FALLBACK}` },
  { id: "cascadia", name: "Cascadia Code", family: "Cascadia Code", bundled: true, stack: `"Cascadia Code", "CaskaydiaCove Nerd Font", ${TERM_FALLBACK}` },
  { id: "plex", name: "IBM Plex Mono", family: "IBM Plex Mono", bundled: true, stack: `"IBM Plex Mono", ${TERM_FALLBACK}` },
  { id: "source", name: "Source Code Pro", family: "Source Code Pro", bundled: true, stack: `"Source Code Pro", ${TERM_FALLBACK}` },
];

export type CursorStyle = "block" | "bar" | "underline";
export const CURSORS: { v: CursorStyle; label: string }[] = [
  { v: "block", label: "Block" }, { v: "bar", label: "Bar" }, { v: "underline", label: "Underline" },
];

export const SIZE_MIN = 9;
export const SIZE_MAX = 22;
/** Exported so anything that resets the size resets it to the same number the
 *  settings page calls default. */
export const DEFAULT_SIZE = 13;

/**
 * Line height, and why the default is exactly 1.
 *
 * This used to be a hardcoded 1.2, which reads as a harmless bit of air between
 * rows and is not. A terminal's box-drawing characters — `│` between tmux
 * panes, the rules around Claude Code's boxes — are meant to touch the row
 * above and below so they read as one continuous line. xterm only guarantees
 * that on the WebGL/canvas renderers, which draw those glyphs themselves and
 * fill the whole cell. On the **DOM renderer** the glyph comes from the font at
 * its natural height, so every extra percent of line height is a gap punched
 * through the middle of every rule: the divider came out dashed, and the Claude
 * Code logo — built from block characters — came out striped.
 *
 * That is not a rare configuration here. `wantsWebgl()` deliberately turns the
 * GPU renderer OFF on Linux to dodge a compositor white-out, so the DOM
 * renderer is the *default* on the platform this was reported from. Measured at
 * that machine's device pixel ratio: 1.2 on the DOM renderer draws a dashed
 * rule, 1.0 draws a solid one, and both WebGL variants are solid either way.
 *
 * So: 1 by default, matching every native terminal and Orca. It stays
 * adjustable, because some people do want the air and will accept the trade —
 * hence MIN of exactly 1 (xterm throws below it) and the warning the settings
 * page shows above it.
 */
export const LINE_HEIGHT_MIN = 1;
export const LINE_HEIGHT_MAX = 2;
export const DEFAULT_LINE_HEIGHT = 1;

const FONT_KEY = "agentglass-term-font";
const SIZE_KEY = "agentglass-term-size";
const CURSOR_KEY = "agentglass-term-cursor";
const LINE_HEIGHT_KEY = "agentglass-term-line-height";
const read = (k: string) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } };
const write = (k: string, v: string) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private mode */ } };

export const currentTermFont = (): string => read(FONT_KEY);
export const currentTermSize = (): number => {
  const n = parseInt(read(SIZE_KEY), 10);
  return Number.isFinite(n) && n >= SIZE_MIN && n <= SIZE_MAX ? n : DEFAULT_SIZE;
};
export const currentTermCursor = (): CursorStyle => {
  const c = read(CURSOR_KEY);
  return c === "bar" || c === "underline" ? c : "block";
};
/** Clamped on read, not just on write: a value edited by hand or left by an
 *  older build must not reach xterm, which throws during construction for
 *  anything below 1 and would take the whole terminal down with it. */
export const currentTermLineHeight = (): number => {
  const n = parseFloat(read(LINE_HEIGHT_KEY));
  if (!Number.isFinite(n)) return DEFAULT_LINE_HEIGHT;
  return Math.min(LINE_HEIGHT_MAX, Math.max(LINE_HEIGHT_MIN, n));
};

/**
 * Is a font really installed? A canvas width probe: a named family renders a
 * test string at a different width than the generic monospace fallback only when
 * the browser actually has it; when it falls back, the widths match. More
 * reliable across engines than document.fonts.check for locally-installed faces.
 */
export function fontAvailable(family: string): boolean {
  if (!family) return true; // "System default" always applies
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return true;
    const probe = "mmmmmmmmmmlliii0Oo##--width";
    ctx.font = "72px monospace";
    const base = ctx.measureText(probe).width;
    ctx.font = `72px "${family}", monospace`;
    return Math.abs(ctx.measureText(probe).width - base) > 0.5;
  } catch { return true; }
}

/** The xterm options the current prefs resolve to. */
export function termOptions(): { fontFamily: string; fontSize: number; cursorStyle: CursorStyle; lineHeight: number } {
  const f = TERM_FONTS.find((x) => x.id === currentTermFont());
  return {
    fontFamily: f && f.stack ? f.stack : TERM_FALLBACK,
    fontSize: currentTermSize(),
    cursorStyle: currentTermCursor(),
    lineHeight: currentTermLineHeight(),
  };
}

/**
 * Nudge a root var so the terminal's MutationObserver (applyThemeLive) fires and
 * re-reads termOptions() — the same live path a theme switch rides. The value is
 * the prefs themselves, so it only mutates when something actually changed.
 */
function ping(): void {
  try {
    document.documentElement.style.setProperty(
      "--agx-term-prefs",
      `${currentTermFont()}|${currentTermSize()}|${currentTermCursor()}|${currentTermLineHeight()}`,
    );
  } catch { /* no DOM */ }
}
export const applyTermPrefs = (): void => ping();

export function setTermFont(id: string): void { write(FONT_KEY, id); ping(); }
export function setTermSize(n: number): void { write(SIZE_KEY, String(Math.max(SIZE_MIN, Math.min(SIZE_MAX, n)))); ping(); }
export function setTermCursor(c: CursorStyle): void { write(CURSOR_KEY, c); ping(); }
export function setTermLineHeight(n: number): void {
  const v = Math.min(LINE_HEIGHT_MAX, Math.max(LINE_HEIGHT_MIN, n));
  // The default is written as an absent key, so a machine that never touched
  // this follows the default if it ever moves again.
  write(LINE_HEIGHT_KEY, v === DEFAULT_LINE_HEIGHT ? "" : String(v));
  ping();
}
