/*
 * THE DESKTOP'S OWN PALETTE, AS A THEME THIS APP CAN WEAR.
 *
 * "System" used to mean one bit: dark or light, off `prefers-color-scheme`,
 * mapped to the two neutral themes. On a desktop that themes every app it runs
 * — the terminal, the bar, the editor, the lock screen, all switched together —
 * that one bit is the only thing that did not follow, and this was the window
 * that stayed grey when everything around it turned blue.
 *
 * So a desktop that publishes a palette is read, and "System" wears it. This
 * file is only the translation — pure, so it is tested without a desktop. What
 * a palette is called on a given desktop, and where it lives, is the provider's
 * business (server/src/desktopPalette.ts).
 */
import type { AnsiPalette } from "./termPalette.ts";

export interface DesktopTheme {
  id: "desktop";
  name: string;
  dark: boolean;
  vars: Record<string, string>;
  preview: { primary: string; secondary: string; accent: string };
  ansi?: AnsiPalette;
}

/**
 * A `colors.toml` as flat key/value pairs.
 *
 * Not a TOML parser, and it does not need to be: the file is a flat list of
 * `key = "value"`. A line that is not that shape is skipped rather than
 * failing the whole palette — a theme with one odd line still has colours.
 */
export function parseColors(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const m = raw.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*(?:#.*)?$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

const HEX = /^#?([0-9a-f]{6})$/i;

function rgb(hex: string): [number, number, number] | null {
  const m = hex.trim().match(HEX);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `a` moved `t` of the way toward `b`. Used only where the desktop names no
 *  colour for a tier this app has — a surface between two it does name. */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return a;
  const c = x.map((v, i) => Math.round(v + (y[i]! - v) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Dark or light. The palette's own `mode` when it says one; otherwise the
 * background decides. A palette Omarchy derives from a theme's terminal config
 * has no `mode` line at all (measured: a cream light theme arrived with only
 * accent, selection, background, foreground and color0-15), and reading a
 * missing line as "dark" painted its shadow and hover mix for the wrong end of
 * the scale.
 */
function isDarkPalette(mode: string | undefined, bg: string): boolean {
  const m = (mode ?? "").trim().toLowerCase();
  if (m === "light") return false;
  if (m === "dark") return true;
  const [r, g, b] = rgb(bg)!;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

const pick = (c: Record<string, string>, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = c[k];
    if (v && rgb(v)) return v.startsWith("#") ? v : `#${v}`;
  }
  return undefined;
};

/**
 * The palette, mapped onto this app's tokens.
 *
 * The desktop names a background, a lighter one, a selection and a muted tone,
 * which are this app's four surfaces in the same order of lightness; a
 * foreground, which is the text; an accent, which is the primary; and the
 * sixteen terminal colours, whose green, yellow, red and blue are the signal
 * colours. What it does not name is derived by mixing two it does, never
 * invented. Returns null for a palette without the two it cannot do without.
 */
export function desktopTheme(c: Record<string, string>, name: string): DesktopTheme | null {
  const bg = pick(c, "background");
  const fg = pick(c, "foreground");
  if (!bg || !fg) return null;
  const dark = isDarkPalette(c.mode, bg);
  const accent = pick(c, "accent", "blue", "cyan") ?? fg;
  const bg2 = pick(c, "lighter_background") ?? mix(bg, fg, 0.06);
  const bg3 = pick(c, "selection") ?? mix(bg, fg, 0.12);
  const bg4 = pick(c, "muted") ?? mix(bg, fg, 0.2);
  const border = pick(c, "muted") ?? mix(bg, fg, 0.18);

  const vars: Record<string, string> = {
    "--bg": bg,
    "--bg2": bg2,
    "--bg3": bg3,
    "--bg4": bg4,
    "--text": pick(c, "bright_foreground", "foreground")!,
    "--text2": fg,
    "--text3": mix(fg, bg, 0.3),
    "--text4": mix(fg, bg, 0.45),
    "--border": border,
    "--border2": mix(border, fg, 0.15),
    "--primary": accent,
    "--primary-hover": mix(accent, dark ? "#ffffff" : "#000000", 0.2),
    "--success": pick(c, "green") ?? "#4ade80",
    "--warning": pick(c, "yellow", "orange") ?? "#fbbf24",
    "--error": pick(c, "red") ?? "#f87171",
    "--info": pick(c, "blue", "cyan") ?? accent,
    "--shadow": dark ? "rgba(0, 0, 0, 0.75)" : "rgba(0, 0, 0, 0.15)",
  };

  /* The terminal's sixteen, when the desktop names them — its terminal is
     already drawing in exactly these, so a pane here reads as the same one. */
  const base = { red: pick(c, "red"), green: pick(c, "green"), yellow: pick(c, "yellow"),
    blue: pick(c, "blue"), magenta: pick(c, "magenta"), cyan: pick(c, "cyan") };
  let ansi: AnsiPalette | undefined;
  if (Object.values(base).every(Boolean)) {
    ansi = {
      black: pick(c, "color0", "dark_background") ?? bg,
      red: base.red!, green: base.green!, yellow: base.yellow!,
      blue: base.blue!, magenta: base.magenta!, cyan: base.cyan!,
      white: pick(c, "color7") ?? fg,
      brightBlack: pick(c, "color8", "muted") ?? mix(bg, fg, 0.35),
      brightRed: pick(c, "bright_red") ?? base.red!,
      brightGreen: pick(c, "bright_green") ?? base.green!,
      brightYellow: pick(c, "bright_yellow") ?? base.yellow!,
      brightBlue: pick(c, "bright_blue") ?? base.blue!,
      brightMagenta: pick(c, "bright_magenta") ?? base.magenta!,
      brightCyan: pick(c, "bright_cyan") ?? base.cyan!,
      brightWhite: pick(c, "color15", "bright_foreground") ?? fg,
    };
  }

  return {
    id: "desktop",
    name,
    dark,
    vars,
    preview: { primary: bg, secondary: bg2, accent },
    ...(ansi ? { ansi } : null),
  };
}
