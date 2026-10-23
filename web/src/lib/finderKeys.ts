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
  | { t: "sidebar" }
  | { t: "path" }
  | { t: "copy" }
  | { t: "help" }
  | { t: "refresh" }
  | { t: "filter" }
  | { t: "extend"; by: "up" | "down" | "pageUp" | "pageDown" }
  | { t: "all" }
  | { t: "toggle" }
  | { t: "view"; view: "columns" | "icons" | "list" };

export interface KeyIn { key: string; ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }
export interface Ctx {
  /** Focus is in a text field that is not the palette's own search box. */
  inField: boolean;
  /** Some text is selected on the page, so Ctrl+C means copy that. */
  hasSelection: boolean;
}

const MOVES = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

export function finderKey(k: KeyIn, ctx: Ctx): Act | null {
  if (k.key === "F1") return { t: "help" };
  if (k.key === "F5") return { t: "refresh" };
  if (ctx.inField) return null;
  if (k.alt) {
    if (k.ctrl || k.meta || k.shift) return null;
    switch (k.key) {
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
      default: return null;
    }
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
      case "c": return ctx.hasSelection ? null : { t: "copy" };
      default: return null;
    }
  }
  if (k.shift) return null;
  if (MOVES.has(k.key)) return { t: "move", key: k.key };
  if (k.key === "Enter") return { t: "enter" };
  if (k.key === "Backspace") return { t: "up" };
  if (k.key === " ") return { t: "preview" };
  return null;
}
