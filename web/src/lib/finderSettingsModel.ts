// What Strata's Settings window holds that this finder can honour, as data: the
// pages, their rows with Strata's own wording, and the filter behind its
// "Search settings" field. Strata's other settings (language, the theme
// library, updates, custom actions, 10xer mode, folder peeking, autoplay) are
// either the app's own business or a feature this finder does not have, and a
// switch that does nothing is worse than no switch; docs/ keeps that list.
import type { Prefs } from "./finderMiller.ts";

export type PageId = "general" | "appearance";
export const PAGES: readonly { id: PageId; title: string; hint: string }[] = [
  { id: "general", title: "General", hint: "Browsing, search, files" },
  { id: "appearance", title: "Appearance", hint: "Text, density, thumbnails" },
];

export type Toggle = "preview" | "sizes" | "mirror" | "f1" | "hidden";
export type Row =
  | { page: PageId; section: string; id: Toggle; kind: "toggle"; title: string; desc: string }
  | { page: PageId; section: string; id: "defaultSort"; kind: "sort"; title: string; desc: string }
  | { page: PageId; section: string; id: "forget"; kind: "button"; title: string; desc: string; action: string }
  | { page: PageId; section: string; id: "textSize" | "thumb" | "density"; kind: "stepper" | "slider" | "density"; title: string; desc: string };

export const ROWS: readonly Row[] = [
  { page: "general", section: "Browsing", id: "preview", kind: "toggle", title: "Single-click file previews", desc: "Show a quick preview when selecting a supported file." },
  { page: "general", section: "Browsing", id: "sizes", kind: "toggle", title: "Show sizes in Columns view", desc: "Show the size or item count on the selected row." },
  { page: "general", section: "Browsing", id: "mirror", kind: "toggle", title: "Mirror columns selection", desc: "Show the selected folder's contents in the next pane as you move with the keyboard." },
  { page: "general", section: "Browsing", id: "hidden", kind: "toggle", title: "Show hidden files", desc: "List entries whose name starts with a dot. Ctrl+H toggles it." },
  { page: "general", section: "Browsing", id: "f1", kind: "toggle", title: "Show F1 Shortcuts button", desc: "The button in the footer. The key works either way." },
  { page: "general", section: "Browsing", id: "defaultSort", kind: "sort", title: "Default sort", desc: "What Reset to default sort in the column menu returns to." },
  { page: "general", section: "Browsing", id: "forget", kind: "button", title: "Forget all folder settings", desc: "Clear where the finder was left: the folder, selection, scroll and dragged widths.", action: "Clear" },
  { page: "appearance", section: "Text", id: "textSize", kind: "stepper", title: "Text size", desc: "Logical pixels. Ctrl + / - / 0 change it from the keyboard." },
  { page: "appearance", section: "Density", id: "density", kind: "density", title: "Density", desc: "Compact rows, or Airy rows with more room." },
  { page: "appearance", section: "Icons view", id: "thumb", kind: "slider", title: "Thumbnail size", desc: "The side of an image's thumbnail in Icons view." },
];

/** The rows a search shows: every word has to be in the title, the description or the section. Empty search is every row. */
export function filterRows(rows: readonly Row[], q: string): Row[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...rows];
  return rows.filter((r) => { const hay = `${r.title} ${r.desc} ${r.section}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
}

/** Which pages still have a row after a search, so the nav can say where the matches are. */
export const pagesWith = (rows: readonly Row[]): Set<PageId> => new Set(rows.map((r) => r.page));

/** The value a toggle row shows. */
export const toggleValue = (p: Pick<Prefs, "preview" | "sizes" | "mirror" | "f1" | "hidden">, id: Toggle): boolean => p[id];
