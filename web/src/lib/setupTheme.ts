/*
 * Step 2's choices, as data: three modes and the palette under them.
 *
 * Pure so the screen can be tested without a DOM and so Settings and the
 * wizard cannot spell the same palette two ways. `themePick` is the one place
 * a click becomes a setting id: a mode click writes `appearance.mode`, a
 * palette click writes `appearance.theme` (web/src/lib/settingsRegistry.ts).
 */
import type { ThemeMode } from "./themes.ts";

export interface ModeTile {
  id: "system" | "light" | "dark";
  name: string;
  what: string;
  state: string;
  selected: boolean;
}

/** The three modes, in the order the mock draws them. */
export function modeTiles(mode: string): ModeTile[] {
  const rows: Omit<ModeTile, "selected">[] = [
    { id: "system", name: "System", what: "Follows your desktop, light or dark.", state: "Matches desktop" },
    { id: "light", name: "Light", what: "Always light, whatever the desktop does.", state: "Always light" },
    { id: "dark", name: "Dark", what: "Always dark, whatever the desktop does.", state: "Always dark" },
  ];
  return rows.map((r) => ({ ...r, selected: mode === r.id }));
}

export interface PaletteRow {
  id: string;
  name: string;
  /** Ground, card and accent: three chips, as the mock draws them. */
  swatches: [string, string, string];
  selected: boolean;
}

/** The six the mock offers, plus the desktop's own palette when there is one. */
export const SETUP_PALETTES = ["github-light", "porcelain", "catppuccin-latte", "solarized-light", "nord-light", "graphite"] as const;

export function paletteRows(
  palette: readonly { id: string; name: string; preview: { primary: string; secondary: string; accent: string } }[],
  current: string,
  desk: { name: string } | null,
): PaletteRow[] {
  const rows: PaletteRow[] = [];
  for (const id of SETUP_PALETTES) {
    const t = palette.find((p) => p.id === id);
    if (t) rows.push({ id, name: t.name, swatches: [t.preview.primary, t.preview.secondary, t.preview.accent], selected: current === id });
  }
  if (desk) rows.push({ id: "desktop", name: desk.name, swatches: ["#232136", "#2a273f", "#ea9a97"], selected: current === "desktop" });
  return rows;
}

export type ThemePick = { setting: "appearance.mode"; value: ThemeMode } | { setting: "appearance.theme"; value: string };

export function themePick(id: string, have: { palettes: readonly string[]; desk: boolean }): ThemePick | null {
  if (id === "system" || id === "light" || id === "dark") return { setting: "appearance.mode", value: id };
  if (id === "desktop") return have.desk ? { setting: "appearance.theme", value: "desktop" } : null;
  return have.palettes.includes(id) ? { setting: "appearance.theme", value: id } : null;
}
