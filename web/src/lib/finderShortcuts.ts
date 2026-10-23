/*
 * The finder's shortcut reference: Strata's sections and wording for the keys
 * this finder really has. A key that is listed here and does nothing would be
 * the worst thing a shortcut sheet can do, so the list holds only what works;
 * the rest of Strata's keys come with the phase that builds what they act on.
 */
export interface Shortcut { keys: string; does: string }
export interface Section { title: string; rows: Shortcut[] }

export const SECTIONS: Section[] = [
  { title: "Columns navigation", rows: [
    { keys: "Up, Down", does: "Move between items" },
    { keys: "Left, Right", does: "Parent pane / enter folder" },
    { keys: "Backspace", does: "Close the current pane or go to the parent folder" },
    { keys: "Alt+Left, Alt+Right", does: "Back / forward in history" },
    { keys: "Alt+Up", does: "Go to the parent folder" },
    { keys: "Alt+Home", does: "Go to Home" },
    { keys: "Home, End", does: "First / last item" },
  ] },
  { title: "Files and selection", rows: [
    { keys: "Enter", does: "Open the current item (a file opens in nvim on the bench)" },
    { keys: "Space", does: "Show or hide the preview" },
    { keys: "Ctrl+X / Ctrl+C / Ctrl+V", does: "Cut / copy / paste" },
    { keys: "Ctrl+D", does: "Duplicate" },
    { keys: "Delete", does: "Move to Trash" },
    { keys: "Shift+Delete", does: "Permanently delete" },
    { keys: "Ctrl+Z", does: "Undo the last move, rename, trash or copy" },
    { keys: "F2, Ctrl+R", does: "Rename" },
    { keys: "Ctrl+Shift+N", does: "Create a folder" },
    { keys: "Ctrl+Alt+N", does: "Create a folder containing the selection" },
    { keys: "y", does: "Copy path" },
  ] },
  { title: "Search and tools", rows: [
    { keys: "Ctrl+K", does: "Search Home by name or contents" },
    { keys: "Ctrl+L", does: "Edit the location" },
    { keys: "Ctrl+H", does: "Show or hide hidden files" },
    { keys: "Ctrl+B", does: "Compact, hide, then show the sidebar" },
    { keys: "F1", does: "Show all shortcuts" },
  ] },
];

/** Sections with only the rows whose keys or words contain the query; empty sections go. */
export function filterShortcuts(sections: readonly Section[], query: string): Section[] {
  const q = query.trim().toLowerCase();
  if (!q) return sections.map((s) => ({ ...s }));
  return sections
    .map((s) => ({ title: s.title, rows: s.rows.filter((r) => r.keys.toLowerCase().includes(q) || r.does.toLowerCase().includes(q)) }))
    .filter((s) => s.rows.length > 0);
}

/** How a key is drawn on the sheet, as Strata draws it: arrows for the arrow keys, " / " between alternatives. The data keeps the plain names so the search still finds "Up". */
export const keyLabel = (keys: string): string =>
  keys.replace(/\bUp\b/g, "↑").replace(/\bDown\b/g, "↓").replace(/\bLeft\b/g, "←").replace(/\bRight\b/g, "→").replace(/, /g, " / ");
