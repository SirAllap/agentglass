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
/*
 * The tail every terminal font falls back through — and why DejaVu is in it.
 *
 * A monospace stack is not one font. The browser walks it per CHARACTER: the
 * cell is measured from a latin glyph, and `│` — which most of these faces
 * either lack or subset away — comes from whichever face further down the list
 * has it. When those are two different faces, the rule is drawn to a different
 * em box than the cell it sits in, and a divider that should be one continuous
 * line comes out dashed, once per row.
 *
 * That is exactly what happened. Measured on the machine it was reported from,
 * the ink height of `│` at 13px: DejaVu Sans Mono 17, the generic monospace 17,
 * Liberation Mono **15**, against a cell of about 17. This list had Liberation
 * Mono and no DejaVu, so every terminal — the default and all five choices,
 * which all end here — resolved its rules to the face that draws them two
 * pixels short, and every row showed the seam.
 *
 * So DejaVu Sans Mono goes ahead of Liberation Mono, which is what Orca's stack
 * does and why its dividers are solid on the same screen. Not a magic
 * incantation: it is "prefer a face whose box drawing fills the line box".
 * Verified by rendering ten stacked rules and counting gaps in the pixels —
 * seven before, zero after, for the default and for every selectable font.
 */
const TERM_FALLBACK = `"SF Mono", SFMono-Regular, ui-monospace, "Cascadia Code", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", "JetBrainsMono Nerd Font Mono", monospace`;

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

/**
 * Scrollback, in lines, and why the default is four thousand.
 *
 * xterm keeps every line as cell data, so a wide window at 10k is tens of
 * megabytes PER SHELL — and this app holds several open at once, deliberately,
 * so a build in one keeps running while you work in another. It is also what a
 * resize has to reflow: every line, on every fit, which is the multi-second
 * freeze people report when dragging a pane.
 *
 * So the default stays where it was, and the larger sizes are offered with that
 * cost stated rather than hidden. Anyone who wants 50k on one machine with one
 * shell open is right to have it; anyone running eight is better off not.
 */
export const SCROLLBACK_SIZES = [4_000, 10_000, 25_000, 50_000] as const;
export const DEFAULT_SCROLLBACK = 4_000;

/**
 * What counts as a word boundary for a double-click.
 *
 * xterm's own default, spelled out here because the point of the setting is
 * changing it: a path like `src/lib/api.ts` is one word to a terminal and four
 * to anyone trying to select it, and which behaviour is right depends entirely
 * on what you spend the day double-clicking.
 */
export const DEFAULT_WORD_SEPARATORS = " ()[]{}',\"`";

const FONT_KEY = "agentglass-term-font";
const SCROLLBACK_KEY = "agentglass-term-scrollback";
const WORDSEP_KEY = "agentglass-term-wordsep";
const COPY_ON_SELECT_KEY = "agentglass-term-copy-on-select";
const RIGHT_CLICK_PASTE_KEY = "agentglass-term-right-click-paste";
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

/** Clamped to the offered sizes on read: a hand-edited value must not reach
 *  xterm, and an unbounded one is a machine running out of memory per shell. */
export const currentScrollback = (): number => {
  const n = parseInt(read(SCROLLBACK_KEY), 10);
  return (SCROLLBACK_SIZES as readonly number[]).includes(n) ? n : DEFAULT_SCROLLBACK;
};

export const currentWordSeparators = (): string => {
  const v = read(WORDSEP_KEY);
  // An empty string is a real answer — "nothing is a boundary", which selects
  // a whole line on a double click — so absence is what falls back, not blank.
  return v === "" ? DEFAULT_WORD_SEPARATORS : v;
};

/**
 * Copy on select, the tmux way, and it defaults to ON because that is what this
 * terminal has always done. The switch exists for the one case it gets wrong:
 * a machine where the clipboard is shared with something that reacts to it.
 */
export const copyOnSelect = (): boolean => read(COPY_ON_SELECT_KEY) !== "0";

/** Right-click pastes instead of opening the context menu. Off by default: the
 *  menu is what a right click does everywhere else in this app. */
export const rightClickPaste = (): boolean => read(RIGHT_CLICK_PASTE_KEY) === "1";

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
export function termOptions(): { fontFamily: string; fontSize: number; cursorStyle: CursorStyle; lineHeight: number; scrollback: number; wordSeparator: string } {
  const f = TERM_FONTS.find((x) => x.id === currentTermFont());
  return {
    fontFamily: f && f.stack ? f.stack : TERM_FALLBACK,
    fontSize: currentTermSize(),
    cursorStyle: currentTermCursor(),
    lineHeight: currentTermLineHeight(),
    scrollback: currentScrollback(),
    wordSeparator: currentWordSeparators(),
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
      `${currentTermFont()}|${currentTermSize()}|${currentTermCursor()}|${currentTermLineHeight()}|${currentScrollback()}|${currentWordSeparators()}`,
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

export function setScrollback(n: number): void {
  const v = (SCROLLBACK_SIZES as readonly number[]).includes(n) ? n : DEFAULT_SCROLLBACK;
  write(SCROLLBACK_KEY, v === DEFAULT_SCROLLBACK ? "" : String(v));
  ping();
}

export function setWordSeparators(v: string): void {
  write(WORDSEP_KEY, v === DEFAULT_WORD_SEPARATORS ? "" : v);
  ping();
}

/* These two are read at the moment the mouse does something rather than applied
 * to xterm, so they need no ping — the next selection or right click already
 * sees the new answer. */
export function setCopyOnSelect(on: boolean): void { write(COPY_ON_SELECT_KEY, on ? "" : "0"); }
export function setRightClickPaste(on: boolean): void { write(RIGHT_CLICK_PASTE_KEY, on ? "1" : ""); }
