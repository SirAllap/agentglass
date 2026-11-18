/*
 * What the one picker card decides, kept apart from how it draws.
 *
 * Project, people and branch pickers used to each sort, filter and handle keys
 * their own way. They now share one card (components/PickerCard.tsx); this
 * module is the part with decisions in it, so it can be tested without a DOM:
 * which rows show, in what order, which groups are folded, and what a key does.
 */

/** Six options or fewer: no search box and no shelf. Typeahead still works. */
export const SEARCH_MIN = 7;
/** A card with less room below than this drops its shelf first. */
export const SHELF_MIN_ROOM = 180;
/** Rows drawn at once; the rest says how many more and asks for a search. */
export const ROW_CAP = 200;

export type PickRow = {
  id: string;
  label: string;
  /** Second line, used for matching too (a path, a role). */
  sub?: string;
  /** Group key; rows with none sit loose at the top level. */
  group?: string;
  /** Epoch ms; newest first inside a group. */
  at?: number;
};

export function showSearch(count: number): boolean {
  return count >= SEARCH_MIN;
}

export function showShelf(room: number, shelfCount: number): boolean {
  return shelfCount > 0 && room >= SHELF_MIN_ROOM;
}

export function matches(row: PickRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || row.label.toLowerCase().includes(q) || (row.sub ?? "").toLowerCase().includes(q);
}

/** The current choice first, then newest, then the order given. Stable. */
export function orderRows(rows: PickRow[], opts: { current?: ReadonlySet<string>; query?: string; keep?: boolean; remote?: boolean } = {}): PickRow[] {
  const cur = opts.current;
  // keep: the caller's order stands (people: the card's own first, and ticking
  // must not move a row under the pointer). remote: the source already filtered.
  if (opts.keep || opts.remote) return opts.remote ? rows : rows.filter((r) => matches(r, opts.query ?? ""));
  return rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => matches(r, opts.query ?? ""))
    .sort((a, b) =>
      Number(cur?.has(b.r.id) ?? false) - Number(cur?.has(a.r.id) ?? false)
      || (b.r.at ?? 0) - (a.r.at ?? 0)
      || a.i - b.i)
    .map(({ r }) => r);
}

/** The shelf: up to three most recent rows. Never changes while ticking. */
export function shelfOf(rows: PickRow[], recentIds: readonly string[]): PickRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return recentIds.map((id) => byId.get(id)).filter((r): r is PickRow => !!r).slice(0, 3);
}

export type Group = { key: string; rows: PickRow[]; open: boolean };

/**
 * Groups are folded unless the person opened them, and all open while a query
 * is typed, so a match is never hidden inside a fold.
 */
export function foldGroups(rows: PickRow[], opened: ReadonlySet<string>, query: string, foldable = true): { loose: PickRow[]; groups: Group[] } {
  const searching = query.trim() !== "";
  const loose: PickRow[] = [];
  const by = new Map<string, PickRow[]>();
  for (const r of rows) {
    if (r.group == null) loose.push(r);
    else (by.get(r.group) ?? by.set(r.group, []).get(r.group)!).push(r);
  }
  return {
    loose,
    groups: [...by].map(([key, rs]) => ({ key, rows: rs, open: !foldable || searching || opened.has(key) })),
  };
}

/** One cursor line: a group header or a row, in the order they are drawn. */
export type Stop = { kind: "row"; id: string } | { kind: "group"; key: string; open: boolean };

export function stopsOf(loose: PickRow[], groups: Group[]): Stop[] {
  const out: Stop[] = loose.map((r) => ({ kind: "row", id: r.id }));
  for (const g of groups) {
    out.push({ kind: "group", key: g.key, open: g.open });
    if (g.open) for (const r of g.rows) out.push({ kind: "row", id: r.id });
  }
  return out;
}

export type KeyAction =
  | { do: "move"; to: number }
  | { do: "pick"; id: string }
  | { do: "open" | "fold"; key: string }
  | { do: "close" }
  | { do: "none" };

/**
 * The same keys in every picker: arrows walk rows and group headers as one
 * list, → opens a group, ← folds it, Home/End jump, Enter picks (or toggles a
 * group header), Escape closes. `searching` stops ←/→ from stealing the caret.
 */
export function keyAction(key: string, stops: Stop[], cursor: number, searching: boolean): KeyAction {
  const n = stops.length;
  const at = stops[cursor];
  switch (key) {
    case "ArrowDown": return n ? { do: "move", to: Math.min(n - 1, cursor + 1) } : { do: "none" };
    case "ArrowUp": return n ? { do: "move", to: Math.max(0, cursor - 1) } : { do: "none" };
    case "Home": return searching || !n ? { do: "none" } : { do: "move", to: 0 };
    case "End": return searching || !n ? { do: "none" } : { do: "move", to: n - 1 };
    case "ArrowRight": return at?.kind === "group" && !at.open && !searching ? { do: "open", key: at.key } : { do: "none" };
    case "ArrowLeft": return at?.kind === "group" && at.open && !searching ? { do: "fold", key: at.key } : { do: "none" };
    case "Enter":
      if (!at) return { do: "none" };
      return at.kind === "row" ? { do: "pick", id: at.id } : { do: at.open ? "fold" : "open", key: at.key };
    case "Escape": return { do: "close" };
    default: return { do: "none" };
  }
}

/** A focused button (or role=button) keeps its own Enter: the card must not pick the cursor row instead. */
export const ownsEnter = (key: string, tag: string, role: string | null): boolean =>
  key === "Enter" && (tag === "BUTTON" || role === "button");

/** The "N of M" count the search field shows; "M" alone when nothing is typed. */
export function countLabel(shown: number, total: number, query: string, picked = 0): string {
  if (picked > 0 && !query.trim()) return `${picked} picked`;
  return query.trim() ? `${shown} of ${total}` : String(total);
}

/** What a screen reader reads for one option: all of it in one breath. */
export function optionText(label: string, sub: string | undefined, selected: boolean, note?: string): string {
  return [label, sub, note, selected ? "selected" : "not selected"].filter(Boolean).join(", ");
}
