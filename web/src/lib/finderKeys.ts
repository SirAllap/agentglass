/*
 * Which key does what in the Machine tab's finder, apart from doing it.
 *
 * The finder listens on the window rather than on an element, because the
 * palette keeps focus in its own search box and a person who opens the tab and
 * presses ↓ expects the list to move. That makes every key a question of "is
 * this for me?", which is a decision and so lives here where it can be tested:
 * a key typed into any OTHER field is never taken, the chords the app owns are
 * never taken, and the search box is shared only while it is empty — the moment
 * there is text in it the finder is gone and the palette is searching.
 */
export type Act =
  | { t: "move"; key: string }
  | { t: "enter" }
  | { t: "up" }
  | { t: "back" }
  | { t: "forward" }
  | { t: "home" }
  | { t: "preview" }
  | { t: "hidden" }
  | { t: "terminal" }
  | { t: "sidebar" }
  | { t: "path" }
  | { t: "copy" }
  | { t: "copyfiles" }
  | { t: "cut" }
  | { t: "paste" }
  | { t: "duplicate" }
  | { t: "rename" }
  | { t: "trash" }
  | { t: "delete" }
  | { t: "newfolder" }
  | { t: "folderwith" }
  | { t: "props" }
  | { t: "undo" }
  | { t: "redo" }
  | { t: "pin" }
  | { t: "newtab" }
  | { t: "closetab" }
  | { t: "tab"; by: 1 | -1 }
  | { t: "opentab" }
  | { t: "help" }
  | { t: "refresh" }
  | { t: "filter" }
  | { t: "extend"; by: "up" | "down" | "pageUp" | "pageDown" | "home" | "end" }
  | { t: "all" }
  | { t: "toggle" }
  | { t: "view"; view: "columns" | "icons" | "list" }
  /** Strata's type-to-search: a printable key opens the pane's filter with it typed; `/` opens it empty. */
  | { t: "find"; ch: string }
  /** Space: a folder opens, a file toggles its preview. Shift+Space only toggles the preview. */
  | { t: "space" }
  | { t: "escape" }
  /** Ctrl+= / Ctrl+- / Ctrl+0: the finder's text size, a step up, down, or back to the default. */
  | { t: "text"; by: 1 | -1 | 0 }
  /** Ctrl+Shift+B: the keyboard between the sidebar and the files. */
  | { t: "sidefocus" }
  /** The Menu key and Shift+F10: the menu of what is selected, at the row. */
  | { t: "menu" }
  | { t: "settings" }
  /** Ctrl+Shift+1…9, 0: the tab by its number (0 is the tenth). */
  | { t: "tabnum"; i: number }
  /** Ctrl+Shift+Page Up / Page Down: the active tab one place left or right. */
  | { t: "tabmove"; by: 1 | -1 }
  /** Shift+Left / Shift+Right, which Strata leaves to each view: Columns treats it as Left, Icons extends, List swallows. */
  | { t: "shiftside"; by: 1 | -1 };

export interface KeyIn { key: string; ctrl: boolean; meta: boolean; shift: boolean; alt: boolean; code?: string }
export interface Ctx {
  /** Focus is in a text field that is not the palette's own search box. */
  inField: boolean;
  /** Some text is selected on the page, so Ctrl+C means copy that. */
  hasSelection: boolean;
}

const MOVES = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

export function finderKey(k: KeyIn, ctx: Ctx): Act | null {
  if (k.key === "F1") return { t: "help" };
  // F5 alone: Strata's exact match, so Ctrl+F5 and Shift+F5 do nothing here.
  if (k.key === "F5") return !k.ctrl && !k.meta && !k.alt && !k.shift ? { t: "refresh" } : null;
  if (ctx.inField) return null;
  // Strata's Ctrl+Alt+T: a terminal in the folder the finder is looking at.
  if (k.key.toLowerCase() === "t" && k.ctrl && k.alt && !k.shift && !k.meta) return { t: "terminal" };
  // The file operations (Strata's keys). Ctrl+C copies the FILES. Strata's bare y and p are its 10xer mode's, off by default: there a letter is the filter's.
  if (k.key === "F2" && !k.ctrl && !k.meta && !k.alt && !k.shift) return { t: "rename" };
  if (k.key === "Delete" && !k.ctrl && !k.meta && !k.alt) return k.shift ? { t: "delete" } : { t: "trash" };
  if ((k.ctrl || k.meta) && k.alt && !k.shift && k.key.toLowerCase() === "n") return { t: "folderwith" };
  if ((k.ctrl || k.meta) && k.shift && !k.alt && k.key.toLowerCase() === "n") return { t: "newfolder" };
  // Folder tabs (Strata's): Ctrl+T new, Ctrl+W close, Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+PageDown / Ctrl+PageUp step, Ctrl+Enter opens the chosen folder in a new one.
  if ((k.ctrl || k.meta) && !k.alt) {
    const low = k.key.toLowerCase();
    if (!k.shift && low === "t") return { t: "newtab" };
    if (!k.shift && low === "w") return { t: "closetab" };
    if (k.key === "Tab") return { t: "tab", by: k.shift ? -1 : 1 };
    if (!k.shift && (k.key === "PageDown" || k.key === "PageUp")) return { t: "tab", by: k.key === "PageDown" ? 1 : -1 };
    if (!k.shift && k.key === "Enter") return { t: "opentab" };
    if (k.shift && low === "b") return { t: "sidefocus" };
    if (!k.shift && k.key === ",") return { t: "settings" };
    if (k.shift && (k.key === "PageUp" || k.key === "PageDown")) return { t: "tabmove", by: k.key === "PageDown" ? 1 : -1 };
    // Ctrl+Shift+digit: the digit is the key pressed, whatever Shift makes of it on this layout (the code says which).
    if (k.shift && k.code && /^Digit[0-9]$/.test(k.code)) { const d = Number(k.code.slice(5)); return { t: "tabnum", i: d === 0 ? 9 : d - 1 }; }
    if (!k.shift && (k.key === "=" || k.key === "+")) return { t: "text", by: 1 };
    if (!k.shift && k.key === "-") return { t: "text", by: -1 };
    if (!k.shift && k.key === "0") return { t: "text", by: 0 };
  }
  if (k.alt) {
    if (k.ctrl || k.meta) return null;
    // Strata ignores Shift on history (Alt+Shift+Left is still back); on nothing else.
    if (k.shift) return k.key === "ArrowLeft" ? { t: "back" } : k.key === "ArrowRight" ? { t: "forward" } : null;
    switch (k.key) {
      case "Enter": return { t: "props" };
      case "ArrowLeft": return { t: "back" };
      case "ArrowRight": return { t: "forward" };
      case "ArrowUp": return { t: "up" };
      case "Home": return { t: "home" };
      default: return null;
    }
  }
  if (!k.ctrl && !k.meta && k.shift && !k.alt) {
    switch (k.key) {
      case "ArrowUp": return { t: "extend", by: "up" };
      case "ArrowDown": return { t: "extend", by: "down" };
      case "PageUp": return { t: "extend", by: "pageUp" };
      case "PageDown": return { t: "extend", by: "pageDown" };
      case "ArrowLeft": return { t: "shiftside", by: -1 };
      case "ArrowRight": return { t: "shiftside", by: 1 };
      case "F10": return { t: "menu" };
      case "Home": return { t: "extend", by: "home" };
      case "End": return { t: "extend", by: "end" };
      // Strata's Shift+Enter is a new window; one window here, so a new tab. Shift+Space: the preview, never a folder.
      case "Enter": return { t: "opentab" };
      case " ": return { t: "preview" };
      default: return [...k.key].length === 1 ? { t: "find", ch: k.key } : null;
    }
  }
  if ((k.ctrl || k.meta) && !k.alt) {
    const low = k.key.toLowerCase();
    // Strata's redo: Ctrl+Shift+Z or Ctrl+Y.
    if ((k.shift && low === "z") || (!k.shift && low === "y")) return { t: "redo" };
  }
  if (k.ctrl || k.meta) {
    if (k.shift) return null;
    if (k.key === " ") return { t: "toggle" };
    switch (k.key.toLowerCase()) {
      case "h": case ".": return { t: "hidden" };
      case "f": return { t: "filter" };
      case "1": return { t: "view", view: "columns" };
      case "2": return { t: "view", view: "icons" };
      case "3": return { t: "view", view: "list" };
      case "arrowup": return { t: "move", key: "Home" };
      case "arrowdown": return { t: "move", key: "End" };
      case "a": return { t: "all" };
      case "b": return { t: "sidebar" };
      case "l": return { t: "path" };
      case "c": return ctx.hasSelection ? null : { t: "copyfiles" };
      case "x": return { t: "cut" };
      case "v": return { t: "paste" };
      case "d": return { t: "duplicate" };
      case "r": return { t: "rename" };
      case "z": return { t: "undo" };
      default: return null;
    }
  }
  if (k.shift) return null;
  if (MOVES.has(k.key)) return { t: "move", key: k.key };
  if (k.key === "Enter") return { t: "enter" };
  if (k.key === "Backspace") return { t: "up" };
  if (k.key === "ContextMenu") return { t: "menu" };
  if (k.key === " ") return { t: "space" };
  if (k.key === "Escape") return { t: "escape" };
  if (k.key === "/") return { t: "find", ch: "" };
  if ([...k.key].length === 1) return { t: "find", ch: k.key };
  return null;
}

/** The app's own chords the finder takes while it has the keys, because they are Strata's there: the three views and the text size. */
export function finderOwnsChord(k: KeyIn): boolean {
  if (!(k.ctrl || k.meta) || k.alt) return false;
  // Ctrl+Shift+digit and Ctrl+Shift+Page Up / Down are Strata's tab keys.
  if (k.shift) return /^Digit[0-9]$/.test(k.code ?? "") || k.key === "PageUp" || k.key === "PageDown";
  return ["1", "2", "3", "=", "+", "-", "0", ","].includes(k.key);
}

/**
 * What Esc takes away: a preview shown in place of the files, then a multi-selection
 * (neither survives a reopening anyway). Nothing else is peeled: the single selection,
 * the open preview and the deepest column are what a reopened finder restores, so an
 * Esc that took them away first made "Esc, Esc, Esc to leave" cost the place the person
 * was in (measured in Icons and List: three presses, and a reopening without its preview).
 * Strata peels them because it has no window to close; this finder does, so with nothing
 * transient left Esc goes on to close it (`none` leaves the key to the app).
 */
export function escapeAct(s: { previewPage: boolean; multi: boolean }): "preview-page" | "multi" | "none" {
  if (s.previewPage) return "preview-page";
  return s.multi ? "multi" : "none";
}

/**
 * Left, where it does not move between rows (Strata ui/window.rs, keyboard/items.rs):
 * Columns goes to the parent column, and from the first one to the sidebar; List
 * has no left and goes to the sidebar; Icons moves to the tile on the left and,
 * from the first tile of a line, to the sidebar. With the sidebar hidden it stays.
 */
export function leftAct(s: { view: "columns" | "icons" | "list"; col: number; atLineStart: boolean; sidebar: boolean }): "column" | "move" | "sidebar" | "stay" {
  if (s.view === "columns" && s.col > 0) return "column";
  if (s.view === "icons" && !s.atLineStart) return "move";
  return s.sidebar ? "sidebar" : "stay";
}

/** Backspace (Strata ui/browser.rs `navigate_up`): in Columns below the first column it closes the column it is in; otherwise the parent folder. */
export const backspaceAct = (view: "columns" | "icons" | "list", col: number): "close-column" | "parent" => (view === "columns" && col > 0 ? "close-column" : "parent");

/**
 * Up on the first row (Strata's default, "Keep arrows in file list" off): the
 * keyboard leaves the rows for the pane's open filter, or else for its header's
 * buttons. With neither (Icons and List have no header here) it stays.
 */
export const upFromFirst = (s: { filterOpen: boolean; header: boolean }): "filter" | "header" | "stay" => (s.filterOpen ? "filter" : s.header ? "header" : "stay");

/**
 * A chord that belongs to the app, not to the dialog in front of it (Ctrl+Shift+P opens the finder, and
 * the rest of the Ctrl+Shift family are the app's too). A dialog keeps the keys it edits with and lets
 * these through: stopping every key at the dialog made the Trash list swallow the shortcut that closes it.
 */
export const isAppChord = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): boolean => (e.ctrlKey || e.metaKey) && e.shiftKey;
