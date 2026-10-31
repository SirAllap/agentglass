// The Open projects modal's keyboard, as one pure map (defect D18).
//
// Esc closes (or steps back), arrows move the highlight, Space ticks, Enter
// opens, `/` focuses the search. The component feeds every keydown through
// `keyCommand` and does what comes back; no other handler decides anything.

export type Pane = "list" | "form";

export interface KeyEvent { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }
export interface KeyCtx {
  /** Focus is in a text field (search, path, URL…). */
  inField: boolean;
  /** The search box is the field. */
  inSearch: boolean;
  query: string;
  pane: Pane;
  legendOpen: boolean;
  menuOpen: boolean;
  /** The undo toast is on screen. */
  canUndo: boolean;
  /** A step is running that Esc should stop rather than leave. */
  busy: boolean;
}

export type KeyCmd =
  | { t: "closeLegend" }
  | { t: "closeMenu" }
  | { t: "clearQuery" }
  | { t: "back" }
  | { t: "close" }
  | { t: "focusSearch" }
  | { t: "move"; by: 1 | -1 | "first" | "last" | 10 | -10 }
  | { t: "tick" }
  | { t: "open" }
  | { t: "openTicked" }
  | { t: "tickAll" }
  | { t: "undo" }
  | { t: "legend" }
  | { t: "add" }
  | { t: "forget" }
  | { t: "source"; by: 1 | -1 }
  | { t: "menuPick"; n: number }
  | { t: "menuMove"; by: 1 | -1 };

export function keyCommand(e: KeyEvent, c: KeyCtx): KeyCmd | null {
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === "Escape") {
    if (c.legendOpen) return { t: "closeLegend" };
    if (c.menuOpen) return { t: "closeMenu" };
    if (c.pane === "form") return { t: "back" };
    if (c.inSearch && c.query) return { t: "clearQuery" };
    return { t: "close" };
  }
  if (c.menuOpen) {
    if (e.key === "ArrowDown") return { t: "menuMove", by: 1 };
    if (e.key === "ArrowUp") return { t: "menuMove", by: -1 };
    if (/^[1-4]$/.test(e.key)) return { t: "menuPick", n: Number(e.key) };
    if (e.key === "Enter") return { t: "menuPick", n: 0 };
    return null;
  }
  if (c.pane !== "list") return null;
  if (c.legendOpen) return null;
  if (e.key === "/" && !c.inField && !mod) return { t: "focusSearch" };
  if (e.key === "ArrowDown") return { t: "move", by: 1 };
  if (e.key === "ArrowUp") return { t: "move", by: -1 };
  if (e.key === "PageDown") return { t: "move", by: 10 };
  if (e.key === "PageUp") return { t: "move", by: -10 };
  if (!c.inField && e.key === "Home") return { t: "move", by: "first" };
  if (!c.inField && e.key === "End") return { t: "move", by: "last" };
  // Space ticks except where it is a character: in a search that has text.
  if (e.key === " " && (!c.inField || (c.inSearch && !c.query))) return { t: "tick" };
  if (e.key === "Enter" && !c.busy) return mod ? { t: "openTicked" } : { t: "open" };
  if ((e.key === "a" || e.key === "A") && mod && (!c.inField || !c.query)) return { t: "tickAll" };
  if ((e.key === "z" || e.key === "Z") && !c.inField && !mod && c.canUndo) return { t: "undo" };
  if (e.key === "?" && !c.inField) return { t: "legend" };
  if ((e.key === "n" || e.key === "N") && !c.inField && !c.busy) return { t: "add" };
  if (e.key === "Delete" && !c.inField && !c.busy) return { t: "forget" };
  if ((e.key === "[" || e.key === "]") && !c.inField && !mod) return { t: "source", by: e.key === "]" ? 1 : -1 };
  return null;
}

/** Where the highlight goes. `null` is "no row yet": ↓ lands on the first. */
export function moveHot(roots: readonly string[], hot: string | null, by: 1 | -1 | "first" | "last" | 10 | -10): string | null {
  if (!roots.length) return null;
  const at = hot ? roots.indexOf(hot) : -1;
  if (by === "first") return roots[0]!;
  if (by === "last") return roots[roots.length - 1]!;
  if (at < 0) return by > 0 ? roots[0]! : roots[roots.length - 1]!;
  const next = Math.min(roots.length - 1, Math.max(0, at + by));
  return roots[next]!;
}

/** What Enter opens: the highlighted row alone, else everything ticked. */
export function enterTargets(hot: string | null, ticked: readonly string[]): string[] {
  return hot ? [hot] : [...ticked];
}
