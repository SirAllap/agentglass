/*
 * WHERE THE DESKTOP KEEPS ITS PALETTE.
 *
 * One provider today, Omarchy: every theme it applies is staged into
 * `~/.local/state/omarchy/current/theme/`, with the palette as `colors.toml` and
 * the theme's slug beside it in `theme.name`. Both are rewritten on every
 * switch, so the file's mtime is the whole change signal — nothing to install
 * into the desktop, no hook of ours in its config, no command run per poll.
 *
 * A machine without it answers null and costs one failed stat. That is the
 * whole of what this does to anybody not on that desktop: "System" keeps
 * meaning what it always did, dark or light off the OS.
 *
 * The next desktop is another function returning the same shape, tried in turn.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { desktopTheme, parseColors, type DesktopTheme } from "../../shared/desktopPalette.ts";

export interface DesktopPalette {
  /** Which desktop it came from, for the label under the switch. */
  source: "omarchy";
  /** The theme as the desktop names it. */
  name: string;
  /** Changes whenever the palette does — what a client compares to repaint. */
  stamp: string;
  theme: DesktopTheme;
}

/* Under HOME, never XDG_STATE_HOME: that is where Omarchy's theme switch
   writes it (`$HOME/.local/state/omarchy/current`, spelled out in the script),
   and every terminal config it ships includes it from that same path. Reading
   XDG_STATE_HOME made an instance started with its own state directory — an
   isolated second copy of this app — see no desktop at all. Only read, so a
   copy that is isolated everywhere else still writes nothing outside its own
   directories. `process.env.HOME` first because Bun's homedir() keeps the
   value the process started with. */
function omarchyDir(): string {
  return join(process.env.HOME || homedir(), ".local", "state", "omarchy", "current");
}

/** `tokyo-night` reads as `Tokyo Night`, the way the desktop's own menu shows it. */
function titled(slug: string): string {
  return slug.split(/[-_\s]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}

let cache: { stamp: string; palette: DesktopPalette | null } | null = null;

function omarchy(): DesktopPalette | null {
  const dir = omarchyDir();
  const file = join(dir, "theme", "colors.toml");
  let mtime: number;
  try { mtime = statSync(file).mtimeMs; } catch { return null; }
  let slug = "";
  try { slug = readFileSync(join(dir, "theme.name"), "utf8").trim(); } catch { /* unnamed is still a palette */ }
  const stamp = `${mtime}:${slug}`;
  /* Read once per change rather than once per ask: a client in System mode
     asks every few seconds, and the file moves a handful of times a day. */
  if (cache?.stamp === stamp) return cache.palette;
  let palette: DesktopPalette | null = null;
  try {
    const name = titled(slug) || "Omarchy";
    const theme = desktopTheme(parseColors(readFileSync(file, "utf8")), name);
    if (theme) palette = { source: "omarchy", name, stamp, theme };
  } catch { /* unreadable mid-write: the next ask gets it */ }
  cache = { stamp, palette };
  return palette;
}

/** The desktop's palette, or null on a desktop that publishes none. */
export function desktopPalette(): DesktopPalette | null {
  return omarchy();
}

/** For a test that points HOME somewhere else between cases. */
export function __forgetDesktopPalette(): void { cache = null; }

/**
 * The desktop's own mark, read off the machine rather than shipped.
 *
 * This repository is public and the mark is somebody else's; carrying a copy
 * would be redistributing it. Every machine this can be shown on already has it
 * installed, so it is served from there, and a machine without it gets nothing
 * and the button falls back to the word.
 *
 * REBUILT, not relayed. The page inlines what comes back so the mark takes the
 * segment's text colour — the first version handed the file over as a CSS mask
 * and it drew nothing at all — and inlining somebody's SVG is inlining whatever
 * it contains. So only the geometry is kept: the view box and each path's
 * outline, each checked against the characters a path can be made of, set in a
 * fresh `<svg>` filled with `currentColor`. Nothing from the file reaches the
 * page as markup.
 */
export function desktopLogo(): string | null {
  if (!omarchy()) return null;
  const share = process.env.OMARCHY_PATH || "/usr/share/omarchy";
  try { return rebuildMark(readFileSync(join(share, "logo.svg"), "utf8")); } catch { return null; }
}

/** Only geometry survives. Exported for the test. */
export function rebuildMark(svg: string): string | null {
  if (svg.length > 64_000) return null;
  const vb = svg.match(/viewBox="([0-9.\s-]+)"/)?.[1]?.trim();
  if (!vb || !/^-?[0-9.]+(\s+-?[0-9.]+){3}$/.test(vb)) return null;
  const paths: string[] = [];
  for (const m of svg.matchAll(/<path\b([^>]*)>/g)) {
    const d = m[1]!.match(/\sd="([^"]*)"/)?.[1];
    if (!d || !/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/.test(d)) continue;
    const even = /fill-rule="evenodd"|clip-rule="evenodd"/.test(m[1]!);
    paths.push(`<path d="${d}"${even ? ' fill-rule="evenodd"' : ""}/>`);
  }
  if (!paths.length) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" fill="currentColor" aria-hidden="true">${paths.join("")}</svg>`;
}
