/*
 * The Tasks list rail as a tree, the keyboard half.
 *
 * The rail used to be twenty buttons in a column: Tab crossed every one of
 * them, and nothing answered the arrow keys. A tree is one stop in the Tab
 * order and moves inside itself (the WAI-ARIA treeview pattern), so the decision
 * about where a key goes is pulled out of the screen and made a function of
 * the visible rows alone. There is no renderer in this project, and a
 * rule about behaviour is easiest to hold where it can be called.
 */

/** One visible row, top to bottom. `expanded` is undefined on a leaf. */
export interface RailNode {
  level: number;
  expanded?: boolean;
}

/** What a key does: move focus to a row, open or close one, or use it. */
export type RailMove =
  | { kind: "focus"; index: number }
  | { kind: "toggle"; index: number }
  | { kind: "activate"; index: number }
  | null;

/**
 * Where a key goes, given the visible rows and the one that has focus.
 *
 * Right on a closed row opens it; on an open row it steps into its first
 * child. Left on an open row closes it; on anything else it steps out to the
 * parent, which is the nearest row above with a lower level. Up and down never
 * wrap: at the ends, a key that does nothing is the honest answer.
 */
export function railKey(nodes: readonly RailNode[], at: number, key: string): RailMove {
  const n = nodes[at];
  if (!n) return null;
  switch (key) {
    case "ArrowDown": return at + 1 < nodes.length ? { kind: "focus", index: at + 1 } : null;
    case "ArrowUp": return at > 0 ? { kind: "focus", index: at - 1 } : null;
    case "Home": return at > 0 ? { kind: "focus", index: 0 } : null;
    case "End": return at < nodes.length - 1 ? { kind: "focus", index: nodes.length - 1 } : null;
    case "ArrowRight":
      if (n.expanded === false) return { kind: "toggle", index: at };
      if (n.expanded === true && nodes[at + 1] && nodes[at + 1].level > n.level) return { kind: "focus", index: at + 1 };
      return null;
    case "ArrowLeft": {
      if (n.expanded === true) return { kind: "toggle", index: at };
      for (let j = at - 1; j >= 0; j--) if (nodes[j].level < n.level) return { kind: "focus", index: j };
      return null;
    }
    case "Enter":
    case " ": return { kind: "activate", index: at };
    default: return null;
  }
}

/**
 * A name cut at the filter's match, so the match can be drawn heavier.
 * Case-insensitive; an empty needle or no match returns the name whole.
 */
export function railSplit(name: string, needle: string): [string, string, string] {
  const q = needle.trim().toLowerCase();
  if (!q) return [name, "", ""];
  const i = name.toLowerCase().indexOf(q);
  if (i < 0) return [name, "", ""];
  return [name.slice(0, i), name.slice(i, i + q.length), name.slice(i + q.length)];
}

/** The rail's width: where it starts, what it may be, and where it is kept. */
export const RAIL_W_DEFAULT = 252;
export const RAIL_W_MIN = 208;
export const RAIL_W_MAX = 400;
export const clampRailW = (w: number): number => Math.min(RAIL_W_MAX, Math.max(RAIL_W_MIN, Math.round(w)));
