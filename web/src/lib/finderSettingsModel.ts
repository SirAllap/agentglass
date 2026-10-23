// What Strata's Settings window holds that this finder can honour, as data: the
// pages, their rows with Strata's own wording, and the filter behind its
// "Search settings" field. Strata's other settings are left out on purpose, each
// for a reason, because a switch that does nothing is worse than no switch:
//   language, theme library, updates, about — the app's own business, and the
//     finder is English; agentglass updates itself;
//   10xer mode — a keyboard mode this finder does not have;
//   keep arrows in the file list — arrows never leave the list here (no focus
//     path to the sidebar), so there is nothing for the switch to scope;
import type { Prefs } from "./finderMiller.ts";

export type PageId = "general" | "appearance" | "actions";
/** `icon` is the name of one of Strata's own drawings (assets/strata/actions). */
export const PAGES: readonly { id: PageId; title: string; hint: string; icon: string }[] = [
  { id: "general", title: "General", hint: "Browsing, search, files", icon: "sliders-horizontal" },
  { id: "appearance", title: "Appearance", hint: "Text, density, thumbnails", icon: "palette" },
  { id: "actions", title: "Actions", hint: "Custom actions", icon: "play" },
];

export type Toggle = "peek" | "autoplay" | "renderDocs" | "preview" | "sizes" | "mirror" | "f1" | "hidden";
export type Row =
  | { page: PageId; section: string; id: Toggle; kind: "toggle"; title: string; desc: string }
  | { page: PageId; section: string; id: "defaultSort"; kind: "sort"; title: string; desc: string }
  | { page: PageId; section: string; id: "forget" | "reset"; kind: "button"; title: string; desc: string; action: string }
  | { page: PageId; section: string; id: "manager"; kind: "manager"; title: string; desc: string }
  | { page: PageId; section: string; id: "textSize" | "thumb" | "density"; kind: "stepper" | "slider" | "density"; title: string; desc: string };

export const ROWS: readonly Row[] = [
  { page: "general", section: "Browsing", id: "peek", kind: "toggle", title: "Folder peeking", desc: "Preview folders on hover in Icons and List views." },
  { page: "general", section: "Browsing", id: "preview", kind: "toggle", title: "Single-click file previews", desc: "Show a quick preview when selecting a supported file." },
  { page: "general", section: "Browsing", id: "autoplay", kind: "toggle", title: "Autoplay media previews", desc: "Start playing video, audio, and GIF previews as soon as they open." },
  { page: "general", section: "Browsing", id: "renderDocs", kind: "toggle", title: "Render documents by default", desc: "Open Markdown and HTML previews in the rendered view instead of source." },
  { page: "general", section: "Browsing", id: "sizes", kind: "toggle", title: "Show sizes in Columns view", desc: "Show the size or item count on the selected row." },
  { page: "general", section: "Browsing", id: "mirror", kind: "toggle", title: "Mirror columns selection", desc: "Show the selected folder's contents in the next pane as you move with the keyboard." },
  { page: "general", section: "Browsing", id: "hidden", kind: "toggle", title: "Show hidden files", desc: "List entries whose name starts with a dot. Ctrl+H toggles it." },
  { page: "general", section: "Browsing", id: "f1", kind: "toggle", title: "Show F1 Shortcuts button", desc: "The button in the footer. The key works either way." },
  { page: "general", section: "Browsing", id: "defaultSort", kind: "sort", title: "Default sort", desc: "What Reset to default sort in the column menu returns to." },
  { page: "general", section: "Reset", id: "forget", kind: "button", title: "Forget all folder settings", desc: "Clear where the finder was left: the folder, selection, scroll and dragged widths.", action: "Clear" },
  { page: "general", section: "Reset", id: "reset", kind: "button", title: "Reset finder settings", desc: "Put every finder setting back to what it was on first run.", action: "Reset" },
  { page: "appearance", section: "Text", id: "textSize", kind: "stepper", title: "Text size", desc: "Logical pixels." },
  { page: "appearance", section: "Density", id: "density", kind: "density", title: "Density", desc: "Compact rows, or Airy rows with more room." },
  { page: "actions", section: "Custom actions", id: "manager", kind: "manager", title: "Custom actions", desc: "Add your own scripts to the file and folder context menus. Actions run with your permissions, so only enable scripts you trust." },
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
export const toggleValue = (p: Pick<Prefs, "peek" | "autoplay" | "renderDocs" | "preview" | "sizes" | "mirror" | "f1" | "hidden">, id: Toggle): boolean => p[id];
