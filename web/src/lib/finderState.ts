/*
 * Where the finder was, so that closing it is not leaving it.
 *
 * The finder is a workspace now: a query, a result you were on, a file open in
 * the middle, scrolled somewhere, in a drawer of a width you chose. Ctrl+Shift+P
 * hides and shows all of it, and it comes back exactly as it was — including
 * after the app restarts, which is why this is stored and not merely kept in
 * component state.
 *
 * Per tab, because the four tabs are four questions: the Machine tab's folder
 * and selection have nothing to do with the Contents tab's query. The drawer,
 * which is about the window and not the question, is shared.
 *
 * Pure: the component reads and writes localStorage, this only decides what a
 * stored value means, and refuses anything that does not fit — a snapshot from
 * an older or hand-edited store must never put the finder in a state it cannot
 * draw.
 */

export type FinderTab = "names" | "contents" | "recent" | "machine";
export const FINDER_TABS: readonly FinderTab[] = ["names", "contents", "recent", "machine"];

export interface TabView {
  q: string;
  browsePath: string | null;
  /** The selected result, by absolute path — an index would point at a
   *  different row the moment the results were fetched again. */
  sel: string | null;
  /** Extension chips that were on. */
  exts: string[];
}

export interface FinderSnapshot {
  v: 1;
  tab: FinderTab;
  tabs: Partial<Record<FinderTab, TabView>>;
  drawerW: number;
  collapsed: boolean;
  /** How far the open file was scrolled, and which file that was for: a
   *  position in one file means nothing in another. */
  scroll: { path: string; top: number } | null;
}

export const DRAWER_MIN = 220;
export const DRAWER_MAX = 520;
export const DRAWER_DEFAULT = 300;
/** The icon rail the drawer collapses to. */
export const RAIL_W = 46;

export const clampDrawer = (w: number): number =>
  Number.isFinite(w) ? Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, Math.round(w))) : DRAWER_DEFAULT;

export const NO_TAB_VIEW: TabView = { q: "", browsePath: null, sel: null, exts: [] };

export const emptySnapshot = (): FinderSnapshot =>
  ({ v: 1, tab: "names", tabs: {}, drawerW: DRAWER_DEFAULT, collapsed: false, scroll: null });

const str = (x: unknown): x is string => typeof x === "string";

function tabView(raw: unknown): TabView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    q: str(r.q) ? r.q : "",
    browsePath: str(r.browsePath) ? r.browsePath : null,
    sel: str(r.sel) ? r.sel : null,
    exts: Array.isArray(r.exts) ? r.exts.filter(str) : [],
  };
}

/** A stored value back into a snapshot: field by field, the default for
 *  whatever is missing or the wrong type, never a throw. */
export function restore(raw: unknown): FinderSnapshot {
  const base = emptySnapshot();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return base;
  const tabs: Partial<Record<FinderTab, TabView>> = {};
  const rt = (r.tabs && typeof r.tabs === "object" ? r.tabs : {}) as Record<string, unknown>;
  for (const t of FINDER_TABS) { const v = tabView(rt[t]); if (v) tabs[t] = v; }
  const sc = r.scroll as Record<string, unknown> | null | undefined;
  return {
    v: 1,
    tab: FINDER_TABS.includes(r.tab as FinderTab) ? (r.tab as FinderTab) : base.tab,
    tabs,
    drawerW: typeof r.drawerW === "number" ? clampDrawer(r.drawerW) : base.drawerW,
    collapsed: r.collapsed === true,
    scroll: sc && str(sc.path) && typeof sc.top === "number" && sc.top >= 0 ? { path: sc.path, top: Math.round(sc.top) } : null,
  };
}

/** File the current tab's view away. */
export function withTabView(s: FinderSnapshot, tab: FinderTab, view: TabView): FinderSnapshot {
  return { ...s, tab, tabs: { ...s.tabs, [tab]: view } };
}

/** The view a tab opens with: its own, or an empty one. */
export const tabViewOf = (s: FinderSnapshot, tab: FinderTab): TabView => s.tabs[tab] ?? NO_TAB_VIEW;

/** Where to put the scroll back: only for the file it was recorded on. */
export const scrollFor = (s: FinderSnapshot, path: string | null): number =>
  path && s.scroll?.path === path ? s.scroll.top : 0;

/** Which row the saved selection is, once the results have arrived; -1 when
 *  the file is no longer among them (the caller then keeps the first row). */
export const indexOfSel = (paths: (string | null)[], sel: string | null): number =>
  sel ? paths.indexOf(sel) : -1;

/** The path to remember as "where you are". Closing the finder empties its list
 *  (nothing is fetched while it is shut), and an empty list has no selection:
 *  reading that as "nothing selected" wrote null to storage and let the cursor
 *  fall to row 0, so the finder reopened on the first folder with the file's
 *  path still in the box. Only an open finder with a row under the cursor gets
 *  to change what is remembered. */
export const rememberedSel = (prev: string | null, open: boolean, live: string | null): string | null =>
  open && live ? live : prev;

/** The footer's promise, in words: what reopening will put back. Only the
 *  parts that exist — no "“”" for an empty box, no section before a file. */
export function resumeLine(p: { file: string | null; section: string | null; tab: string; q: string }): string {
  const parts = [p.file, p.section ? `§ ${p.section}` : null, p.tab, p.q.trim() ? `“${p.q.trim()}”` : null];
  return `reopens exactly here: ${parts.filter(Boolean).join(" · ")}`;
}
